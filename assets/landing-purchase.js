/**
 * Landing-page purchase kit.
 *
 * Self-contained on purpose: it depends only on Shopify platform APIs so the landing sections can
 * move between themes without rewiring.
 *
 * Cart integration, in order of preference:
 * 1. `window.ViaplushCartDrawer` (sections/viaplush-minimal-archive-sale-header.liquid): items are
 *    added through the AJAX Cart API, then that drawer receives the fresh cart and opens.
 * 2. `Shopify.actions.updateCart` / `openCart` when the storefront provides them.
 * 3. The AJAX Cart API plus `landing:cart-updated` / `viaplush:cart:updated` events.
 *
 * Elements:
 * - <landing-variant-picker>: one slot (product choice + options) → `selectedVariant`.
 * - <landing-purchase>: collects every picker inside it, renders price/savings, and handles
 *   [data-lp-action="add"] / [data-lp-action="checkout"].
 * - <landing-gift-picker>: lets customers choose a bundle's free accessories (exact count).
 * - <landing-cart-link>: keeps the landing header cart count in sync.
 */

const VARIANT_CHANGE = 'landing:variant-change';
const GIFT_CHANGE = 'landing:gift-change';
const CART_UPDATED = 'landing:cart-updated';
const LINES_UPDATE = 'shopify:cart:lines-update';
const IMAGE_WIDTHS = [360, 540, 720, 900, 1200];

/** @returns {string} Storefront root, including any locale prefix. */
function routesRoot() {
  const root = window.Shopify?.routes?.root ?? '/';
  return root.endsWith('/') ? root : `${root}/`;
}

/**
 * Live product data, requested once per handle per page view.
 * @type {Map<string, Promise<any | null>>}
 */
const productRequests = new Map();

/** @param {string} handle */
function fetchLiveProduct(handle) {
  if (!productRequests.has(handle)) {
    const request = fetch(`${routesRoot()}products/${encodeURIComponent(handle)}.js`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null);
    productRequests.set(handle, request);
  }
  return /** @type {Promise<any | null>} */ (productRequests.get(handle));
}

/**
 * Formats cents for display. Whole amounts drop their decimals, matching
 * Liquid's `money_without_trailing_zeros`.
 * @param {number} cents
 * @param {string} currency
 * @param {string} locale
 */
function formatMoney(cents, currency, locale) {
  const amount = cents / 100;
  const whole = Number.isInteger(amount);
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    }).format(amount);
  } catch {
    return amount.toFixed(whole ? 0 : 2);
  }
}

/**
 * Builds a srcset from a Shopify CDN image URL by swapping its width parameter.
 * @param {string} url
 */
function buildSrcset(url) {
  try {
    return IMAGE_WIDTHS.map((width) => {
      const next = new URL(url, window.location.href);
      next.searchParams.set('width', String(width));
      return `${next.toString()} ${width}w`;
    }).join(', ');
  } catch {
    return '';
  }
}

/**
 * @typedef {object} LandingVariant
 * @property {number} id
 * @property {string[]} options
 * @property {boolean} available
 * @property {number} price
 * @property {number} compare
 * @property {string | null} image
 */

class LandingVariantPicker extends HTMLElement {
  /** @type {AbortController | null} */
  #controller = null;

  /** @type {WeakMap<Element, LandingVariant[]>} */
  #variantCache = new WeakMap();

  connectedCallback() {
    this.#controller?.abort();
    this.#controller = new AbortController();
    this.addEventListener('change', this.#onChange, { signal: this.#controller.signal });

    for (const panel of this.panels) this.#sync(panel);
    this.#emit();
    this.#refreshInventory(this.#controller.signal);
  }

  disconnectedCallback() {
    this.#controller?.abort();
    this.#controller = null;
  }

  /** @returns {HTMLElement[]} */
  get panels() {
    return Array.from(this.querySelectorAll('[data-product-panel]'));
  }

  /** @returns {HTMLElement | undefined} */
  get activePanel() {
    return this.panels.find((panel) => !panel.hidden) ?? this.panels[0];
  }

  /** @returns {string} */
  get productTitle() {
    return this.activePanel?.dataset.title ?? '';
  }

  /** @returns {LandingVariant | null} */
  get selectedVariant() {
    const panel = this.activePanel;
    if (!panel) return null;

    const variants = this.#variants(panel);
    const fieldsets = this.#fieldsets(panel);
    if (fieldsets.length === 0) return variants[0] ?? null;

    const selected = fieldsets.map((fieldset) => this.#checkedInput(fieldset)?.value ?? null);
    return variants.find((variant) => variant.options.every((value, index) => value === selected[index])) ?? null;
  }

  /** @param {Event} event */
  #onChange = (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;

    if (input.hasAttribute('data-product-choice')) {
      this.#showPanel(Number(input.value));
      const label = this.querySelector('[data-product-choice-label]');
      if (label) label.textContent = input.dataset.title ?? '';
    } else {
      const panel = input.closest('[data-product-panel]');
      if (panel instanceof HTMLElement) this.#sync(panel);
    }

    this.#emit();
  };

  /** @param {number} index */
  #showPanel(index) {
    this.panels.forEach((panel, panelIndex) => {
      panel.hidden = panelIndex !== index;
    });
    const panel = this.activePanel;
    if (panel) this.#sync(panel);
  }

  /** @param {Element} panel */
  #variants(panel) {
    let variants = this.#variantCache.get(panel);
    if (!variants) {
      try {
        variants = JSON.parse(panel.querySelector('script[data-variants]')?.textContent ?? '[]');
      } catch {
        variants = [];
      }
      this.#variantCache.set(panel, /** @type {LandingVariant[]} */ (variants));
    }
    return /** @type {LandingVariant[]} */ (variants);
  }

  /** @param {Element} panel */
  #fieldsets(panel) {
    return Array.from(panel.querySelectorAll('[data-option-index]'));
  }

  /** @param {Element} fieldset */
  #checkedInput(fieldset) {
    return /** @type {HTMLInputElement | null} */ (fieldset.querySelector('input[type="radio"]:checked'));
  }

  /**
   * Recomputes availability per option, relative to the values selected in earlier options
   * (the same rule Shopify uses for `product_option_value.available`), and moves a selection
   * that became unavailable to the first available value.
   * @param {Element} panel
   */
  #sync(panel) {
    const variants = this.#variants(panel);
    const fieldsets = this.#fieldsets(panel);
    /** @type {(string | null)[]} */
    const selected = fieldsets.map((fieldset) => this.#checkedInput(fieldset)?.value ?? null);

    fieldsets.forEach((fieldset, optionIndex) => {
      const inputs = /** @type {HTMLInputElement[]} */ (Array.from(fieldset.querySelectorAll('input[type="radio"]')));

      for (const input of inputs) {
        input.disabled = !variants.some(
          (variant) =>
            variant.available &&
            variant.options[optionIndex] === input.value &&
            selected.slice(0, optionIndex).every((value, earlier) => variant.options[earlier] === value)
        );
      }

      const current = inputs.find((input) => input.checked);
      if (!current || current.disabled) {
        const firstAvailable = inputs.find((input) => !input.disabled);
        if (firstAvailable) firstAvailable.checked = true;
      }

      selected[optionIndex] = this.#checkedInput(fieldset)?.value ?? null;

      const label = fieldset.querySelector('[data-option-selected]');
      if (label) label.textContent = selected[optionIndex] ?? '';
    });
  }

  #emit() {
    const variant = this.selectedVariant;
    const image = this.querySelector('[data-picker-image]');
    if (image instanceof HTMLImageElement && variant?.image && image.dataset.lpSrc !== variant.image) {
      if (image.dataset.lpSrc !== undefined || !image.currentSrc.includes(variant.image.split('?')[0])) {
        image.srcset = buildSrcset(variant.image);
        image.src = variant.image;
        image.alt = this.productTitle;
      }
      image.dataset.lpSrc = variant.image;
    }

    this.dispatchEvent(new CustomEvent(VARIANT_CHANGE, { bubbles: true, detail: { variant } }));
  }

  /**
   * Replaces rendered availability and prices with live values, so cached page HTML
   * never sells a variant that has just sold out.
   * @param {AbortSignal} signal
   */
  async #refreshInventory(signal) {
    const panels = this.panels;
    const results = await Promise.all(panels.map((panel) => fetchLiveProduct(panel.dataset.handle ?? '')));
    if (signal.aborted) return;

    panels.forEach((panel, index) => {
      const live = results[index];
      if (!live?.variants) return;

      for (const variant of this.#variants(panel)) {
        const match = live.variants.find((/** @type {any} */ liveVariant) => liveVariant.id === variant.id);
        if (!match) {
          variant.available = false;
          continue;
        }
        variant.available = Boolean(match.available);
        variant.price = match.price;
        variant.compare = match.compare_at_price ?? 0;
      }

      const choice = this.querySelector(`[data-product-choice][value="${index}"]`);
      if (choice instanceof HTMLInputElement) choice.disabled = !live.available;

      this.#sync(panel);
    });

    this.#emit();
  }
}

class LandingPurchase extends HTMLElement {
  /** @type {AbortController | null} */
  #controller = null;

  #busy = false;

  /** @type {HTMLButtonElement | null} */
  #busyButton = null;

  connectedCallback() {
    this.#controller?.abort();
    this.#controller = new AbortController();
    const { signal } = this.#controller;

    this.addEventListener(VARIANT_CHANGE, this.#render, { signal });
    this.addEventListener(GIFT_CHANGE, this.#onGiftChange, { signal });
    this.addEventListener('click', this.#onClick, { signal });
    window.addEventListener('pageshow', this.#onPageShow, { signal });
    this.#render();
  }

  /**
   * Checkout keeps its button busy until navigation; a back/forward cache restore
   * must hand the buttons back to the customer.
   * @param {PageTransitionEvent} event
   */
  #onPageShow = (event) => {
    if (event.persisted && this.#busyButton) this.#setBusy(false, this.#busyButton);
  };

  disconnectedCallback() {
    this.#controller?.abort();
    this.#controller = null;
  }

  /** Clears a stale "choose your accessories" message once the selection is complete. */
  #onGiftChange = () => {
    if (this.giftPicker?.isComplete && this.querySelector('.lp-status--error')) this.#setStatus('');
  };

  /** @returns {LandingGiftPicker | null} */
  get giftPicker() {
    const picker = this.querySelector('landing-gift-picker');
    return picker instanceof LandingGiftPicker ? picker : null;
  }

  /** @returns {LandingVariantPicker[]} */
  get pickers() {
    return /** @type {LandingVariantPicker[]} */ (Array.from(this.querySelectorAll('landing-variant-picker')));
  }

  get currency() {
    return this.dataset.currency || window.Shopify?.currency?.active || 'USD';
  }

  get locale() {
    return this.dataset.locale || document.documentElement.lang || 'en';
  }

  /** @param {string} selector */
  #part(selector) {
    return /** @type {HTMLElement | null} */ (this.querySelector(selector));
  }

  /** @param {number} cents */
  #money(cents) {
    return formatMoney(cents, this.currency, this.locale);
  }

  #render = () => {
    const pickers = this.pickers;
    // Pickers upgrade after this element; they emit a change once ready.
    if (pickers.length === 0 || pickers.some((picker) => !(picker instanceof LandingVariantPicker))) return;

    const variants = pickers.map((picker) => picker.selectedVariant);
    const allAvailable = variants.every((variant) => variant?.available);

    if (this.dataset.kind === 'bundle') {
      this.#renderBundlePrice(variants);
    } else {
      this.#renderSinglePrice(variants[0] ?? null);
    }

    for (const button of this.querySelectorAll('[data-lp-action]')) {
      if (!(button instanceof HTMLButtonElement)) continue;
      button.disabled = this.#busy || !allAvailable;
    }

    const addLabel = this.#part('[data-lp-add-label]');
    if (addLabel && !this.#busy) {
      addLabel.textContent = allAvailable ? this.dataset.labelAdd ?? '' : this.dataset.labelSoldOut ?? '';
    }
  };

  /** @param {(LandingVariant | null)[]} variants */
  #renderBundlePrice(variants) {
    const price = Number(this.dataset.bundlePrice || 0);
    const override = Number(this.dataset.compareOverride || 0);
    const computed = variants.reduce(
      (sum, variant) => sum + (variant ? Math.max(variant.price, variant.compare || 0) : 0),
      0
    );
    const compare = override > 0 ? override : computed;
    const savings = compare - price;
    const showSavings = this.dataset.showSavings === 'true' && savings > 0 && compare > 0;

    const compareEl = this.#part('[data-lp-compare]');
    const saveEl = this.#part('[data-lp-save]');
    const youSaveEl = this.#part('[data-lp-you-save]');

    if (compareEl) {
      compareEl.hidden = !showSavings;
      const amount = compareEl.querySelector('[data-lp-amount]');
      if (amount) amount.textContent = this.#money(compare);
    }

    if (saveEl) {
      saveEl.hidden = !showSavings;
      const percent = Math.round((savings / compare) * 100);
      saveEl.textContent = (this.dataset.saveTemplate ?? '').replace('__PERCENT__', String(percent));
    }

    if (youSaveEl) {
      youSaveEl.hidden = !showSavings;
      youSaveEl.textContent = (this.dataset.youSaveTemplate ?? '').replace('__AMOUNT__', this.#money(savings));
    }
  }

  /** @param {LandingVariant | null} variant */
  #renderSinglePrice(variant) {
    if (!variant) return;

    const currentEl = this.#part('[data-lp-current]');
    const compareEl = this.#part('[data-lp-compare]');
    const currentAmount = currentEl?.querySelector('[data-lp-amount]');
    if (currentAmount) currentAmount.textContent = this.#money(variant.price);

    if (compareEl) {
      const onSale = variant.compare > variant.price;
      compareEl.hidden = !onSale;
      const amount = compareEl.querySelector('[data-lp-amount]');
      if (amount && onSale) amount.textContent = this.#money(variant.compare);
    }

    const image = this.#part('[data-lp-image]');
    if (image instanceof HTMLImageElement && variant.image && image.dataset.lpSrc !== variant.image) {
      if (image.dataset.lpSrc !== undefined || !image.currentSrc.includes(variant.image.split('?')[0])) {
        image.srcset = buildSrcset(variant.image);
        image.src = variant.image;
      }
      image.dataset.lpSrc = variant.image;
    }
  }

  /** @param {MouseEvent} event */
  #onClick = (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-lp-action]') : null;
    if (!(target instanceof HTMLButtonElement) || !this.contains(target)) return;

    const action = target.dataset.lpAction;
    if (action === 'add' || action === 'checkout') this.#submit(action, target);
  };

  /**
   * @param {'add' | 'checkout'} action
   * @param {HTMLButtonElement} button
   */
  async #submit(action, button) {
    if (this.#busy) return;

    const lines = this.#buildLines();
    if (!lines) {
      this.#setStatus(this.dataset.msgUnavailable ?? '', true);
      return;
    }

    const gifts = this.giftPicker;
    if (gifts && !gifts.isComplete) {
      this.#setStatus(gifts.dataset.incompleteMessage ?? '', true);
      gifts.focusFirstStep();
      return;
    }

    this.#setBusy(true, button);
    this.#setStatus('');

    const code = (this.dataset.discountCode ?? '').trim();

    try {
      const cart = await addLinesToCart(lines);

      if (action === 'checkout') {
        const checkout = `${routesRoot()}checkout`;
        window.location.assign(
          code ? `${routesRoot()}discount/${encodeURIComponent(code)}?redirect=${encodeURIComponent(checkout)}` : checkout
        );
        return;
      }

      if (code) await applyDiscountCode(code);

      this.#setStatus(this.dataset.msgAdded ?? '', false, true);
      await openCart(code ? null : cart);
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : this.dataset.msgError ?? '';
      this.#setStatus(message, true);
    } finally {
      // Checkout navigation keeps the button busy until the page unloads.
      if (action !== 'checkout' || this.querySelector('.lp-status--error')) this.#setBusy(false, button);
    }
  }

  /**
   * One cart line per selected variant. Bundle lines share a `_bundle_id` so a bundle app or
   * discount function can price them together, and repeat variants are merged.
   * @returns {CartLine[] | null}
   */
  #buildLines() {
    const variants = this.pickers.map((picker) => picker.selectedVariant);
    if (variants.length === 0 || variants.some((variant) => !variant?.available)) return null;

    const isBundle = this.dataset.kind === 'bundle';
    const bundleId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const title = this.dataset.bundleTitle ?? '';
    const giftPicker = this.giftPicker;
    const legacyGiftVariant = Number(this.dataset.giftVariant || 0);
    const legacyGiftQuantity = Number(this.dataset.giftQuantity || 0);
    const giftAllowance = giftPicker ? giftPicker.count : legacyGiftVariant ? legacyGiftQuantity : 0;

    // `_bundle_size` and `_bundle_gifts` let assets/bundle-gift-guard.js drop the free accessories
    // when the set is broken up in the cart, and cap them at what the bundle includes.
    const bundleMeta = [
      { key: '_bundle_id', value: bundleId },
      { key: '_bundle_size', value: String(variants.length) },
      { key: '_bundle_gifts', value: String(giftAllowance) },
    ];

    /** @type {Array<{key: string, value: string}>} */
    const attributes = isBundle
      ? [
          { key: this.dataset.propertyBundle || 'Bundle', value: title },
          ...bundleMeta,
          { key: '_bundle_key', value: this.dataset.bundleKey ?? '' },
        ]
      : [];

    /** @type {CartLine[]} */
    const lines = [];
    for (const variant of variants) {
      if (!variant) continue;
      const existing = lines.find((line) => line.id === variant.id);
      if (existing) {
        existing.quantity += 1;
      } else {
        lines.push({ id: variant.id, quantity: 1, attributes });
      }
    }

    const giftAttributes = [
      { key: this.dataset.propertyGift || 'Free gift with', value: title },
      ...bundleMeta,
      { key: '_bundle_gift', value: 'true' },
    ];

    if (isBundle && giftPicker) {
      for (const gift of giftPicker.selections) {
        lines.push({ id: gift.id, quantity: gift.quantity, attributes: giftAttributes });
      }
      return lines;
    }

    if (isBundle && legacyGiftVariant && legacyGiftQuantity > 0) {
      lines.push({ id: legacyGiftVariant, quantity: legacyGiftQuantity, attributes: giftAttributes });
    }

    return lines;
  }

  /**
   * @param {boolean} busy
   * @param {HTMLButtonElement} button
   */
  #setBusy(busy, button) {
    this.#busy = busy;
    this.#busyButton = busy ? button : null;
    button.setAttribute('aria-busy', String(busy));

    const label = button.querySelector('[data-lp-button-label]');
    if (label) {
      if (busy) {
        button.dataset.lpLabel = label.textContent ?? '';
        label.textContent = this.dataset.labelAdding ?? '';
      } else if (button.dataset.lpLabel !== undefined) {
        label.textContent = button.dataset.lpLabel;
        delete button.dataset.lpLabel;
      }
    }

    if (!busy) this.#render();
    else for (const other of this.querySelectorAll('[data-lp-action]')) /** @type {HTMLButtonElement} */ (other).disabled = true;
  }

  /**
   * @param {string} message
   * @param {boolean} [isError]
   * @param {boolean} [withCartLink]
   */
  #setStatus(message, isError = false, withCartLink = false) {
    const status = this.#part('[data-lp-status]');
    if (!status) return;

    status.classList.toggle('lp-status--error', isError);
    status.textContent = message;

    if (withCartLink && message) {
      const link = document.createElement('a');
      link.href = `${routesRoot()}cart`;
      link.textContent = this.dataset.labelViewCart ?? '';
      status.append(' ', link);
    }
  }
}

/**
 * @typedef {object} CartLine
 * @property {number} id - Variant ID.
 * @property {number} quantity
 * @property {Array<{key: string, value: string}>} attributes - Line item properties.
 */

/** @returns {{open: (cart?: any) => void, updateCount?: (cart: any) => void} | null} */
function landingDrawer() {
  const drawer = /** @type {any} */ (window).ViaplushCartDrawer;
  return drawer && typeof drawer.open === 'function' ? drawer : null;
}

/**
 * Adds lines and resolves with the updated AJAX cart when one was fetched.
 * @param {CartLine[]} lines
 * @returns {Promise<any | null>}
 */
async function addLinesToCart(lines) {
  const actions = window.Shopify?.actions;

  if (actions?.updateCart && !landingDrawer()) {
    const result = await actions.updateCart(
      {
        lines: lines.map((line) => ({
          merchandiseId: `gid://shopify/ProductVariant/${line.id}`,
          quantity: line.quantity,
          attributes: line.attributes,
        })),
      },
      { event: { context: 'product' } }
    );

    const userError = result?.userErrors?.[0];
    if (userError) throw new Error(userError.message);
    return null;
  }

  const response = await fetch(`${routesRoot()}cart/add.js`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      items: lines.map((line) => ({
        id: line.id,
        quantity: line.quantity,
        properties: Object.fromEntries(line.attributes.map(({ key, value }) => [key, value])),
      })),
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.description || data.message || '');

  return announceCartCount();
}

/** @param {string} code */
async function applyDiscountCode(code) {
  const actions = window.Shopify?.actions;
  try {
    if (actions?.updateCart && !landingDrawer()) {
      await actions.updateCart({ discountCodes: [code] }, { event: { context: 'product' } });
      return;
    }
    await fetch(`${routesRoot()}cart/update.js`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ discount: code }),
    });
  } catch {
    // The items are already in the cart; the code can still be entered at checkout.
  }
}

/** @param {any} [cart] - Fresh AJAX cart; the drawer fetches its own when omitted. */
async function openCart(cart) {
  try {
    const drawer = landingDrawer();
    if (drawer) {
      drawer.open(cart || null);
      return;
    }
    await window.Shopify?.actions?.openCart?.();
  } catch {
    // The inline status message already links to the cart.
  }
}

/**
 * Fetches the cart and broadcasts it to header counters that listen for landing events.
 * @returns {Promise<any | null>}
 */
async function announceCartCount() {
  try {
    const response = await fetch(`${routesRoot()}cart.js`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const cart = await response.json();
    document.dispatchEvent(new CustomEvent(CART_UPDATED, { detail: { itemCount: cart.item_count } }));
    document.documentElement.dispatchEvent(
      new CustomEvent('viaplush:cart:updated', { bubbles: true, detail: { cart, source: 'landing-purchase' } })
    );
    return cart;
  } catch {
    // Count refreshes on the next page view.
    return null;
  }
}

class LandingGiftPicker extends HTMLElement {
  /** @type {AbortController | null} */
  #controller = null;

  connectedCallback() {
    this.#controller?.abort();
    this.#controller = new AbortController();
    this.addEventListener('click', this.#onClick, { signal: this.#controller.signal });
    this.#prefill();
    this.#render();
  }

  disconnectedCallback() {
    this.#controller?.abort();
    this.#controller = null;
  }

  get count() {
    return Number(this.dataset.count || 0);
  }

  /** @returns {HTMLElement[]} */
  get items() {
    return Array.from(this.querySelectorAll('[data-gift-item]'));
  }

  /** @param {HTMLElement} item */
  #qty(item) {
    return Number(item.dataset.qty || 0);
  }

  get total() {
    return this.items.reduce((sum, item) => sum + this.#qty(item), 0);
  }

  get isComplete() {
    return this.items.length === 0 || this.total === this.count;
  }

  /** @returns {Array<{id: number, quantity: number}>} Chosen variants, merged by ID. */
  get selections() {
    /** @type {Map<number, number>} */
    const byVariant = new Map();
    for (const item of this.items) {
      const qty = this.#qty(item);
      const field = item.querySelector('[data-gift-variant]');
      const id = Number(field instanceof HTMLInputElement || field instanceof HTMLSelectElement ? field.value : 0);
      if (qty > 0 && id) byVariant.set(id, (byVariant.get(id) ?? 0) + qty);
    }
    return Array.from(byVariant, ([id, quantity]) => ({ id, quantity }));
  }

  focusFirstStep() {
    const step = this.querySelector('[data-gift-step="1"]:not(:disabled)');
    if (step instanceof HTMLElement) step.focus();
  }

  /** Spreads the free items evenly across the offered accessories. */
  #prefill() {
    const items = this.items;
    if (items.length === 0 || this.total > 0) return;
    for (let i = 0; i < this.count; i++) {
      const item = items[i % items.length];
      item.dataset.qty = String(this.#qty(item) + 1);
    }
  }

  /** @param {MouseEvent} event */
  #onClick = (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-gift-step]') : null;
    if (!(button instanceof HTMLButtonElement) || !this.contains(button)) return;

    const item = button.closest('[data-gift-item]');
    if (!(item instanceof HTMLElement)) return;

    const step = Number(button.dataset.giftStep);
    const next = this.#qty(item) + step;
    if (next < 0 || (step > 0 && this.total >= this.count)) return;

    item.dataset.qty = String(next);
    this.#render();
    this.dispatchEvent(new CustomEvent(GIFT_CHANGE, { bubbles: true }));
  };

  #render() {
    const total = this.total;
    for (const item of this.items) {
      const qty = this.#qty(item);
      const output = item.querySelector('[data-gift-qty]');
      if (output) output.textContent = String(qty);
      item.classList.toggle('lp-gift--chosen', qty > 0);

      const minus = item.querySelector('[data-gift-step="-1"]');
      const plus = item.querySelector('[data-gift-step="1"]');
      if (minus instanceof HTMLButtonElement) minus.disabled = qty === 0;
      if (plus instanceof HTMLButtonElement) plus.disabled = total >= this.count;
    }

    const progress = this.querySelector('[data-gift-progress]');
    if (progress) {
      progress.textContent = (this.dataset.progressTemplate ?? '').replace('__CHOSEN__', String(total));
      progress.classList.toggle('lp-gifts__progress--complete', total === this.count);
    }
  }
}

class LandingCartLink extends HTMLElement {
  /** @type {AbortController | null} */
  #controller = null;

  connectedCallback() {
    this.#controller?.abort();
    this.#controller = new AbortController();
    const { signal } = this.#controller;

    document.addEventListener(LINES_UPDATE, this.#onLinesUpdate, { signal });
    document.addEventListener(CART_UPDATED, this.#onLocalUpdate, { signal });
    window.addEventListener('pageshow', this.#onPageShow, { signal });
    this.querySelector('a')?.addEventListener('click', this.#onClick, { signal });
  }

  disconnectedCallback() {
    this.#controller?.abort();
    this.#controller = null;
  }

  /** @param {Event & {promise?: Promise<any>}} event */
  #onLinesUpdate = (event) => {
    event.promise
      ?.then(({ cart, detail } = {}) => {
        const count = cart?.totalQuantity ?? detail?.itemCount;
        if (Number.isInteger(count)) this.render(count);
      })
      .catch(() => {});
  };

  /** @param {Event} event */
  #onLocalUpdate = (event) => {
    const count = /** @type {CustomEvent} */ (event).detail?.itemCount;
    if (Number.isInteger(count)) this.render(count);
  };

  /** @param {PageTransitionEvent} event */
  #onPageShow = async (event) => {
    if (!event.persisted) return;
    try {
      const response = await fetch(`${routesRoot()}cart.js`, { credentials: 'same-origin', cache: 'no-store' });
      if (response.ok) this.render((await response.json()).item_count);
    } catch {
      // Keep the rendered count.
    }
  };

  /** @param {MouseEvent} event */
  #onClick = async (event) => {
    const actions = window.Shopify?.actions;
    if (!actions?.openCart || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    try {
      await actions.openCart();
    } catch {
      window.location.assign(`${routesRoot()}cart`);
    }
  };

  /** @param {number} count */
  render(count) {
    const bubble = this.querySelector('[data-cart-count]');
    if (bubble) {
      bubble.textContent = count > 99 ? '99+' : String(count);
      bubble.toggleAttribute('hidden', count === 0);
    }

    const label = this.querySelector('[data-cart-count-label]');
    if (label) label.textContent = (this.dataset.countTemplate ?? '').replace('__COUNT__', String(count));
  }
}

if (!customElements.get('landing-variant-picker')) customElements.define('landing-variant-picker', LandingVariantPicker);
if (!customElements.get('landing-purchase')) customElements.define('landing-purchase', LandingPurchase);
if (!customElements.get('landing-gift-picker')) customElements.define('landing-gift-picker', LandingGiftPicker);
if (!customElements.get('landing-cart-link')) customElements.define('landing-cart-link', LandingCartLink);

/**
 * Keeps free bundle accessories tied to their bundle, on every page and cart UI.
 *
 * Bundle lines added by assets/landing-purchase.js share a `_bundle_id`. Garment lines carry
 * `_bundle_size` (pieces in the set) and every line carries `_bundle_gifts` (free items allowed).
 * After any cart change this script:
 *   - removes a bundle's free accessories once its garments drop below the full set,
 *   - trims free accessories above the bundle's allowance,
 *   - removes $0 lines that don't belong to a bundle (promotion-only items added directly).
 * Then it refreshes the theme cart sections and the Viaplush cart drawer.
 */
(() => {
  if (window.__bundleGiftGuard) return;
  window.__bundleGiftGuard = true;

  const SOURCE = 'bundle-gift-guard';
  const root = window.Shopify?.routes?.root || '/';
  const CART_MUTATION = /\/cart\/(add|change|update|clear)(\.js)?(\?|$)/;
  const nativeFetch = window.fetch.bind(window);

  let timer = 0;
  let running = false;
  let pending = false;

  /** @param {any} item */
  const props = (item) => item.properties || {};

  /**
   * @param {any} cart
   * @returns {Record<string, number>} line key -> new quantity
   */
  function planUpdates(cart) {
    /** @type {Map<string, {garments: number, size: number, allowance: number, gifts: any[]}>} */
    const bundles = new Map();
    /** @type {Record<string, number>} */
    const updates = {};

    for (const item of cart.items || []) {
      const p = props(item);
      const id = p._bundle_id;

      if (!id) {
        if (item.original_price === 0 && !item.gift_card) updates[item.key] = 0;
        continue;
      }

      const bundle = bundles.get(id) || { garments: 0, size: 0, allowance: -1, gifts: [] };
      const size = parseInt(p._bundle_size, 10);
      const allowance = parseInt(p._bundle_gifts, 10);
      if (size > bundle.size) bundle.size = size;
      if (allowance >= 0) bundle.allowance = Math.max(bundle.allowance, allowance);

      if (p._bundle_gift) bundle.gifts.push(item);
      else bundle.garments += item.quantity;
      bundles.set(id, bundle);
    }

    for (const bundle of bundles.values()) {
      if (bundle.gifts.length === 0) continue;

      const broken = bundle.size > 0 ? bundle.garments < bundle.size : bundle.garments === 0;
      let remaining = broken ? 0 : bundle.allowance >= 0 ? bundle.allowance : Infinity;

      for (const gift of bundle.gifts) {
        const keep = Math.min(gift.quantity, remaining);
        remaining -= keep;
        if (keep !== gift.quantity) updates[gift.key] = keep;
      }
    }

    return updates;
  }

  async function getCart() {
    const response = await nativeFetch(`${root}cart.js`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`cart ${response.status}`);
    return response.json();
  }

  /** @param {Record<string, number>} updates */
  async function applyUpdates(updates) {
    const response = await nativeFetch(`${root}cart/update.js`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ updates }),
    });
    if (!response.ok) throw new Error(`update ${response.status}`);
    return response.json();
  }

  /** @param {any} cart */
  function announce(cart) {
    const target = document.documentElement;

    // Theme cart page, cart drawer and cart icon (detail shape of @theme/events CartUpdateEvent).
    // Without `sections`, cart-items components re-render their own section.
    const themeEvent = new Event('cart:update', { bubbles: true });
    Object.assign(themeEvent, {
      detail: {
        resource: cart,
        sourceId: SOURCE,
        data: { source: SOURCE, itemCount: cart.item_count },
      },
    });
    target.dispatchEvent(themeEvent);

    // Viaplush minimal header drawer.
    target.dispatchEvent(new CustomEvent('viaplush:cart:updated', { bubbles: true, detail: { cart, source: SOURCE } }));
  }

  async function sync() {
    if (running) {
      pending = true;
      return;
    }
    running = true;

    try {
      const updates = planUpdates(await getCart());
      if (Object.keys(updates).length === 0) return;

      const result = await applyUpdates(updates);
      announce(result.items ? result : await getCart());
    } catch {
      // A failed check runs again on the next cart change or page view.
    } finally {
      running = false;
      if (pending) {
        pending = false;
        schedule();
      }
    }
  }

  function schedule() {
    window.clearTimeout(timer);
    timer = window.setTimeout(sync, 60);
  }

  // Any storefront code that changes the cart through fetch triggers a check.
  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    try {
      const input = args[0];
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url || '';
      if (CART_MUTATION.test(url)) schedule();
    } catch {
      // Never interfere with the original request.
    }
    return response;
  };

  /** @param {Event} event */
  const onCartEvent = (event) => {
    const detail = /** @type {any} */ (event).detail || {};
    if (detail.source === SOURCE || detail.data?.source === SOURCE || detail.sourceId === SOURCE) return;
    schedule();
  };
  document.addEventListener('cart:update', onCartEvent);
  document.addEventListener('viaplush:cart:updated', onCartEvent);

  // Pages rendered with bundle or $0 lines already in the cart (cart page, return visits).
  const self = document.currentScript;
  if (self instanceof HTMLScriptElement && self.dataset.checkOnLoad === 'true') schedule();
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) schedule();
  });
})();

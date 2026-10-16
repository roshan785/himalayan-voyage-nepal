'use strict';

/**
 * Travel Shop cart — a small, dependency-free cart store shared by shop.html,
 * cart.html and the header cart badge.
 *
 * Persistence is localStorage (the cart is a convenience, never the source of
 * truth: prices and totals are ALWAYS recomputed by the server on checkout).
 * Every read is defensive — a corrupted or hand-edited entry can never throw and
 * break a page render.
 *
 * Exposed as `window.Cart`.
 */

(function () {
  if (typeof window === 'undefined') return;

  const KEY = 'hv_cart_v1';
  const MAX_LINES = 20;
  const MAX_QTY = 50;

  /** Read + sanitise the cart. Always returns a clean array. */
  function read() {
    try {
      const raw = window.localStorage.getItem(KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((l) => l && typeof l.slug === 'string' && l.slug)
        .map((l) => ({
          slug: String(l.slug).slice(0, 160),
          title: String(l.title || '').slice(0, 200),
          price: Math.max(0, Number(l.price) || 0),
          discount: Math.min(90, Math.max(0, Number(l.discount) || 0)),
          image: String(l.image || '').slice(0, 500),
          qty: Math.max(1, Math.min(MAX_QTY, Math.round(Number(l.qty) || 1)))
        }))
        .slice(0, MAX_LINES);
    } catch (_e) {
      return [];
    }
  }

  function write(lines) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(lines.slice(0, MAX_LINES)));
    } catch (_e) { /* private mode / quota — the cart simply will not persist */ }
    emit();
  }

  function emit() {
    try {
      window.dispatchEvent(new CustomEvent('cart:change', { detail: { count: count() } }));
    } catch (_e) { /* older browser — badge just will not live-update */ }
  }

  /** Add a package (or bump its quantity). Returns the updated line count. */
  function add(item, qty = 1) {
    if (!item || !item.slug) return count();
    const lines = read();
    const existing = lines.find((l) => l.slug === item.slug);
    if (existing) {
      existing.qty = Math.min(MAX_QTY, existing.qty + Math.max(1, Math.round(Number(qty) || 1)));
    } else {
      lines.push({
        slug: String(item.slug),
        title: String(item.title || ''),
        price: Math.max(0, Number(item.price) || 0),
        discount: Math.min(90, Math.max(0, Number(item.discount) || 0)),
        image: String(item.image || ''),
        qty: Math.max(1, Math.min(MAX_QTY, Math.round(Number(qty) || 1)))
      });
    }
    write(lines);
    return count();
  }

  /** Set an exact quantity (0 removes the line). */
  function setQty(slug, qty) {
    const lines = read();
    const n = Math.round(Number(qty) || 0);
    const next = lines
      .map((l) => (l.slug === slug ? Object.assign({}, l, { qty: Math.min(MAX_QTY, Math.max(0, n)) }) : l))
      .filter((l) => l.qty > 0);
    write(next);
    return next;
  }

  function remove(slug) {
    write(read().filter((l) => l.slug !== slug));
  }

  function clear() {
    write([]);
  }

  /** Total number of travellers/units in the cart. */
  function count() {
    return read().reduce((n, l) => n + (Number(l.qty) || 0), 0);
  }

  /** Number of distinct packages. */
  function lineCount() {
    return read().length;
  }

  /**
   * Client-side ESTIMATE only, for the badge/toolbar. The real total is computed
   * by the server from the packages table on checkout.
   */
  function estimateTotal() {
    return read().reduce((sum, l) => {
      const unit = Math.round((Number(l.price) || 0) * (1 - (Number(l.discount) || 0) / 100));
      return sum + unit * (Number(l.qty) || 1);
    }, 0);
  }

  /** Payload shape POSTed to /api/orders — slug + qty only, never a price. */
  function toOrderItems() {
    return read().map((l) => ({ slug: l.slug, qty: l.qty }));
  }

  /** Paint the cart badge in the header, if present. */
  function paintBadge() {
    const n = count();
    document.querySelectorAll('[data-cart-count]').forEach((el) => {
      el.textContent = String(n);
      el.hidden = n === 0;
      el.classList.toggle('is-empty', n === 0);
    });
  }

  window.addEventListener('cart:change', paintBadge);
  document.addEventListener('DOMContentLoaded', paintBadge);

  window.Cart = {
    read, add, setQty, remove, clear,
    count, lineCount, estimateTotal, toOrderItems, paintBadge
  };
})();

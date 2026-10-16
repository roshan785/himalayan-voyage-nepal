'use strict';

/**
 * Cart + checkout page.
 *
 * Flow:
 *   1. Render cart lines from localStorage (qty +/- , remove).
 *   2. On "Place order", POST /api/orders with slug+qty ONLY (never a price).
 *   3. The server creates the order with its own totals and returns a reference.
 *   4. Start the chosen payment via /api/orders/:ref/pay, redirect / verify.
 *
 * The order reference is kept in sessionStorage so order.html can pick it up
 * after a gateway redirect.
 */

(function () {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const App = window.App;
  const Cart = window.Cart;

  let providers = [];

  function renderLines() {
    const box = document.getElementById('cart-lines');
    const lines = Cart ? Cart.read() : [];
    if (!lines.length) return;
    box.innerHTML = lines.map((l) => {
      const unit = App.discountPrice(l.price, l.discount);
      const cov = App.coverInner(l, { resolvable: false, eager: false });
      return `
        <div class="cart-line">
          <div class="cart-line__cover cover ${cov.cls}">${cov.html}</div>
          <div class="cart-line__body">
            <h4>${App.escapeHtml(l.title || l.slug)}</h4>
            <p class="small muted">${App.money(unit)} per traveller</p>
            <div class="cart-line__qty">
              <button type="button" class="qty-btn" data-dec="${App.escapeHtml(l.slug)}" aria-label="Decrease">&minus;</button>
              <span aria-live="polite">${l.qty}</span>
              <button type="button" class="qty-btn" data-inc="${App.escapeHtml(l.slug)}" aria-label="Increase">+</button>
              <button type="button" class="link-btn" data-rm="${App.escapeHtml(l.slug)}">Remove</button>
            </div>
          </div>
          <div class="cart-line__total">${App.money(unit * l.qty)}</div>
        </div>`;
    }).join('');
  }

  function renderSummary() {
    const lines = Cart ? Cart.read() : [];
    const box = document.getElementById('cart-summary');
    const subtotal = lines.reduce((s, l) => s + (Number(l.price) || 0) * l.qty, 0);
    const total = Cart ? Cart.estimateTotal() : 0;
    const savings = subtotal - total;
    box.innerHTML = `
      <div class="summary-row"><span>Items</span><span>${lines.reduce((n, l) => n + l.qty, 0)}</span></div>
      <div class="summary-row"><span>Subtotal</span><span>${App.money(subtotal)}</span></div>
      ${savings > 0 ? `<div class="summary-row summary-row--save"><span>Discount</span><span>&minus; ${App.money(savings)}</span></div>` : ''}
      <div class="summary-row summary-row--total"><span>Total</span><span>${App.money(total)}</span></div>`;
  }

  function renderMethods() {
    const box = document.getElementById('pay-methods');
    const note = document.getElementById('pay-note');
    const usable = providers.filter((p) => p.configured);
    const selected = (usable[0] || {}).id || 'mock';
    box.innerHTML = usable.map((p) => `
      <label class="pay-method">
        <input type="radio" name="pay_method" value="${App.escapeHtml(p.id)}" ${p.id === selected ? 'checked' : ''}>
        <span class="pay-method__label">${App.escapeHtml(p.label)}</span>
        ${p.live ? '' : '<span class="badge badge--soft">test</span>'}
      </label>`).join('') || '<p class="small muted">No payment methods are configured.</p>';
    const first = usable.find((p) => p.id === selected);
    if (note && first) note.textContent = first.note || '';
    box.querySelectorAll('input[name="pay_method"]').forEach((r) => {
      r.addEventListener('change', () => {
        const p = usable.find((x) => x.id === r.value);
        if (note && p) note.textContent = p.note || '';
      });
    });
  }

  function refresh() {
    const lines = Cart ? Cart.read() : [];
    document.getElementById('cart-empty').classList.toggle('hidden', lines.length > 0);
    document.getElementById('cart-layout').classList.toggle('hidden', lines.length === 0);
    renderLines();
    renderSummary();
    if (Cart) Cart.paintBadge();
  }

  function wireLines() {
    const box = document.getElementById('cart-lines');
    box.addEventListener('click', (e) => {
      const inc = e.target.closest('[data-inc]');
      const dec = e.target.closest('[data-dec]');
      const rm = e.target.closest('[data-rm]');
      if (inc) {
        const l = Cart.read().find((x) => x.slug === inc.dataset.inc);
        if (l) Cart.setQty(l.slug, l.qty + 1);
      } else if (dec) {
        const l = Cart.read().find((x) => x.slug === dec.dataset.dec);
        if (l) Cart.setQty(l.slug, l.qty - 1);
      } else if (rm) {
        Cart.remove(rm.dataset.rm);
      } else return;
      refresh();
    });
  }

  function validate() {
    const form = document.getElementById('checkout-form');
    const fv = (n) => String((form.elements[n] || {}).value || '').trim();
    let ok = true;
    const setErr = (n, msg) => {
      const el = document.querySelector(`[data-err="${n}"]`);
      if (el) el.textContent = msg || '';
      if (msg) ok = false;
    };
    if (fv('name').length < 2) setErr('name', 'Please enter your full name.'); else setErr('name', '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(fv('email'))) setErr('email', 'Enter a valid email address.'); else setErr('email', '');
    const d = fv('travel_date');
    if (d) {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      if (new Date(d + 'T00:00:00') < today) setErr('travel_date', 'Pick today or a future date.'); else setErr('travel_date', '');
    } else setErr('travel_date', '');
    return ok;
  }

  async function placeOrder() {
    const note = document.getElementById('checkout-note');
    const btn = document.getElementById('checkout-btn');
    const form = document.getElementById('checkout-form');
    if (!validate()) {
      note.className = 'form-note is-err';
      note.textContent = 'Please fix the highlighted fields.';
      return;
    }
    const items = Cart.toOrderItems();
    if (!items.length) { App.toast('Your cart is empty', 'err'); return; }

    const fd = new FormData(form);
    const method = (document.querySelector('input[name="pay_method"]:checked') || {}).value || 'mock';

    btn.disabled = true;
    note.className = 'form-note';
    note.textContent = 'Placing your order\u2026';
    try {
      const created = await App.api('/api/orders', {
        method: 'POST',
        body: {
          name: String(fd.get('name') || '').trim(),
          email: String(fd.get('email') || '').trim(),
          phone: String(fd.get('phone') || '').trim(),
          travel_date: String(fd.get('travel_date') || '').trim(),
          notes: String(fd.get('notes') || '').trim(),
          items
        }
      });
      const order = created.order;
      try { window.sessionStorage.setItem('hv_last_order', order.reference); } catch (_e) { /* ignore */ }

      // Start the payment flow for the chosen method.
      const pay = await App.api(`/api/orders/${encodeURIComponent(order.reference)}/pay`, {
        method: 'POST',
        body: { method }
      });

      const p = pay.payment || {};
      if (p.mode === 'redirect' && p.redirectUrl) {
        // Mock: the redirect URL itself carries a signed confirmation we verify
        // here, then we land on the order page.
        note.textContent = 'Redirecting to payment\u2026';
        window.location.href = p.redirectUrl;
        return;
      }
      if (p.mode === 'form-post' && p.action) {
        // Real gateway (eSewa): auto-submit a hidden form to the gateway.
        const f = document.createElement('form');
        f.method = 'POST'; f.action = p.action;
        Object.entries(p.fields || {}).forEach(([k, v]) => {
          const i = document.createElement('input');
          i.type = 'hidden'; i.name = k; i.value = v;
          f.appendChild(i);
        });
        document.body.appendChild(f);
        f.submit();
        return;
      }
      // Bank transfer / manual: go to the order page for instructions.
      window.location.href = 'order.html?ref=' + encodeURIComponent(order.reference);
    } catch (err) {
      note.className = 'form-note is-err';
      note.textContent = (err && err.message) || 'Could not place your order. Please try again.';
      btn.disabled = false;
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    if (!App || !Cart) return;
    await App.creditsReady();
    try {
      const data = await App.api('/api/payments/providers');
      providers = data.items || [];
    } catch (_e) {
      providers = [{ id: 'mock', label: 'Test payment (sandbox)', configured: true, live: false, note: '' }];
    }
    renderMethods();
    wireLines();
    refresh();
    document.getElementById('checkout-btn').addEventListener('click', placeOrder);
  });
})();

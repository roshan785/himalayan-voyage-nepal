'use strict';

/**
 * Order confirmation page.
 *
 * Two jobs:
 *   1. Read `?ref=` (or the reference kept in sessionStorage) and show the order.
 *   2. If a gateway just redirected back (e.g. `?status=paid&mock_sig=...`), send
 *      the evidence to the server to VERIFY it — the server is the only place
 *      that decides whether a payment succeeded. The client can never mark an
 *      order paid; it can only ask the server to confirm.
 */

(function () {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const App = window.App;
  const Cart = window.Cart;

  function money(v) { return App.money(v); }

  function render(order) {
    const box = document.getElementById('order-box');
    const paid = order.payment_status === 'paid';
    const badge = paid
      ? '<span class="badge badge--ok">Paid</span>'
      : '<span class="badge badge--off">Payment pending</span>';
    const rows = (order.items || []).map((it) => `
      <tr>
        <td>${App.escapeHtml(it.title)}</td>
        <td>${it.qty}</td>
        <td>${money(it.unit_price)}</td>
        <td>${money(it.line_total)}</td>
      </tr>`).join('');
    box.innerHTML = `
      <div class="order-card">
        <div class="order-card__head">
          <div>
            <h2>Order ${App.escapeHtml(order.reference)}</h2>
            <p class="small muted">Placed ${App.formatDate(order.created_at)} \u2022 ${App.escapeHtml(order.customer_email || '')}</p>
          </div>
          ${badge}
        </div>
        <div class="order-timeline">
          ${['pending', 'confirmed', 'completed'].map((s, i) => {
            const reached = order.status === 'completed' ? true : (order.status === 'confirmed' ? i <= 1 : i === 0);
            return `<span class="order-timeline__step${reached ? ' is-done' : ''}">${s}</span>`;
          }).join('<span class="order-timeline__sep">\u2192</span>')}
          ${order.status === 'cancelled' ? '<span class="order-timeline__step is-cancelled">cancelled</span>' : ''}
        </div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Package</th><th>Travellers</th><th>Unit</th><th>Line total</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        <div class="order-totals">
          <div class="summary-row"><span>Subtotal</span><span>${money(order.subtotal)}</span></div>
          ${order.discount_total > 0 ? `<div class="summary-row summary-row--save"><span>Discount</span><span>&minus; ${money(order.discount_total)}</span></div>` : ''}
          <div class="summary-row summary-row--total"><span>Total</span><span>${money(order.total)}</span></div>
        </div>
        ${paid
          ? '<p class="form-note is-ok" style="margin-top:14px">Thank you! Your payment is confirmed. Our team will email your itinerary shortly.</p>'
          : `<div class="pay-now" style="margin-top:16px">
               <p class="small muted">Complete your payment to confirm this booking.</p>
               <button class="btn btn--primary" id="pay-now-btn" type="button">Pay now</button>
             </div>`}
        <div style="margin-top:18px;display:flex;gap:10px;flex-wrap:wrap">
          <a class="btn btn--ghost btn--sm" href="/api/orders/${encodeURIComponent(order.reference)}/invoice.pdf" target="_blank" rel="noopener">Download Invoice (PDF)</a>
          <a class="btn btn--ghost btn--sm" href="shop.html">&larr; Continue shopping</a>
        </div>
      </div>`;

    const payBtn = document.getElementById('pay-now-btn');
    if (payBtn) payBtn.addEventListener('click', () => payNow(order.reference));
  }

  async function payNow(reference) {
    try {
      const pay = await App.api(`/api/orders/${encodeURIComponent(reference)}/pay`, {
        method: 'POST', body: { method: 'mock' }
      });
      const p = pay.payment || {};
      if (p.redirectUrl) { window.location.href = p.redirectUrl; return; }
      if (p.action) return; // handled by the form-post branch in cart.js
      load(reference);
    } catch (err) {
      App.toast((err && err.message) || 'Could not start payment', 'err');
    }
  }

  /** Ask the server to verify a gateway callback, then re-render. */
  async function verifyReturn(reference, params) {
    const evidence = {
      method: params.get('method') || 'mock',
      mock_sig: params.get('mock_sig') || '',
      mock_ts: params.get('mock_ts') || '',
      // eSewa delivers its signed payload as base64 JSON in ?data=; Khalti
      // returns ?pidx= on the return_url. The server re-checks both.
      data: params.get('data') || '',
      pidx: params.get('pidx') || params.get('transaction_uuid') || ''
    };
    try {
      const res = await App.api(`/api/orders/${encodeURIComponent(reference)}/verify`, {
        method: 'POST', body: evidence
      });
      if (res.paid && Cart) Cart.clear();
      return res;
    } catch (err) {
      App.toast((err && err.message) || 'Payment verification failed', 'err');
      return { paid: false };
    }
  }

  async function load(reference) {
    const box = document.getElementById('order-box');
    try {
      const data = await App.api('/api/orders/' + encodeURIComponent(reference));
      const order = data.order;
      document.title = 'Order ' + order.reference + ' | Himalayan Voyage Nepal';
      const t = document.getElementById('order-title');
      const s = document.getElementById('order-sub');
      if (order.payment_status === 'paid') {
        if (t) t.textContent = 'Booking confirmed';
        if (s) s.textContent = 'Your payment has been received. We will be in touch shortly.';
      } else {
        if (t) t.textContent = 'Order received';
        if (s) s.textContent = 'Your order is saved. Complete payment to confirm your booking.';
      }
      render(order);
    } catch (err) {
      box.innerHTML = `<div class="empty">We could not find that order. ${App.escapeHtml((err && err.message) || '')}
        <a href="shop.html">Back to the Travel Shop</a>.</div>`;
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    if (!App) return;
    await App.creditsReady();
    const params = new URLSearchParams(location.search);
    let reference = params.get('ref') || '';
    if (!reference) {
      try { reference = window.sessionStorage.getItem('hv_last_order') || ''; } catch (_e) { reference = ''; }
    }
    if (!reference) {
      document.getElementById('order-box').innerHTML =
        '<div class="empty">No order selected. <a href="shop.html">Browse the Travel Shop</a>.</div>';
      return;
    }
    // If the gateway came back with a status carrying proof, verify it first.
    if (params.get('status') && (params.get('mock_sig') || params.get('data') || params.get('pidx') || params.get('transaction_uuid'))) {
      await verifyReturn(reference, params);
    }
    load(reference);
  });
})();

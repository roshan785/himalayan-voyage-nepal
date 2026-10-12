'use strict';

/**
 * FAQ page: renders an accessible accordion. Items are open/closed by toggling
 * a class; state is kept in the DOM rather than re-rendered so screen readers
 * announce changes correctly.
 */

(function () {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  const FAQS = [
    { q: 'How do I book a tour?', a: 'Send an enquiry through the contact form or call us. We confirm availability, share a detailed itinerary with inclusions, and collect a deposit to lock in your dates.' },
    { q: 'Are flight tickets included in the package price?', a: 'It depends on the package. Domestic and international packages state clearly whether flights are included. If not, we can book them for you on request.' },
    { q: 'When is the best time to trek in Nepal?', a: 'Autumn (late September to November) and spring (March to May) offer the most stable weather and clearest views. Winter is good for lower-altitude trips, and the monsoon is best for city and jungle tours.' },
    { q: 'Do I need travel insurance?', a: 'We strongly recommend it for every trip, and it is essential for trekking and adventure activities. Cover should include medical treatment and, for treks, helicopter evacuation.' },
    { q: 'What payment methods do you accept?', a: 'Bank transfer and accepted digital wallets for deposits and final payments. We issue a receipt for every payment and share a written confirmation of your booking.' },
    { q: 'Can you help with visas?', a: 'Yes. Our visa desk reviews your documents, helps with the application form, books appointments and prepares you for the interview where applicable.' },
    { q: 'Do you arrange custom itineraries?', a: 'Absolutely. Most of our trips are adjusted to the traveller\u2019s dates, pace and budget. Send us your requirements and we will draft an itinerary at no cost.' },
    { q: 'What is your cancellation policy?', a: 'Cancellation terms depend on the supplier and how close to departure you cancel. Full terms are stated in your booking confirmation before any payment is made.' }
  ];

  document.addEventListener('DOMContentLoaded', () => {
    const box = document.getElementById('faq-list');
    if (!box) return;
    box.innerHTML = FAQS.map((f, i) => `
      <article class="card" style="margin-bottom:12px">
        <button class="faq-q" aria-expanded="false" aria-controls="faq-a-${i}"
          style="width:100%;text-align:left;background:#fff;border:0;font:inherit;font-weight:600;color:var(--ink);padding:18px 20px;cursor:pointer;display:flex;justify-content:space-between;gap:14px;align-items:center">
          <span>${f.q.replace(/</g, '&lt;')}</span>
          <span class="faq-sign" style="color:var(--brand);font-size:1.3rem;line-height:1">+</span>
        </button>
        <div id="faq-a-${i}" class="faq-a" style="display:none;padding:0 20px 18px;color:var(--muted)">${f.a.replace(/</g, '&lt;')}</div>
      </article>`).join('');

    box.addEventListener('click', (e) => {
      const btn = e.target.closest('.faq-q');
      if (!btn) return;
      const panel = document.getElementById(btn.getAttribute('aria-controls'));
      const open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      panel.style.display = open ? 'none' : 'block';
      const sign = btn.querySelector('.faq-sign');
      if (sign) sign.textContent = open ? '+' : '\u2212';
    });
  });
})();

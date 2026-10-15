'use strict';

/**
 * FAQ page: an accessible, single-open accordion.
 *
 * Behaviour matches the reference travel site: opening one question
 * automatically closes whichever question was open before it, so only ONE
 * answer is ever visible. The panel animates open/closed with a height
 * transition (the reference uses jQuery's slideUp/slideDown), and state is kept
 * in the DOM via `aria-expanded` / `aria-hidden` so screen readers announce the
 * change correctly.
 *
 * prefers-reduced-motion is handled in CSS (transition disabled there), so this
 * script keeps a single code path.
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

  // Must stay in sync with the .faq-a transition duration in style.css; it is the
  // delay before the panel is hidden, so hiding never cuts the animation short.
  const DURATION = 280;

  const escapeHtml = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  document.addEventListener('DOMContentLoaded', () => {
    const box = document.getElementById('faq-list');
    if (!box) return;

    box.innerHTML = FAQS.map((f, i) => `
      <article class="card faq-item" style="margin-bottom:12px">
        <h3 class="faq-heading">
          <button class="faq-q" type="button" id="faq-q-${i}" aria-expanded="false" aria-controls="faq-a-${i}">
            <span class="faq-q__text">${escapeHtml(f.q)}</span>
            <span class="faq-sign" aria-hidden="true">+</span>
          </button>
        </h3>
        <div id="faq-a-${i}" class="faq-a" role="region" aria-labelledby="faq-q-${i}" hidden>
          <div class="faq-a__inner">${escapeHtml(f.a)}</div>
        </div>
      </article>`).join('');

    const items = Array.from(box.querySelectorAll('.faq-item')).map((el) => ({
      el,
      btn: el.querySelector('.faq-q'),
      panel: el.querySelector('.faq-a'),
      inner: el.querySelector('.faq-a__inner'),
      sign: el.querySelector('.faq-sign'),
      timer: null,
      isOpen: false
    }));

    /** Animate a panel open to its natural height, then hand layout back to CSS. */
    function open(item) {
      if (item.isOpen) return;
      item.isOpen = true;
      if (item.timer) { window.clearTimeout(item.timer); item.timer = null; }
      item.btn.setAttribute('aria-expanded', 'true');
      if (item.sign) item.sign.textContent = '\u2212';
      item.panel.hidden = false;
      item.el.classList.add('is-open');
      // 0 -> measured height, then clear both so the panel reflows with its
      // content (a fixed pixel height would break on resize or a long answer).
      item.panel.style.height = '0px';
      item.panel.style.opacity = '0';
      requestAnimationFrame(() => {
        item.panel.style.height = item.inner.offsetHeight + 'px';
        item.panel.style.opacity = '1';
      });
    }

    function close(item) {
      if (!item.isOpen) return;
      item.isOpen = false;
      item.btn.setAttribute('aria-expanded', 'false');
      item.el.classList.remove('is-open');
      if (item.sign) item.sign.textContent = '+';
      item.panel.style.height = item.panel.offsetHeight + 'px'; // pin current height first
      item.panel.style.opacity = '0';
      requestAnimationFrame(() => { item.panel.style.height = '0px'; });
      // Hide only after the transition, otherwise it would pop shut with no animation.
      item.timer = window.setTimeout(() => {
        item.timer = null;
        if (item.isOpen) return;              // reopened mid-transition
        item.panel.hidden = true;
        item.panel.style.height = '';
        item.panel.style.opacity = '';
      }, DURATION + 30);
    }

    /** Only one answer is visible at a time — opening one closes the others. */
    function closeOthers(keep) {
      items.forEach((it) => { if (it !== keep && it.isOpen) close(it); });
    }

    box.addEventListener('click', (e) => {
      const btn = e.target.closest('.faq-q');
      if (!btn) return;
      const item = items.find((it) => it.btn === btn);
      if (!item) return;
      if (item.isOpen) {
        close(item);
      } else {
        closeOthers(item);
        open(item);
      }
    });
  });
})();

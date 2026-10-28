'use strict';

/**
 * Packages page: category tabs + text search, with a single-package detail
 * view when the URL contains ?slug=.
 */

(function () {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const App = window.App;

  // Packages shown per page. This MUST equal the column count of the listing
  // grid on packages.html (`.grid.grid--3` -> 3 columns). With 4 the first page
  // rendered 3 cards + one orphan on a second row and the last page held a
  // single card (9 packages once split 4/4/1 instead of 3/3/3).
  const PER_PAGE = 3;

  const state = { category: 'all', q: '', sort: '', page: 1, items: [] };

  function sortItems(items) {
    const mode = state.sort;
    if (mode === 'price-asc') return items.slice().sort((a, b) => (Number(a.price) || 0) - (Number(b.price) || 0));
    if (mode === 'price-desc') return items.slice().sort((a, b) => (Number(b.price) || 0) - (Number(a.price) || 0));
    if (mode === 'rating') return items.slice().sort((a, b) => App.ratingFor(b) - App.ratingFor(a));
    return items;
  }

  function card(p) {
    const finalPrice = App.discountPrice(p.price, p.discount);
    const priceHtml = p.discount > 0
      ? `<span class="price"><small>From</small><s>${App.money(p.price)}</s>${App.money(finalPrice)}</span>`
      : `<span class="price"><small>From</small>${App.money(p.price)}</span>`;
    const cov = App.coverInner(p, {
      overlay: { label: 'Read More', href: 'packages.html?slug=' + encodeURIComponent(p.slug) }
    });
    return `
      <article class="card reveal is-in">
        <div class="cover ${cov.cls}">${cov.html}</div>
        <div class="card__body">
          ${App.starsHtml(App.ratingFor(p))}
          <div class="meta-row">
            <span>${App.escapeHtml(p.destination)}</span>
            <span>${p.days} days &amp; ${p.nights} night${p.nights === 1 ? '' : 's'}</span>
          </div>
          <p>${App.escapeHtml(p.summary)}</p>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${(p.highlights || []).slice(0, 3).map((h) => `<span class="badge badge--soft">${App.escapeHtml(h)}</span>`).join(' ')}
          </div>
          <div class="card__foot">
            ${priceHtml}
            <a class="btn btn--primary btn--sm" href="packages.html?slug=${encodeURIComponent(p.slug)}">Read More</a>
          </div>
        </div>
      </article>`;
  }

  /**
   * Render only the slice of `state.items` that belongs to `state.page`, then
   * paint the pager. Called on first load and on every page change so the same
   * list is never re-fetched just to move between pages.
   */
  function renderPage() {
    const grid = document.getElementById('package-grid');
    const count = document.getElementById('package-count');
    if (!grid) return;
    const total = state.items.length;
    const pages = Math.max(1, Math.ceil(total / PER_PAGE));

    // A filter/search/sort change can push us past the end; clamp instead of
    // showing an empty grid.
    if (state.page > pages) state.page = pages;
    if (state.page < 1) state.page = 1;

    const start = (state.page - 1) * PER_PAGE;
    const slice = state.items.slice(start, start + PER_PAGE);

    if (!total) {
      App.showEmpty(grid, 'No packages match your filters.');
      if (count) count.textContent = '';
      renderPager(0, 0);
      return;
    }

    grid.innerHTML = slice.map(card).join('');
    // Cards are injected after the page-level reveal observer has run, so
    // trigger the reveal for the fresh nodes explicitly.
    App.revealAll(grid);

    if (count) {
      const from = start + 1;
      const to = start + slice.length;
      count.textContent = `Showing ${from}\u2013${to} of ${total} package${total === 1 ? '' : 's'}`;
    }
    renderPager(state.page, pages);
  }

  /**
   * Compact page-number list with first/last always visible and an ellipsis
   * when the range is long, e.g. 1 2 3 4 5 … 9  (never more than ~7 buttons).
   */
  function pageNumbers(current, pages) {
    if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
    const out = [1];
    const lo = Math.max(2, current - 1);
    const hi = Math.min(pages - 1, current + 1);
    if (lo > 2) out.push('\u2026');
    for (let i = lo; i <= hi; i += 1) out.push(i);
    if (hi < pages - 1) out.push('\u2026');
    out.push(pages);
    return out;
  }

  function renderPager(current, pages) {
    const pager = document.getElementById('package-pager');
    if (!pager) return;
    if (pages <= 1) {
      pager.innerHTML = '';
      pager.hidden = true;
      return;
    }
    pager.hidden = false;

    const btn = (label, page, { active = false, disabled = false, aria = '' } = {}) =>
      `<button type="button" class="pager__btn${active ? ' is-active' : ''}" ` +
      `data-page="${page}"${disabled ? ' disabled' : ''} ` +
      `${aria ? `aria-label="${aria}" ` : ''}` +
      `${active ? 'aria-current="page" ' : ''}>${label}</button>`;

    const parts = [btn('\u2190 Prev', current - 1, { disabled: current <= 1, aria: 'Previous page' })];
    for (const n of pageNumbers(current, pages)) {
      if (n === '\u2026') parts.push('<span class="pager__gap" aria-hidden="true">\u2026</span>');
      else parts.push(btn(String(n), n, { active: n === current, aria: `Page ${n}` }));
    }
    parts.push(btn('Next \u2192', current + 1, { disabled: current >= pages, aria: 'Next page' }));
    pager.innerHTML = `<nav class="pager" aria-label="Package pages">${parts.join('')}</nav>`;
  }

  function goToPage(page) {
    const pages = Math.max(1, Math.ceil(state.items.length / PER_PAGE));
    const next = Math.min(Math.max(1, page), pages);
    if (next === state.page) return;
    state.page = next;
    renderPage();
    // Keep the grid in view after a page jump so the change is obvious.
    const grid = document.getElementById('package-grid');
    if (grid) grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function loadList() {
    const grid = document.getElementById('package-grid');
    const count = document.getElementById('package-count');
    App.skeletonCards(grid, PER_PAGE);
    try {
      const params = new URLSearchParams();
      if (state.category && state.category !== 'all') params.set('category', state.category);
      if (state.q) params.set('q', state.q);
      const data = await App.api('/api/packages' + (params.toString() ? '?' + params.toString() : ''));
      state.items = sortItems(data.items || []);
      state.page = 1;
      renderPage();
    } catch (err) {
      App.showEmpty(grid, 'Could not load packages.');
      if (count) count.textContent = '';
      renderPager(0, 0);
      App.toast(err.message, 'err');
    }
  }

  /**
   * Single-package view: the itinerary details on the left and a sticky
   * booking panel on the right. Submitting the panel posts to /api/bookings,
   * which the admin console lists under "Bookings" — so a request made on the
   * live site shows up for the staff without any manual step.
   */
  async function loadDetail(slug) {
    const box = document.getElementById('package-detail');
    const grid = document.getElementById('package-grid');
    const tabs = document.getElementById('package-tabs');
    if (!box) return;
    try {
      const data = await App.api('/api/packages/' + encodeURIComponent(slug));
      const p = data.item;
      const finalPrice = App.discountPrice(p.price, p.discount);
      box.classList.remove('hidden');
      if (grid) grid.classList.add('hidden');
      if (tabs) tabs.classList.add('hidden');
      const search = document.getElementById('package-search');
      if (search && search.closest('.field')) search.closest('.field').classList.add('hidden');
      const count = document.getElementById('package-count');
      if (count) count.classList.add('hidden');
      const listingHead = document.getElementById('package-listing-head');
      if (listingHead) listingHead.classList.add('hidden');
      const pager = document.getElementById('package-pager');
      if (pager) pager.classList.add('hidden');
      document.title = p.title + ' | Himalayan Voyage Nepal';

      const cov = App.coverInner(p);
      const priceRow = p.discount > 0
        ? `<span class="now">${App.money(finalPrice)}</span><span class="was">${App.money(p.price)}</span><span class="badge badge--ok">Save ${p.discount}%</span>`
        : `<span class="now">${App.money(p.price)}</span>`;

      // Small inline icons keep the form readable without an icon font.
      const ico = {
        person: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8" r="3.6"/><path d="M4.5 20c1.4-3.7 4.2-5.4 7.5-5.4s6.1 1.7 7.5 5.4"/></svg>',
        mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="m3 7 9 6 9-6"/></svg>',
        phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2 4.2 2 2 0 0 1 4 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.1a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>',
        users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M2.5 20c1.2-3.3 3.6-4.8 6.5-4.8s5.3 1.5 6.5 4.8"/><path d="M17 5.5a3 3 0 0 1 0 5.6M18.5 20c-.2-2-.8-3.6-1.8-4.7"/></svg>',
        calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
        chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/></svg>',
        shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5.5c0 4-2.9 7.4-7 8.5-4.1-1.1-7-4.5-7-8.5V6z"/><path d="m9 12 2 2 4-4"/></svg>',
        bolt: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13z"/></svg>'
      };

      box.innerHTML = `
        <nav class="breadcrumbs" aria-label="Breadcrumb"><a href="index.html">Home</a> / <a href="packages.html">Packages</a> / ${App.escapeHtml(p.title)}</nav>
        <div class="detail-grid">
          <div class="detail-main">
            <div class="detail-hero cover ${cov.cls}">${cov.html}</div>
            <h1 class="detail-title">${App.escapeHtml(p.title)}</h1>
            <div class="meta-row">
              <span>${App.escapeHtml(p.destination)}</span>
              <span>${p.days} days &amp; ${p.nights} night${p.nights === 1 ? '' : 's'}</span>
              <span class="badge">${App.escapeHtml(p.category)}</span>
            </div>
            <p class="detail-lead">${App.escapeHtml(p.summary)}</p>
            <h3>Highlights</h3>
            <ul class="checklist">${(p.highlights || []).map((h) => `<li>${App.escapeHtml(h)}</li>`).join('') || '<li>Contact us for full inclusions.</li>'}</ul>
            <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap">
              <a class="btn btn--ghost btn--sm" href="packages.html">&larr; All packages</a>
              <a class="btn btn--ghost btn--sm" href="docs/${encodeURIComponent(p.slug)}.pdf" target="_blank" rel="noopener">Itinerary PDF</a>
            </div>
            <!-- Consult card lives in the article, not the sticky column, so the
                 booking panel is the only thing that has to fit there. -->
            <div class="side-panel consult-card">
              <h4 class="side-panel__head">Need help deciding?</h4>
              <div class="side-panel__body">
                <p class="small muted">Talk to a travel consultant about dates, group sizes and custom itineraries &mdash; we usually reply within one working day.</p>
                <a class="btn btn--ghost btn--sm btn--block" href="contact.html">${ico.chat} Contact a consultant</a>
              </div>
            </div>
          </div>
          <aside class="detail-side">
            <div class="booking-panel">
              <div class="booking-panel__flag">${ico.bolt} No payment now</div>
              <h3 class="booking-panel__title">Book this tour</h3>
              <p class="booking-panel__sub">Secure your spot &mdash; pay nothing today</p>
              <div class="price-row">
                <span class="now">${priceRow}</span>
                <span class="small muted">per person</span>
              </div>

              <form class="form booking-form" id="booking-form" data-slug="${App.escapeHtml(p.slug)}" data-title="${App.escapeHtml(p.title)}" novalidate>
                <div class="booking-field">
                  <label class="booking-field__label" for="bf-name">Full name <span class="req" aria-hidden="true">*</span></label>
                  <div class="booking-field__wrap booking-field__wrap--icon">
                    <span class="booking-field__icon" aria-hidden="true">${ico.person}</span>
                    <input id="bf-name" type="text" name="name" autocomplete="name" placeholder="Broad Technology Hub" required aria-required="true" aria-describedby="bf-name-err">
                  </div>
                  <p class="booking-field__err" id="bf-name-err" role="alert"></p>
                </div>

                <div class="booking-field">
                  <label class="booking-field__label" for="bf-email">Email address <span class="req" aria-hidden="true">*</span></label>
                  <div class="booking-field__wrap booking-field__wrap--icon">
                    <span class="booking-field__icon" aria-hidden="true">${ico.mail}</span>
                    <input id="bf-email" type="email" name="email" autocomplete="email" inputmode="email" placeholder="you@example.com" required aria-required="true" aria-describedby="bf-email-err">
                  </div>
                  <p class="booking-field__err" id="bf-email-err" role="alert"></p>
                </div>

                <div class="booking-grid">
                  <div class="booking-field">
                    <label class="booking-field__label" for="bf-phone">Phone</label>
                    <div class="booking-field__wrap">
                      <input id="bf-phone" type="tel" name="phone" autocomplete="tel" inputmode="tel" placeholder="+977 9800000000">
                    </div>
                  </div>
                  <div class="booking-field">
                    <label class="booking-field__label" for="bf-travellers">Travellers</label>
                    <div class="booking-field__wrap booking-field__wrap--icon">
                      <span class="booking-field__icon" aria-hidden="true">${ico.users}</span>
                      <input id="bf-travellers" type="number" name="travellers" min="1" max="50" step="1" value="1" inputmode="numeric" aria-describedby="bf-travellers-err">
                    </div>
                    <p class="booking-field__err" id="bf-travellers-err" role="alert"></p>
                  </div>
                </div>

                <div class="booking-field">
                  <label class="booking-field__label" for="bf-date">Preferred travel date</label>
                  <div class="booking-field__wrap booking-field__wrap--icon">
                    <span class="booking-field__icon" aria-hidden="true">${ico.calendar}</span>
                    <input id="bf-date" type="date" name="travel_date">
                  </div>
                  <p class="booking-field__err" id="bf-date-err" role="alert"></p>
                </div>

                <div class="booking-field">
                  <label class="booking-field__label" for="bf-message">Anything else?</label>
                  <div class="booking-field__wrap">
                    <textarea id="bf-message" name="message" rows="3" placeholder="Dietary needs, room preference, add-ons&hellip;"></textarea>
                  </div>
                </div>

                <button class="btn btn--primary btn--block booking-submit" type="submit">
                  <span class="booking-submit__label">Request Booking</span>
                  <span class="booking-submit__spin" aria-hidden="true"></span>
                </button>

                <ul class="booking-assure">
                  <li>${ico.shield} No payment now</li>
                  <li>${ico.calendar} Free date changes</li>
                  <li>${ico.chat} Reply within 1 working day</li>
                </ul>

                <div class="form-note" role="status" aria-live="polite"></div>
              </form>
            </div>
          </aside>
        </div>`;
      App.revealAll(box);
      wireBookingForm();
    } catch (_err) {
      box.classList.remove('hidden');
      box.innerHTML = '<div class="empty">Package not found. <a href="packages.html">Back to all packages</a>.</div>';
    }
  }

  /**
   * POST the booking form to the API and give clear inline feedback.
   *
   * The markup uses `novalidate` so the browser's native bubble does not fight
   * the styled inline errors: every field is validated here instead, the first
   * bad one is focused, and the button shows a spinner while the request is in
   * flight (with a real failure state if the network call rejects).
   */
  function wireBookingForm() {
    const form = document.getElementById('booking-form');
    if (!form) return;
    const note = form.querySelector('.form-note');
    const btn = form.querySelector('button[type="submit"]');
    const label = btn && btn.querySelector('.booking-submit__label');

    // Each field's message element is looked up through an explicit id, so a
    // name -> id mismatch can never silently swallow an error again
    // (`travel_date` maps to `bf-date-err`, not `bf-travel_date-err`).
    const ERR_ID = { name: 'bf-name-err', email: 'bf-email-err', travellers: 'bf-travellers-err', travel_date: 'bf-date-err' };
    const setError = (name, msg) => {
      const input = form.elements[name];
      const err = document.getElementById(ERR_ID[name] || ('bf-' + name + '-err'));
      if (err) err.textContent = msg || '';
      if (input) {
        if (msg) input.setAttribute('aria-invalid', 'true');
        else input.removeAttribute('aria-invalid');
      }
      return !msg;
    };

    // Clear a field's error as soon as the visitor fixes it.
    ['name', 'email', 'travellers', 'travel_date'].forEach((name) => {
      const input = form.elements[name];
      if (input) input.addEventListener('input', () => setError(name, ''));
    });

    function validate() {
      const fv = (n) => String((form.elements[n] || {}).value || '').trim();
      let ok = true;
      let firstBad = null;
      const fail = (n, m) => { setError(n, m); ok = false; if (!firstBad) firstBad = form.elements[n]; };

      if (fv('name').length < 2) fail('name', 'Please enter your full name.');
      else setError('name', '');

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(fv('email'))) fail('email', 'Enter a valid email address.');
      else setError('email', '');

      const t = Number(fv('travellers'));
      if (!Number.isInteger(t) || t < 1 || t > 50) fail('travellers', 'Between 1 and 50 travellers.');
      else setError('travellers', '');

      const d = fv('travel_date');
      if (d) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (new Date(d + 'T00:00:00') < today) fail('travel_date', 'Please pick today or a future date.');
        else setError('travel_date', '');
      } else setError('travel_date', '');

      if (firstBad) firstBad.focus();
      return ok;
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!validate()) {
        note.className = 'form-note is-err';
        note.textContent = 'Please fix the highlighted fields and try again.';
        return;
      }

      const fd = new FormData(form);
      const payload = {
        package_slug: form.dataset.slug,
        package_title: form.dataset.title,
        name: String(fd.get('name') || '').trim(),
        email: String(fd.get('email') || '').trim(),
        phone: String(fd.get('phone') || '').trim(),
        travellers: Number(fd.get('travellers')) || 1,
        travel_date: String(fd.get('travel_date') || '').trim(),
        message: String(fd.get('message') || '').trim()
      };

      note.className = 'form-note';
      note.textContent = '';
      btn.disabled = true;
      btn.classList.add('is-loading');
      if (label) label.textContent = 'Sending\u2026';

      try {
        await App.api('/api/bookings', { method: 'POST', body: payload });
        note.className = 'form-note is-ok';
        note.textContent = 'Thank you! Your booking request is in \u2014 we will contact you shortly to confirm the details.';
        form.reset();
        ['name', 'email', 'travellers', 'travel_date'].forEach((n) => setError(n, ''));
      } catch (err) {
        note.className = 'form-note is-err';
        note.textContent = (err && err.message) || 'Could not send your request. Please try again.';
      } finally {
        btn.disabled = false;
        btn.classList.remove('is-loading');
        if (label) label.textContent = 'Request Booking';
      }
    });
  }

  function wire() {
    const tabs = document.getElementById('package-tabs');
    if (tabs) {
      tabs.addEventListener('click', (e) => {
        const btn = e.target.closest('.tab');
        if (!btn) return;
        tabs.querySelectorAll('.tab').forEach((t) => t.classList.remove('is-active'));
        btn.classList.add('is-active');
        state.category = btn.dataset.cat;
        loadList();
      });
    }
    const search = document.getElementById('package-search');
    if (search) {
      let timer = null;
      search.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => { state.q = search.value.trim(); loadList(); }, 280);
      });
    }
    const sort = document.getElementById('package-sort');
    if (sort) {
      sort.addEventListener('change', () => { state.sort = sort.value; loadList(); });
    }
    const pager = document.getElementById('package-pager');
    if (pager) {
      pager.addEventListener('click', (e) => {
        const btn = e.target.closest('.pager__btn');
        if (!btn || btn.disabled) return;
        goToPage(Number(btn.dataset.page) || 1);
      });
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    await App.creditsReady();
    const slug = new URLSearchParams(location.search).get('slug');
    const category = new URLSearchParams(location.search).get('category');
    if (category) {
      state.category = category;
      const tab = document.querySelector(`.tab[data-cat="${category}"]`);
      if (tab) {
        document.querySelectorAll('#package-tabs .tab').forEach((t) => t.classList.remove('is-active'));
        tab.classList.add('is-active');
      }
    }
    wire();
    if (slug) loadDetail(slug);
    else loadList();
  });
})();

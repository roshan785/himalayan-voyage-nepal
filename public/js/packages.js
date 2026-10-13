'use strict';

/**
 * Packages page: category tabs + text search, with a single-package detail
 * view when the URL contains ?slug=.
 */

(function () {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const App = window.App;

  const state = { category: 'all', q: '', sort: '' };

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

  async function loadList() {
    const grid = document.getElementById('package-grid');
    const count = document.getElementById('package-count');
    App.skeletonCards(grid, 6);
    try {
      const params = new URLSearchParams();
      if (state.category && state.category !== 'all') params.set('category', state.category);
      if (state.q) params.set('q', state.q);
      const data = await App.api('/api/packages' + (params.toString() ? '?' + params.toString() : ''));
      const items = sortItems(data.items || []);
      grid.innerHTML = items.map(card).join('');
      if (!items.length) {
        App.showEmpty(grid, 'No packages match your filters.');
        if (count) count.textContent = '';
      } else if (count) {
        count.textContent = `${items.length} package${items.length === 1 ? '' : 's'} found`;
      }
    } catch (err) {
      App.showEmpty(grid, 'Could not load packages.');
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
      document.title = p.title + ' | Himalayan Voyage Nepal';

      const cov = App.coverInner(p);
      const priceRow = p.discount > 0
        ? `<span class="now">${App.money(finalPrice)}</span><span class="was">${App.money(p.price)}</span><span class="badge badge--ok">-${p.discount}%</span>`
        : `<span class="now">${App.money(p.price)}</span>`;

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
              <a class="btn btn--ghost btn--sm" href="docs/${encodeURIComponent(p.slug)}.pdf" target="_blank" rel="noopener">📄 Itinerary PDF</a>
            </div>
          </div>
          <aside class="detail-side">
            <div class="booking-panel">
              <h3>Book this tour</h3>
              <div class="price-row">${priceRow}<span class="small muted">per person</span></div>
              <form class="form" id="booking-form" data-slug="${App.escapeHtml(p.slug)}" data-title="${App.escapeHtml(p.title)}">
                <input type="text" name="name" placeholder="Full name" required>
                <input type="email" name="email" placeholder="Email address" required>
                <div class="booking-grid">
                  <input type="tel" name="phone" placeholder="Phone (optional)">
                  <input type="number" name="travellers" placeholder="Travellers" min="1" max="50" value="1">
                </div>
                <input type="date" name="travel_date" aria-label="Preferred travel date">
                <textarea name="message" rows="2" placeholder="Anything we should know? (optional)"></textarea>
                <button class="btn btn--primary btn--block" type="submit">Request Booking</button>
                <div class="form-note" role="status"></div>
              </form>
            </div>
            <div class="side-panel" style="margin-top:18px">
              <h4 class="side-panel__head">Need help?</h4>
              <div class="side-panel__body">
                <p class="small muted" style="margin:0 0 10px">Talk to a travel consultant about dates, group sizes and custom itineraries.</p>
                <a class="btn btn--ghost btn--sm btn--block" href="contact.html">Contact Us</a>
              </div>
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

  /** POST the booking form to the API and give clear inline feedback. */
  function wireBookingForm() {
    const form = document.getElementById('booking-form');
    if (!form) return;
    const note = form.querySelector('.form-note');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type="submit"]');
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
      btn.textContent = 'Sending…';
      try {
        await App.api('/api/bookings', { method: 'POST', body: payload });
        note.className = 'form-note is-ok';
        note.textContent = 'Thanks! Your booking request has been received — we will contact you shortly.';
        form.reset();
      } catch (err) {
        note.className = 'form-note is-err';
        note.textContent = err.message || 'Could not send your request. Please try again.';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Request Booking';
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

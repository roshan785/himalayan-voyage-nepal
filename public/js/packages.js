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
      if (search) search.closest('.field').classList.add('hidden');
      const count = document.getElementById('package-count');
      if (count) count.classList.add('hidden');

      const cov = App.coverInner(p);
      box.innerHTML = `
        <div class="card" style="overflow:visible">
          <div class="cover ${cov.cls}" style="border-radius:14px 14px 0 0;aspect-ratio:21/9">
            ${cov.html}
          </div>
          <div class="card__body" style="padding:30px;gap:16px">
            <div class="meta-row">
              <span>${App.escapeHtml(p.destination)}</span>
              <span>${p.days} days &amp; ${p.nights} night${p.nights === 1 ? '' : 's'}</span>
              <span class="badge">${App.escapeHtml(p.category)}</span>
            </div>
            <p style="font-size:1.02rem;color:var(--ink)">${App.escapeHtml(p.summary)}</p>
            <h3>Highlights</h3>
            <ul class="checklist">${(p.highlights || []).map((h) => `<li>${App.escapeHtml(h)}</li>`).join('') || '<li>Contact us for full inclusions.</li>'}</ul>
            <div class="card__foot" style="border-top:1px solid var(--line);padding-top:18px">
              <span class="price" style="font-size:1.35rem"><small>From per person</small>${p.discount > 0 ? `<s>${App.money(p.price)}</s>` : ''}${App.money(finalPrice)}</span>
              <div style="display:flex;gap:10px;flex-wrap:wrap">
                <a class="btn btn--ghost btn--sm" href="packages.html">&larr; All packages</a>
                <a class="btn btn--ghost btn--sm" href="docs/${encodeURIComponent(p.slug)}.pdf" target="_blank" rel="noopener">📄 Itinerary PDF</a>
                <a class="btn btn--primary btn--sm" href="contact.html?subject=${encodeURIComponent('Enquiry: ' + p.title)}">Enquire Now</a>
              </div>
            </div>
          </div>
        </div>`;
    } catch (_err) {
      box.classList.remove('hidden');
      box.innerHTML = '<div class="empty">Package not found. <a href="packages.html">Back to all packages</a>.</div>';
    }
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

'use strict';

/**
 * Travel Shop page: browse packages, filter/search/sort, add to cart.
 *
 * Renders the SAME package data as packages.html (reusing `App` helpers) but
 * with an "Add to cart" action and a link into checkout. Prices shown here are
 * for display only — the server recomputes the real total at order time.
 */

(function () {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const App = window.App;
  const Cart = window.Cart;

  const PER_PAGE = 6;
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
      overlay: { label: 'View', href: 'packages.html?slug=' + encodeURIComponent(p.slug) }
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
            <div class="shop-actions">
              <button class="btn btn--primary btn--sm" data-add="${App.escapeHtml(p.slug)}">Add to Cart</button>
              <a class="btn btn--ghost btn--sm" href="packages.html?slug=${encodeURIComponent(p.slug)}">Details</a>
            </div>
          </div>
        </div>
      </article>`;
  }

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
    const pager = document.getElementById('shop-pager');
    if (!pager) return;
    if (pages <= 1) { pager.innerHTML = ''; pager.hidden = true; return; }
    pager.hidden = false;
    const btn = (label, page, { active = false, disabled = false, aria = '' } = {}) =>
      `<button type="button" class="pager__btn${active ? ' is-active' : ''}" data-page="${page}"` +
      `${disabled ? ' disabled' : ''} ${aria ? `aria-label="${aria}" ` : ''}${active ? 'aria-current="page"' : ''}>${label}</button>`;
    const parts = [btn('\u2190 Prev', current - 1, { disabled: current <= 1, aria: 'Previous page' })];
    for (const n of pageNumbers(current, pages)) {
      if (n === '\u2026') parts.push('<span class="pager__gap" aria-hidden="true">\u2026</span>');
      else parts.push(btn(String(n), n, { active: n === current, aria: `Page ${n}` }));
    }
    parts.push(btn('Next \u2192', current + 1, { disabled: current >= pages, aria: 'Next page' }));
    pager.innerHTML = `<nav class="pager" aria-label="Shop pages">${parts.join('')}</nav>`;
  }

  function renderPage() {
    const grid = document.getElementById('shop-grid');
    const count = document.getElementById('shop-count');
    if (!grid) return;
    const total = state.items.length;
    const pages = Math.max(1, Math.ceil(total / PER_PAGE));
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
    App.revealAll(grid);
    if (count) count.textContent = `Showing ${start + 1}\u2013${start + slice.length} of ${total}`;
    renderPager(state.page, pages);
  }

  function goToPage(page) {
    const pages = Math.max(1, Math.ceil(state.items.length / PER_PAGE));
    const next = Math.min(Math.max(1, page), pages);
    if (next === state.page) return;
    state.page = next;
    renderPage();
    const grid = document.getElementById('shop-grid');
    if (grid) grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function load() {
    const grid = document.getElementById('shop-grid');
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
      App.showEmpty(grid, 'Could not load the shop.');
      App.toast(err.message, 'err');
    }
  }

  function wire() {
    const cats = document.getElementById('shop-categories');
    if (cats) {
      cats.addEventListener('click', (e) => {
        const btn = e.target.closest('.tab');
        if (!btn) return;
        cats.querySelectorAll('.tab').forEach((t) => t.classList.remove('is-active'));
        btn.classList.add('is-active');
        state.category = btn.dataset.cat;
        load();
      });
    }
    const search = document.getElementById('shop-search');
    if (search) {
      let timer = null;
      search.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => { state.q = search.value.trim(); load(); }, 280);
      });
    }
    const sort = document.getElementById('shop-sort');
    if (sort) sort.addEventListener('change', () => { state.sort = sort.value; load(); });

    const pager = document.getElementById('shop-pager');
    if (pager) {
      pager.addEventListener('click', (e) => {
        const btn = e.target.closest('.pager__btn');
        if (!btn || btn.disabled) return;
        goToPage(Number(btn.dataset.page) || 1);
      });
    }

    // Add-to-cart uses event delegation so freshly rendered cards are covered.
    const grid = document.getElementById('shop-grid');
    if (grid && Cart) {
      grid.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-add]');
        if (!btn) return;
        const slug = btn.dataset.add;
        const pkg = state.items.find((p) => p.slug === slug);
        if (!pkg) return;
        Cart.add({ slug: pkg.slug, title: pkg.title, price: pkg.price, discount: pkg.discount, image: pkg.image }, 1);
        btn.textContent = 'Added \u2713';
        btn.disabled = true;
        setTimeout(() => { btn.textContent = 'Add to Cart'; btn.disabled = false; }, 1200);
        App.toast(`${pkg.title} added to cart`, 'ok');
      });
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    if (!App) return;
    await App.creditsReady();
    // Honour incoming filters from the homepage "Build Your Trip" form and from
    // footer links (?category=..., ?q=...), so the guided entry lands pre-filtered.
    const params = new URLSearchParams(location.search);
    const cat = params.get('category') || '';
    const q = params.get('q') || '';
    if (cat) {
      state.category = cat;
      const tab = document.querySelector(`#shop-categories .tab[data-cat="${cat}"]`);
      if (tab) {
        document.querySelectorAll('#shop-categories .tab').forEach((t) => t.classList.remove('is-active'));
        tab.classList.add('is-active');
      }
    }
    if (q) {
      state.q = q;
      const searchEl = document.getElementById('shop-search');
      if (searchEl) searchEl.value = q;
    }
    wire();
    load();
  });
})();

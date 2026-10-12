'use strict';

/**
 * Destinations page: filter by Nepal / international and open a single
 * destination with its related packages when ?slug= is present.
 *
 * The whole IIFE returns early when there is no DOM, so the module can be
 * safely evaluated in a headless (Node) context without throwing.
 */

(function () {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const App = window.App;

  let kind = 'all';
  let allItems = [];        // last fetched list, so the toolbar can filter without refetching
  let toolbarApply = null;  // re-run hook returned by App.wireToolbar

  function card(d) {
    const cov = App.coverInner(d, { tag: d.kind === 'international' ? 'International' : 'Nepal', desti: true });
    return `
      <article class="card desti-card reveal is-in">
        <div class="cover ${cov.cls}">${cov.html}</div>
        <div class="card__body">
          ${App.starsHtml(App.ratingFor(d))}
          <p>${App.escapeHtml(d.description)}</p>
          <div class="meta-row"><span>${App.escapeHtml(d.region || '')}</span></div>
          <div class="card__foot">
            <a class="btn btn--ghost btn--sm" href="destinations.html?slug=${encodeURIComponent(d.slug)}">Explore More</a>
          </div>
        </div>
      </article>`;
  }

  function renderItems(items, q) {
    const grid = document.getElementById('dest-grid');
    if (!grid) return;
    const count = document.getElementById('dest-count');
    if (count) count.textContent = items.length + (items.length === 1 ? ' destination' : ' destinations');
    if (!items.length) {
      grid.innerHTML = '<div class="toolbar__empty">' +
        (q ? 'No destinations match &ldquo;' + App.escapeHtml(q) + '&rdquo;.' : 'No destinations available yet.') +
        '</div>';
      return;
    }
    grid.innerHTML = items.map(card).join('');
  }

  async function loadList() {
    const grid = document.getElementById('dest-grid');
    App.skeletonCards(grid, 6);
    try {
      const query = kind === 'all' ? '' : '?kind=' + encodeURIComponent(kind);
      const data = await App.api('/api/destinations' + query);
      allItems = data.items || [];
      if (!toolbarApply) {
        toolbarApply = App.wireToolbar({
          searchId: 'dest-search',
          sortId: 'dest-sort',
          getItems: () => allItems,
          render: renderItems
        });
      }
      if (toolbarApply) toolbarApply();
      else renderItems(allItems, '');
      if (!allItems.length) App.showEmpty(grid, 'No destinations available yet.');
    } catch (err) {
      App.showEmpty(grid, 'Could not load destinations.');
      App.toast(err.message, 'err');
    }
  }

  async function loadDetail(slug) {
    const box = document.getElementById('dest-detail');
    const grid = document.getElementById('dest-grid');
    const tabs = document.getElementById('dest-tabs');
    if (!box) return;
    try {
      const dest = (await App.api('/api/destinations/' + encodeURIComponent(slug))).item;
      const pkgs = (await App.api('/api/packages?q=' + encodeURIComponent(dest.name))).items;
      box.classList.remove('hidden');
      if (grid) grid.classList.add('hidden');
      if (tabs) tabs.classList.add('hidden');
      const heroCov = App.coverInner(dest);
      box.innerHTML = `
        <article class="card">
          <div class="cover ${heroCov.cls}" style="aspect-ratio:21/9;border-radius:14px 14px 0 0">
            ${heroCov.html}
          </div>
          <div class="card__body" style="padding:30px">
            <div class="meta-row"><span>${App.escapeHtml(dest.region || '')}</span><span class="badge">${dest.kind === 'international' ? 'International' : 'Nepal'}</span></div>
            <p style="font-size:1.02rem;color:var(--ink)">${App.escapeHtml(dest.description)}</p>
            <h3>Packages visiting ${App.escapeHtml(dest.name)}</h3>
            ${pkgs.length ? `<div class="grid grid--3">${pkgs.map((p) => {
              const c = App.coverInner(p, {
                overlay: { label: 'Read More', href: 'packages.html?slug=' + encodeURIComponent(p.slug) }
              });
              return `
              <article class="card">
                <div class="cover ${c.cls}">${c.html}</div>
                <div class="card__body">
                  <div class="meta-row"><span>${p.days} days</span><span>${App.money(App.discountPrice(p.price, p.discount))}</span></div>
                  <a class="btn btn--primary btn--sm" href="packages.html?slug=${encodeURIComponent(p.slug)}">Read More</a>
                </div>
              </article>`;
            }).join('')}</div>`
              : '<p class="muted">No packages reference this destination yet &mdash; <a href="contact.html">ask us for a custom itinerary</a>.</p>'}
            <div style="margin-top:18px"><a class="btn btn--ghost btn--sm" href="destinations.html">&larr; All destinations</a></div>
          </div>
        </article>`;
    } catch (_err) {
      box.classList.remove('hidden');
      box.innerHTML = '<div class="empty">Destination not found. <a href="destinations.html">Back to all destinations</a>.</div>';
    }
  }

  async function boot() {
    // Wait for the photo credit manifest, otherwise coverInner() cannot find
    // any images and every card falls back to plain CSS artwork.
    await App.creditsReady();
    const slug = new URLSearchParams(location.search).get('slug');
    const kindParam = new URLSearchParams(location.search).get('kind');
    const tabs = document.getElementById('dest-tabs');
    if (tabs) {
      tabs.addEventListener('click', (e) => {
        const btn = e.target.closest('.tab');
        if (!btn) return;
        tabs.querySelectorAll('.tab').forEach((t) => t.classList.remove('is-active'));
        btn.classList.add('is-active');
        kind = btn.dataset.kind;
        loadList();
      });
    }
    if (kindParam) {
      kind = kindParam;
      const tab = document.querySelector(`.tab[data-kind="${kindParam}"]`);
      if (tab) {
        document.querySelectorAll('#dest-tabs .tab').forEach((t) => t.classList.remove('is-active'));
        tab.classList.add('is-active');
      }
    }
    if (slug) loadDetail(slug);
    else loadList();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();

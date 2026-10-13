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

  /**
   * Single-destination view. Mirrors the reference site's "Destination Details"
   * layout: a hero cover + title, an Overview facts box
   * (Country/Capital/Currency/Language/Best time/Visa), the long description,
   * and a sidebar listing recent tour packages that visit the destination.
   */
  /**
   * Single-destination view. Layout mirrors the reference site's "Destination
   * Details" page exactly: a two-column grid (content 8 / sidebar 4) where the
   * left column holds the cover, long description and the Overview facts box,
   * the right sidebar lists "Explore Recent Tour Packages", and a full-width
   * CTA band sits below with a "Let's talk" button.
   */
  async function loadDetail(slug) {
    const box = document.getElementById('dest-detail');
    const grid = document.getElementById('dest-grid');
    const tabs = document.getElementById('dest-tabs');
    const toolbar = document.getElementById('dest-toolbar');
    const sidebar = document.getElementById('dest-sidebar');
    if (!box) return;
    try {
      const dest = (await App.api('/api/destinations/' + encodeURIComponent(slug))).item;
      // The reference sidebar lists the site's most recent packages (3 shown).
      const pkgs = (await App.api('/api/packages')).items.slice(0, 3);

      // Switch the page chrome into "detail" mode.
      box.classList.remove('hidden');
      if (grid) grid.classList.add('hidden');
      if (tabs) tabs.classList.add('hidden');
      if (toolbar) toolbar.classList.add('hidden');
      if (sidebar) sidebar.classList.add('hidden');
      const listingHead = document.getElementById('dest-listing-head');
      if (listingHead) listingHead.classList.add('hidden');

      const crumb = document.getElementById('dest-crumb');
      if (crumb) {
        crumb.innerHTML = '<a href="index.html">Home</a> / <a href="destinations.html">Destinations</a> / ' +
          '<span class="active">Destination Details</span>';
      }
      document.title = dest.name + ' | Himalayan Voyage Nepal';

      const cov = App.coverInner(dest);
      const facts = [
        ['Country', dest.country],
        ['Capital', dest.capital],
        ['Currency', dest.currency],
        ['Language', dest.language],
        ['Best Time to Visit', dest.best_time],
        ['Visa Requirements', dest.visa]
      ].filter(([, v]) => v && String(v).trim());
      const overview = facts.length
        ? '<div class="overview-box"><h4>Overview</h4>' +
          facts.map(([k, v]) =>
            '<div class="overview-item"><div class="overview-label">' + App.escapeHtml(k) +
            '</div><div class="overview-value">' + App.escapeHtml(v) + '</div></div>'
          ).join('') + '</div>'
        : '';

      const recent = pkgs.length
        ? pkgs.map((p) =>
            '<article class="recent-item"><div class="recent-item__date">' +
            App.escapeHtml(App.formatDate(p.created_at)) + '</div>' +
            '<h5 class="recent-item__name"><a href="packages.html?slug=' +
            encodeURIComponent(p.slug) + '">' + App.escapeHtml(p.title) + '</a></h5></article>'
          ).join('')
        : '<p class="muted small">No packages yet.</p>';

      box.innerHTML = `
        <div class="detail-grid">
          <div class="detail-main">
            <div class="detail-hero cover ${cov.cls}">${cov.html}</div>
            <h1 class="detail-title">${App.escapeHtml(dest.name)}</h1>
            <p class="detail-lead">${App.escapeHtml(dest.description)}</p>
            ${overview}
            <div style="margin-top:12px"><a class="btn btn--ghost btn--sm" href="destinations.html">&larr; All destinations</a></div>
          </div>
          <aside class="detail-side">
            <div class="side-panel">
              <h4 class="side-panel__head">Explore Recent Tour Packages</h4>
              <div class="side-panel__body">${recent}</div>
            </div>
          </aside>
        </div>`;
      App.revealAll(box);
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

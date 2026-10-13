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
  async function loadDetail(slug) {
    const box = document.getElementById('dest-detail');
    const grid = document.getElementById('dest-grid');
    const tabs = document.getElementById('dest-tabs');
    const toolbar = document.getElementById('dest-toolbar');
    const sidebar = document.getElementById('dest-sidebar');
    if (!box) return;
    try {
      const dest = (await App.api('/api/destinations/' + encodeURIComponent(slug))).item;
      // The reference site's "Explore Recent Tour Packages" lists the site's
      // most recent packages (not destination-filtered).
      const pkgs = (await App.api('/api/packages')).items;

      // Switch the page chrome into "detail" mode.
      box.classList.remove('hidden');
      if (grid) grid.classList.add('hidden');
      if (tabs) tabs.classList.add('hidden');
      if (toolbar) toolbar.classList.add('hidden');
      if (sidebar) sidebar.classList.add('hidden');
      const listingHead = document.getElementById('dest-listing-head');
      if (listingHead) listingHead.classList.add('hidden');

      // Update the breadcrumb + document title so the page reads as a detail page.
      const crumb = document.getElementById('dest-crumb');
      if (crumb) {
        crumb.innerHTML = '<a href="index.html">Home</a> / <a href="destinations.html">Destinations</a> / ' +
          App.escapeHtml(dest.name);
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

      const pkgCards = pkgs.length
        ? '<h3 class="recent-title">Explore Recent Tour Packages</h3><div class="recent-list">' +
          pkgs.slice(0, 4).map((p) => {
            const c = App.coverInner(p, { overlay: { label: 'Read More', href: 'packages.html?slug=' + encodeURIComponent(p.slug) } });
            return '<a class="recent-item" href="packages.html?slug=' + encodeURIComponent(p.slug) + '">' +
              '<span class="recent-item__cover ' + c.cls + '" style="border-radius:10px">' + c.html + '</span>' +
              '<span class="recent-item__body"><span class="recent-item__date">' + App.formatDate(p.created_at) + '</span>' +
              '<span class="recent-item__name">' + App.escapeHtml(p.title) + '</span></span></a>';
          }).join('') + '</div>'
        : '<p class="muted">No packages reference this destination yet &mdash; ' +
          '<a href="contact.html">ask us for a custom itinerary</a>.</p>';

      box.innerHTML = `
        <nav class="breadcrumbs" aria-label="Breadcrumb"><a href="index.html">Home</a> / <a href="destinations.html">Destinations</a> / ${App.escapeHtml(dest.name)}</nav>
        <div class="layout-side detail-layout">
          <article>
            <div class="detail-hero cover ${cov.cls}">
              ${cov.html}
            </div>
            <h1 class="detail-title">${App.escapeHtml(dest.name)}</h1>
            <div class="meta-row">
              <span>${App.escapeHtml(dest.region || '')}</span>
              <span class="badge">${dest.kind === 'international' ? 'International' : 'Nepal'}</span>
            </div>
            <p class="detail-lead">${App.escapeHtml(dest.description)}</p>
            ${overview}
            <div class="recent-wrap">${pkgCards}</div>
            <div style="margin-top:18px"><a class="btn btn--ghost btn--sm" href="destinations.html">&larr; All destinations</a></div>
          </article>
          <aside class="detail-aside">
            <div class="side-card">
              <h3>Plan this trip</h3>
              <p class="small muted" style="margin:0 0 12px">Tell us your dates and we&rsquo;ll build an itinerary around this destination.</p>
              <a class="btn btn--primary btn--sm" href="contact.html">Enquire Now</a>
            </div>
            <div class="side-card">
              <h3>Popular right now</h3>
              <ul class="side-list">
                <li><a href="destinations.html?slug=mustang"><span>Mustang</span><span class="n">Nepal</span></a></li>
                <li><a href="destinations.html?slug=pokhara"><span>Pokhara</span><span class="n">Nepal</span></a></li>
                <li><a href="destinations.html?slug=rara-lake"><span>Rara Lake</span><span class="n">Karnali</span></a></li>
                <li><a href="destinations.html?slug=bangkok"><span>Bangkok</span><span class="n">Thailand</span></a></li>
              </ul>
            </div>
            <div class="side-card">
              <h3>Need a visa?</h3>
              <p class="small muted" style="margin:0 0 10px">Checklists and assistance for 12 destination countries.</p>
              <a class="btn btn--ghost btn--sm" href="visa.html">Visa Services &rarr;</a>
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

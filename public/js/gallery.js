'use strict';

/**
 * Gallery page: renders destination covers as a responsive tile grid and lets
 * the visitor open a larger view in a lightweight lightbox dialog.
 */

(function () {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const App = window.App;

  function dialogEl() {
    let backdrop = document.getElementById('gallery-lightbox');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = 'gallery-lightbox';
      backdrop.className = 'dialog-backdrop';
      backdrop.innerHTML = '<div class="dialog" style="padding:0;overflow:hidden"><div id="gallery-lightbox-body"></div></div>';
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) backdrop.classList.remove('is-open');
      });
      document.body.appendChild(backdrop);
    }
    return backdrop;
  }

  async function render() {
    const grid = document.getElementById('gallery-grid');
    App.skeletonCards(grid, 8);
    try {
      const data = await App.api('/api/destinations');
      if (!data.items.length) {
        App.showEmpty(grid, 'No gallery items yet.');
        return;
      }
      grid.innerHTML = data.items.map((d, i) => {
        const cov = App.coverInner(d, {
          tag: d.kind === 'international' ? 'International' : 'Nepal',
          overlay: { label: 'View Photo' }
        });
        return `
        <button class="card reveal is-in" data-idx="${i}" style="padding:0;border:0;text-align:left;cursor:pointer;background:none">
          <div class="cover ${cov.cls}" style="aspect-ratio:1/1">
            ${cov.html}
          </div>
        </button>`;
      }).join('');

      const lightbox = dialogEl();
      grid.querySelectorAll('[data-idx]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const d = data.items[Number(btn.dataset.idx)];
          const cov = App.coverInner(d);
          document.getElementById('gallery-lightbox-body').innerHTML = `
            <div class="cover ${cov.cls}" style="aspect-ratio:21/9">
              ${cov.html}
            </div>
            <div style="padding:22px">
              <h3 style="margin-top:0">${App.escapeHtml(d.name)}</h3>
              <p class="muted small">${App.escapeHtml(d.region || '')}</p>
              <p>${App.escapeHtml(d.description)}</p>
              ${App.creditLine(App.resolveSlug(d) || '')}
              <a class="btn btn--primary btn--sm" href="destinations.html?slug=${encodeURIComponent(d.slug)}">Explore Destination</a>
            </div>`;
          lightbox.classList.add('is-open');
        });
      });
    } catch (err) {
      App.showEmpty(grid, 'Could not load gallery.');
      App.toast(err.message, 'err');
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    await App.creditsReady();
    render();
  });
})();

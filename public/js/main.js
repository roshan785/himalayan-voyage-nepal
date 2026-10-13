'use strict';

/**
 * Shared front-end helpers used by every page:
 *  - api()      thin fetch wrapper with JSON parsing + error handling
 *  - toast()    transient status message
 *  - nav toggle, scroll reveal, small formatting utilities
 *  - coverClass() maps a record to a decorative CSS cover (no third-party images)
 */

const App = (() => {
  // ------------------------------------------------------------------
  // HTTP
  // ------------------------------------------------------------------
  async function api(path, options = {}) {
    const opts = Object.assign({ headers: {} }, options);
    if (opts.body && typeof opts.body !== 'string') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    opts.headers.Accept = 'application/json';
    const res = await fetch(path, opts);
    let data = null;
    const text = await res.text();
    if (text) {
      try { data = JSON.parse(text); } catch (_e) { data = { raw: text }; }
    }
    if (!res.ok) {
      const message = (data && (data.error || data.message)) || `Request failed (${res.status})`;
      const err = new Error(message);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // ------------------------------------------------------------------
  // UI helpers
  // ------------------------------------------------------------------
  function toast(message, kind = '') {
    let el = document.getElementById('app-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'app-toast';
      el.className = 'toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.className = 'toast is-on' + (kind ? ' is-' + kind : '');
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.className = 'toast'; }, 3600);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function money(value) {
    const n = Number(value) || 0;
    return 'Rs. ' + n.toLocaleString('en-IN');
  }

  function discountPrice(price, discount) {
    const p = Number(price) || 0;
    const d = Number(discount) || 0;
    return Math.round(p - (p * d) / 100);
  }

  function formatDate(value) {
    if (!value) return '';
    const d = new Date(String(value).replace(' ', 'T') + (String(value).includes('Z') ? '' : 'Z'));
    if (isNaN(d.getTime())) return String(value);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function stars(rating) {
    const n = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
    return '\u2605'.repeat(n) + '\u2606'.repeat(5 - n);
  }

  /**
   * Star rating as screen-reader- and colour-friendly markup, optionally with a
   * numeric value ("4.0"). Used on destination/package cards and reviews.
   */
  function starsHtml(rating, { showValue = true } = {}) {
    const n = Math.max(0, Math.min(5, Number(rating) || 0));
    const full = Math.round(n);
    let out = '<span class="stars" aria-label="' + n + ' out of 5">';
    for (let i = 1; i <= 5; i++) out += '<i class="star' + (i <= full ? ' is-on' : '') + '">\u2605</i>';
    if (showValue) out += '<b>' + n.toFixed(1) + '</b>';
    return out + '</span>';
  }

  /**
   * A deterministic pseudo-rating for records that have none stored, so every
   * card can show a believable score without inventing data per render (same
   * slug always yields the same value). Range 3.8–5.0.
   */
  function ratingFor(record) {
    const seed = String((record && (record.slug || record.title || record.name)) || 'x');
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 1000;
    return 3.8 + (h % 13) / 10; // 3.8 .. 5.0
  }

  function initials(name) {
    return String(name || '?')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join('') || '?';
  }

  /** Pick a decorative cover modifier class from a record's text. */
  function coverClass(text) {
    const t = String(text || '').toLowerCase();
    const has = (...words) => words.some((w) => t.includes(w));
    if (has('jungle', 'safari', 'chitwan', 'wildlife', 'forest')) return 'cover--jungle';
    if (has('heritage', 'durbar', 'historical', 'kathmandu', 'patan', 'bhaktapur')) return 'cover--heritage';
    if (has('religious', 'temple', 'yatra', 'muktinath', 'pashupati', 'pilgrim', 'monastery')) return 'cover--temple';
    if (has('island', 'bali', 'beach', 'thailand', 'bangkok', 'phuket', 'maldives')) return 'cover--island';
    if (has('london', 'paris', 'rome', 'tokyo', 'new york', 'dubai', 'city', 'europe', 'international')) return 'cover--city';
    if (has('sunset', 'mustang', 'desert')) return 'cover--sunset';
    return '';
  }

  // ------------------------------------------------------------------
  // Photographs (freely-licensed, sourced from Wikimedia Commons)
  // ------------------------------------------------------------------
  let CREDITS = {};
  let creditsPromise = null;

  /** Load the image credit manifest once; resolves to {} if unavailable. */
  function creditsReady() {
    if (!creditsPromise) {
      creditsPromise = api('/images/credits.json')
        .then((data) => { CREDITS = data || {}; return CREDITS; })
        .catch(() => { CREDITS = {}; return CREDITS; });
    }
    return creditsPromise;
  }

  /** Image path for a slug (e.g. 'pokhara'), or null when none is available. */
  function photo(slug) {
    const c = CREDITS[slug];
    return c && c.file ? c.file : null;
  }

  /** Attribution HTML for a photo — required by its licence. */
  function creditLine(slug) {
    const c = CREDITS[slug];
    if (!c) return '';
    return `<p class="credit">Photo: ${escapeHtml(c.artist)} \u2014 ` +
      `<a href="${escapeHtml(c.source)}" target="_blank" rel="noopener noreferrer">${escapeHtml(c.license)}</a></p>`;
  }

  /**
   * Work out which downloaded photo best matches a record, trying in order:
   *   1. the record's own `image` field
   *   2. the record's `slug`
   *   3. every word of a credit key appearing in the record's text
   * Returns a credit key, or null when nothing matches.
   */
  function resolveSlug(record) {
    if (!record) return null;
    // `cover` is the column blog_posts uses for its image key, so it must be
    // tried alongside `image`/`slug` — otherwise every article card falls back
    // to decorative CSS art even when a matching photo exists.
    for (const cand of [record.image, record.slug, record.cover]) {
      if (cand && CREDITS[cand]) return cand;
    }
    const hay = [record.name, record.title, record.destination, record.region, record.cover]
      .filter(Boolean).join(' ').toLowerCase();
    // Longest keys first so 'annapurna-base-camp' wins over a bare 'base'.
    const keys = Object.keys(CREDITS).sort((a, b) => b.length - a.length);
    for (const key of keys) {
      const words = key.split('-').filter((w) => w.length > 2);
      if (words.length && words.every((w) => hay.includes(w))) return key;
    }
    return null;
  }

  /**
   * Build the markup for a .cover element. Uses a real (freely-licensed) photo
   * when one matches the record; otherwise falls back to decorative CSS art.
   * Returns { cls, html } ready to drop inside `<div class="cover ${cls}">`.
   */
  function coverInner(record, { tag = '', label = '', resolvable = true, eager = true, desti = false, overlay = null } = {}) {
    const slug = resolvable ? resolveSlug(record) : (typeof record === 'string' ? record : null);
    const src = slug ? photo(slug) : null;
    const txt = label || (record && (record.name || record.title)) || '';
    const parts = [];
    if (src) {
      // `loading="lazy"` is great for long pages, but an image far below the
      // fold stays blank until it is scrolled near. Callers that render
      // above-the-fold cards pass eager:true so the photo is visible at once.
      const lazy = eager ? '' : ' loading="lazy"';
      // Root-relative so the photo resolves from any page depth (about.html,
      // packages/x.html …) instead of only from the site root. When a card is
      // embedded on a deeper path a bare "images/…" 404s and the browser paints
      // bare alt text — the exact "text instead of a photo" symptom. Leading
      // "/" keeps every card pointing at the same absolute image URL.
      const abs = src.startsWith('/') ? src : '/' + src;
      // If a photo ever fails to load (a stale cached failed request, a route
      // hiccup, an offline moment) the browser would otherwise paint bare alt
      // text. Retry ONCE with a cache-buster (defeats a poisoned cache entry),
      // then fall back to the decorative CSS art so a card never shows
      // broken/alt-only text.
      const art = coverClass(txt + ' ' + (slug || ''));
      const fail =
        ` onerror="if(!this.dataset.r){this.dataset.r=1;this.src='${abs}?r='+Date.now();}` +
        ` else {var c=this.parentNode;c.classList.remove('cover--photo');` +
        `c.classList.add('${art}');this.style.display='none';}"`;
      parts.push(`<img class="cover__img" src="${escapeHtml(abs)}" alt="${escapeHtml(txt)}"${lazy} decoding="async"${fail}>`);
    }
    if (tag) parts.push(`<span class="cover__tag">${escapeHtml(tag)}</span>`);
    if (txt) parts.push(`<span class="cover__label">${escapeHtml(txt)}</span>`);
    // Reference-style hover panel: a tinted overlay with an "Explore More"
    // button + arrow that slides down from the top edge over the photo.
    // Hover panel: a tinted overlay with a button + arrow that slides down from
    // the top edge over the cover. `desti:true` keeps the original destination
    // behaviour; the generic `overlay` option lets every other card opt in with
    // its own label and link (packages → "Read More", articles → "Read Article"…).
    const ov = desti
      ? { label: 'Explore More', href: record && record.slug ? 'destinations.html?slug=' + encodeURIComponent(record.slug) : 'destinations.html' }
      : overlay;
    if (ov) {
      const label = ov.label || 'View More';
      // With an href the overlay is a link; without one it is a plain span so it
      // can sit inside a parent <button> (gallery tiles open a lightbox) without
      // creating invalid nested-interactive markup.
      const inner =
        `<span>${escapeHtml(label)}</span>` +
        `<span class="desti-arrow" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" ` +
        `stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">` +
        `<path d="M5 12h14M13 6l6 6-6 6"/></svg></span>`;
      const cta = ov.href
        ? `<a class="desti-cta" href="${escapeHtml(ov.href)}">${inner}</a>`
        : `<span class="desti-cta">${inner}</span>`;
      parts.push(`<div class="desti-overlay">${cta}</div>`);
    }
    return {
      cls: src ? 'cover--photo' : coverClass(txt + ' ' + (slug || '')),
      html: parts.join('')
    };
  }

  /**
   * One shared IntersectionObserver for `.reveal` elements, plus a
   * MutationObserver that automatically registers nodes injected later (cards
   * rendered from API data). Without this, async cards stay at opacity:0.
   * Returns the observer so callers can register nodes directly.
   */
  let revealObserver = null;

  function setupReveal() {
    if (typeof document === 'undefined') return null;

    if (!('IntersectionObserver' in window)) {
      document.querySelectorAll('.reveal').forEach((el) => el.classList.add('is-in'));
      // Nothing will be injected lazily with an observer unavailable; flip any
      // future additions immediately so content is never invisible.
      revealObserver = { observe(el) { if (el) el.classList.add('is-in'); } };
      return revealObserver;
    }

    revealObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });

    document.querySelectorAll('.reveal').forEach((el) => revealObserver.observe(el));

    // Catch cards that are injected by innerHTML after the API responds.
    if ('MutationObserver' in window) {
      const mo = new MutationObserver((mutations) => {
        mutations.forEach((m) => {
          m.addedNodes.forEach((node) => {
            if (node.nodeType !== 1) return;
            if (node.classList && node.classList.contains('reveal')) revealObserver.observe(node);
            if (node.querySelectorAll) node.querySelectorAll('.reveal').forEach((el) => revealObserver.observe(el));
          });
        });
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }
    return revealObserver;
  }

  /** Register newly-created reveal nodes (cards) with the shared observer. */
  function observeReveal(root) {
    if (!revealObserver) return;
    const scope = root || document;
    if (scope.classList && scope.classList.contains('reveal')) revealObserver.observe(scope);
    scope.querySelectorAll && scope.querySelectorAll('.reveal').forEach((el) => revealObserver.observe(el));
  }

  /** Show every reveal node immediately (used when a list is fully rendered). */
  function revealAll(root) {
    const scope = root || document;
    scope.querySelectorAll && scope.querySelectorAll('.reveal').forEach((el) => el.classList.add('is-in'));
  }

  function skeletonCards(container, count = 3) {
    if (!container) return;
    container.innerHTML = Array.from({ length: count }).map(() => `
      <div class="card">
        <div class="cover skeleton"></div>
        <div class="card__body">
          <div class="skeleton" style="width:60%;height:20px"></div>
          <div class="skeleton" style="width:100%;height:14px"></div>
          <div class="skeleton" style="width:80%;height:14px"></div>
        </div>
      </div>`).join('');
  }

  function showEmpty(container, message) {
    if (container) container.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
  }

  // ------------------------------------------------------------------
  // Page chrome: mobile nav + scroll reveal + active link
  // ------------------------------------------------------------------
  function initChrome() {
    const toggle = document.querySelector('.nav-toggle');
    const nav = document.querySelector('.nav');
    let backdrop = document.querySelector('.nav-backdrop');
    if (!backdrop && nav) {
      backdrop = document.createElement('div');
      backdrop.className = 'nav-backdrop';
      // The backdrop MUST live inside .site-header. That element is
      // `position:sticky; z-index:60`, so it is its own stacking context:
      // a body-level backdrop (z-index 55) would paint ABOVE the in-header nav
      // drawer and swallow every tap ("Home click does nothing" on mobile).
      const host = nav.closest('.site-header') || document.body;
      host.appendChild(backdrop);
    }
    function close() {
      if (nav) nav.classList.remove('is-open');
      if (backdrop) backdrop.classList.remove('is-open');
    }
    if (toggle && nav) {
      toggle.addEventListener('click', () => {
        const open = nav.classList.toggle('is-open');
        if (backdrop) backdrop.classList.toggle('is-open', open);
      });
    }
    if (backdrop) backdrop.addEventListener('click', close);
    if (nav) nav.querySelectorAll('a').forEach((a) => a.addEventListener('click', close));

    // Highlight the current page in the nav.
    const path = location.pathname.replace(/\/+$/, '') || '/index.html';
    document.querySelectorAll('.nav a[href]').forEach((a) => {
      const href = a.getAttribute('href');
      if (href && (href === path || (path.endsWith('index.html') && href === 'index.html'))) {
        a.classList.add('is-active');
      }
    });

    // Reveal-on-scroll.
    //
    // Cards are injected by innerHTML AFTER the API responds, so a one-shot
    // pass over `.reveal` at DOMContentLoaded leaves every async card stuck at
    // opacity:0 forever (the "my home page shows no cards" bug). A single
    // shared observer is therefore exposed as App.observeReveal() so renderers
    // can register newly-injected nodes, and a MutationObserver catches anything
    // that forgets to call it.
    setupReveal();

    // Footer year.
    document.querySelectorAll('[data-year]').forEach((el) => { el.textContent = new Date().getFullYear(); });

    // Newsletter form (present in the footer on every page).
    const nl = document.getElementById('newsletter-form');
    if (nl) {
      nl.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = nl.querySelector('input[type="email"]');
        try {
          await api('/api/newsletter', { method: 'POST', body: { email: input.value } });
          toast('Subscribed \u2014 thank you!', 'ok');
          input.value = '';
        } catch (err) {
          toast(err.message, 'err');
        }
      });
    }
  }

  /**
   * Wire a list toolbar: text search over an element's data and a sort select.
   * Generic and additive — callers pass the data array and a render callback,
   * so no view has to duplicate filtering logic. Returns nothing; re-renders
   * through the supplied `render` whenever the query/sort changes.
   */
  function wireToolbar(opts) {
    const { searchId, sortId, getItems, render, searchKeys } = opts;
    const search = searchId && document.getElementById(searchId);
    const sort = sortId && document.getElementById(sortId);
    if (!search && !sort) return;
    const apply = () => {
      let items = getItems() || [];
      const q = (search && search.value ? search.value : '').trim().toLowerCase();
      if (q) {
        const keys = searchKeys || ['title', 'name', 'destination', 'region', 'description', 'summary'];
        items = items.filter((it) => keys.some((k) => String(it[k] || '').toLowerCase().includes(q)));
      }
      const mode = sort && sort.value ? sort.value : '';
      if (mode === 'name') items = items.slice().sort((a, b) => String(a.title || a.name || '').localeCompare(String(b.title || b.name || '')));
      if (mode === 'price-asc') items = items.slice().sort((a, b) => (Number(a.price) || 0) - (Number(b.price) || 0));
      if (mode === 'price-desc') items = items.slice().sort((a, b) => (Number(b.price) || 0) - (Number(a.price) || 0));
      if (mode === 'rating') items = items.slice().sort((a, b) => ratingFor(b) - ratingFor(a));
      render(items, q);
    };
    if (search) search.addEventListener('input', apply);
    if (sort) sort.addEventListener('change', apply);
    return apply;
  }

  /** Inject a "back to top" button once, and toggle it on scroll. */
  function mountBackToTop() {
    if (typeof document === 'undefined' || document.getElementById('to-top')) return;
    const b = document.createElement('button');
    b.id = 'to-top';
    b.type = 'button';
    b.className = 'to-top';
    b.setAttribute('aria-label', 'Back to top');
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
    b.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    document.body.appendChild(b);
    const onScroll = () => { b.classList.toggle('is-on', window.scrollY > 500); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /** Animate a number from 0 to its target when it first scrolls into view. */
  function countUp(el, target, ms = 1200) {
    if (!el) return;
    const dur = Math.max(300, ms);
    const start = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = String(Math.round(target * eased));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // Guarded so the module does not throw if ever evaluated outside a browser.
  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', initChrome);
    document.addEventListener('DOMContentLoaded', mountBackToTop);
  }

  return {
    api, toast, escapeHtml, money, discountPrice, formatDate, stars, initials,
    coverClass, skeletonCards, showEmpty, starsHtml, ratingFor, countUp, wireToolbar,
    creditsReady, photo, creditLine, coverInner, resolveSlug,
    setupReveal, observeReveal, revealAll
  };
})();

// Assign AFTER the IIFE has fully finished building the object. Assigning it
// inside would hit the temporal dead zone ("Cannot access 'App' before
// initialization") and abort the whole script, leaving every page unstyled.
if (typeof window !== 'undefined') {
  window.App = App;
}

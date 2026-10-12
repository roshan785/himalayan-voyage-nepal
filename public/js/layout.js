'use strict';

/**
 * Injects the shared header and footer into #site-header / #site-footer so the
 * chrome stays identical across every page. Loaded before main.js.
 */

(function () {
  const PHONE = '+977 9800000000';
  const EMAIL = 'hello@himalayanvoyage.test';
  const ADDRESS = 'Lakeside Road, Pokhara, Nepal';

  // Build stamp of THIS script (?v=...). Captured at parse time because
  // document.currentScript is only set during synchronous execution — it is
  // already null by the time DOMContentLoaded fires.
  const SELF_VERSION = (function () {
    try {
      const src = document.currentScript && document.currentScript.src;
      const m = src && src.match(/\?v=[^&]+/);
      return m ? m[0] : '';
    } catch (_err) { return ''; }
  })();

  // Primary navigation. `children` renders a hover/click sub-menu (the same
  // pattern the reference layout uses for About and Visa).
  const NAV = [
    { href: 'index.html', label: 'Home' },
    {
      href: 'about.html', label: 'About',
      children: [
        { href: 'about.html#story', label: 'About Company' },
        { href: 'team.html', label: 'Team Members' },
        { href: 'ceo.html', label: 'Message From CEO' }
      ]
    },
    { href: 'gallery.html', label: 'Gallery' },
    { href: 'services.html', label: 'Services' },
    { href: 'packages.html', label: 'Packages' },
    { href: 'destinations.html', label: 'Destinations' },
    {
      href: 'visa.html', label: 'Visa',
      children: [
        { href: 'visa-usa.html', label: 'America Visa' },
        { href: 'visa-bali.html', label: 'Bali Visa' },
        { href: 'visa-canada.html', label: 'Canada Visa' },
        { href: 'visa-china.html', label: 'China Visa' },
        { href: 'visa-europe.html', label: 'Europe Visa' },
        { href: 'visa-hong-kong.html', label: 'Hong Kong Visa' },
        { href: 'visa-japan.html', label: 'Japan Visa' },
        { href: 'visa-malaysia.html', label: 'Malaysia Visa' },
        { href: 'visa-thailand.html', label: 'Thailand Visa' },
        { href: 'visa-turkey.html', label: 'Turkey Visa' },
        { href: 'visa-uk.html', label: 'UK Visa' },
        { href: 'visa-australia.html', label: 'Australia Visa' }
      ]
    },
    { href: 'blogs.html', label: 'Blogs' },
    { href: 'documents.html', label: 'Documents' },
    { href: 'faq.html', label: 'FAQ' },
    { href: 'contact.html', label: 'Contact Us' }
  ];

  const ICON = {
    mountain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20l6-11 4 6 3-4 5 9z"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2 4.2 2 2 0 0 1 4 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.1a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>',
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>'
  };

  function header() {
    const links = NAV.map((n) => {
      if (!n.children) return `<a href="${n.href}">${n.label}</a>`;
      const sub = n.children.map((c) => `<a href="${c.href}">${c.label}</a>`).join('');
      return `<div class="nav-item has-sub">` +
        `<a href="${n.href}" class="nav-item__link">${n.label}<span class="caret" aria-hidden="true"></span></a>` +
        `<div class="submenu">${sub}</div>` +
        `</div>`;
    }).join('');
    return `
    <div class="topbar">
      <div class="wrap">
        <div class="topbar__meta">
          <span>${ICON.pin} ${ADDRESS}</span>
          <a href="tel:${PHONE.replace(/\s/g, '')}">${PHONE}</a>
          <a href="mailto:${EMAIL}">${EMAIL}</a>
        </div>
        <div class="topbar__social">
          <a href="https://facebook.com/himalayanvoyage" aria-label="Facebook">Facebook</a>
          <a href="https://instagram.com/himalayanvoyage" aria-label="Instagram">Instagram</a>
          <a href="https://youtube.com/@himalayanvoyage" aria-label="YouTube">YouTube</a>
          <a href="https://x.com/himalayanvoyage" aria-label="X">X</a>
          <a href="https://tiktok.com/@himalayanvoyage" aria-label="TikTok">TikTok</a>
        </div>
      </div>
    </div>
    <header class="site-header">
      <div class="wrap site-header__inner">
        <a class="brand" href="index.html">
          <span class="brand__mark">${ICON.mountain}</span>
          <span class="brand__text">Himalayan Voyage<small>Nepal</small></span>
        </a>
        <nav class="nav" id="primary-nav" aria-label="Primary">${links}
          <a class="btn btn--accent btn--sm nav__cta" href="contact.html">Contact Now</a>
        </nav>
        <button class="nav-toggle" aria-label="Toggle navigation" aria-controls="primary-nav">
          <span></span><span></span><span></span>
        </button>
      </div>
    </header>`;
  }

  function footer() {
    return `
    <footer class="site-footer">
      <div class="wrap">
        <div class="footer-grid">
          <div>
            <div class="footer-brand"><span class="brand__mark">${ICON.mountain}</span> Himalayan Voyage Nepal</div>
            <p class="small">Discover Nepal and international destinations with expertly crafted travel experiences. Tours, trekking, adventure and visa support \u2014 handled end to end.</p>
            <p class="small"><strong>Contact:</strong> ${PHONE}<br><strong>Location:</strong> ${ADDRESS}<br><strong>Email:</strong> ${EMAIL}</p>
          </div>
          <div>
            <h4>Quick Links</h4>
            <ul class="footer-links">
              <li><a href="about.html">About Us</a></li>
              <li><a href="team.html">Our Team</a></li>
              <li><a href="packages.html">Packages</a></li>
              <li><a href="services.html">Services</a></li>
              <li><a href="visa.html">Visa Services</a></li>
              <li><a href="documents.html">Documents</a></li>
              <li><a href="faq.html">FAQs</a></li>
              <li><a href="contact.html">Contact</a></li>
            </ul>
          </div>
          <div>
            <h4>Visa Destinations</h4>
            <ul class="footer-links">
              <li><a href="visa-usa.html">America Visa</a></li>
              <li><a href="visa-uk.html">UK Visa</a></li>
              <li><a href="visa-canada.html">Canada Visa</a></li>
              <li><a href="visa-europe.html">Europe Visa</a></li>
              <li><a href="visa-japan.html">Japan Visa</a></li>
              <li><a href="visa-australia.html">Australia Visa</a></li>
            </ul>
          </div>
          <div>
            <h4>Popular Packages</h4>
            <ul class="footer-links">
              <li><a href="packages.html?category=domestic">Pokhara Leisure Tour</a></li>
              <li><a href="packages.html?category=international">Thailand Holiday</a></li>
              <li><a href="packages.html?category=trekking">Annapurna Base Camp</a></li>
              <li><a href="packages.html?category=historical">Kathmandu Heritage</a></li>
            </ul>
          </div>
          <div>
            <h4>Social Media</h4>
            <ul class="footer-links">
              <li><a href="https://facebook.com/himalayanvoyage">Facebook</a></li>
              <li><a href="https://instagram.com/himalayanvoyage">Instagram</a></li>
              <li><a href="https://youtube.com/@himalayanvoyage">YouTube</a></li>
              <li><a href="https://x.com/himalayanvoyage">X (Twitter)</a></li>
              <li><a href="https://tiktok.com/@himalayanvoyage">TikTok</a></li>
            </ul>
            <h4 style="margin-top:16px">Newsletter</h4>
            <form id="newsletter-form" class="form" style="gap:8px">
              <input type="email" required placeholder="you@example.com" aria-label="Email address"
                style="padding:.6rem .75rem;border:0;border-radius:9px;font:inherit;font-size:.85rem">
              <button class="btn btn--accent btn--sm" type="submit">Subscribe</button>
            </form>
          </div>
        </div>
        <div class="footer-bottom">
          <span>&copy; <span data-year>2026</span> Himalayan Voyage Nepal. All rights reserved.</span>
          <span>Original demonstration site \u2014 content and design are not copied from any third party.</span>
        </div>

        <details class="footer-credits" style="margin:10px 0 0">
          <summary style="cursor:pointer;font-size:.78rem;color:#8ea0ba">Photo credits &amp; licences</summary>
          <div id="photo-credits" style="margin-top:10px"></div>
        </details>
      </div>
    </footer>`;
  }

  function mount() {
    const h = document.getElementById('site-header');
    const f = document.getElementById('site-footer');
    if (h) h.innerHTML = header();
    if (f) f.innerHTML = footer();
    loadCredits();
  }

  /**
   * Render the photo-attribution list. Every CC-licensed image on the site must
   * credit its author and licence — this satisfies that requirement.
   */
  function loadCredits() {
    const box = document.getElementById('photo-credits');
    if (!box || !window.App || !window.App.creditsReady) return;
    window.App.creditsReady().then((credits) => {
      const rows = Object.entries(credits || {}).map(([slug, c]) =>
        `<li>${c.file ? `<b>${slug}</b>: ` : ''}${c.artist} \u2014 ` +
        `<a href="${c.source}" target="_blank" rel="noopener noreferrer">${c.license}</a></li>`
      );
      box.innerHTML = rows.length
        ? `<ul class="credits-list" style="list-style:none;padding:0;margin:0">${rows.join('')}</ul>`
        : '<span class="small">No photos loaded.</span>';
    });
  }

  /** Load the travel-assistant chat widget on every page (idempotent).
   *  The ?v= stamp is copied from THIS script's own URL, so an upgraded widget
   *  is never served from a stale cache (js is served immutable for a year). */
  function loadChatWidget() {
    if (document.getElementById('chat-fab')) return;
    const s = document.createElement('script');
    s.src = 'js/chat-widget.js' + SELF_VERSION;
    s.defer = true;
    document.body.appendChild(s);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => { mount(); loadChatWidget(); });
    } else {
      mount();
      loadChatWidget();
    }
  }
})();

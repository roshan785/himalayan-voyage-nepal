'use strict';

/**
 * Injects the shared header and footer into #site-header / #site-footer so the
 * chrome stays identical across every page. Loaded before main.js.
 */

(function () {
  const PHONE = '+977 9768565481';
  const EMAIL = 'info@industravelnepal.com';
  const ADDRESS = 'Sinamangal-9, Kathmandu, Nepal';

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
    { href: 'faq.html', label: 'FAQ' },
    { href: 'contact.html', label: 'Contact Us' }
  ];

  const ICON = {
    mountain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20l6-11 4 6 3-4 5 9z"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2 4.2 2 2 0 0 1 4 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.1a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>',
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    facebook: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M22 12a10 10 0 1 0-11.6 9.9v-7H7.9V12h2.5V9.8c0-2.5 1.5-3.9 3.8-3.9 1.1 0 2.2.2 2.2.2v2.4h-1.2c-1.2 0-1.6.8-1.6 1.6V12h2.7l-.4 2.9h-2.3v7A10 10 0 0 0 22 12z"/></svg>',
    instagram: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>',
    youtube: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23 12s0-3.3-.4-4.9a2.5 2.5 0 0 0-1.7-1.8C19.2 5 12 5 12 5s-7.2 0-8.9.3A2.5 2.5 0 0 0 1.4 7.1C1 8.7 1 12 1 12s0 3.3.4 4.9a2.5 2.5 0 0 0 1.7 1.8C4.8 19 12 19 12 19s7.2 0 8.9-.3a2.5 2.5 0 0 0 1.7-1.8C23 15.3 23 12 23 12zM10 15.5v-7l6 3.5z"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.9 2H22l-7.6 8.7L23 22h-6.8l-5.3-7-6.1 7H1.7l8.2-9.3L1 2h7l4.8 6.3zM17.8 20h1.7L7.3 3.9H5.5z"/></svg>',
    tiktok: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.5 3c.3 2.2 1.6 3.6 3.7 3.9v2.5c-1.4.1-2.7-.3-3.9-1v6.3c0 3.4-2.6 5.9-5.9 5.4-2.6-.4-4.4-2.6-4.2-5.2.2-2.7 2.5-4.7 5.2-4.5.3 0 .6 0 .9.1v2.6c-.3-.1-.6-.2-.9-.2-1.4-.1-2.5 1-2.4 2.3.1 1.2 1.1 2.1 2.3 2.1 1.3 0 2.3-1 2.3-2.4V3z"/></svg>'
  };

  // Social profiles — rendered as an icon row (footer) so the networks show as
  // logos, matching the reference layout.
  const SOCIAL = [
    { key: 'facebook', href: 'https://facebook.com/himalayanvoyage', label: 'Facebook' },
    { key: 'instagram', href: 'https://instagram.com/himalayanvoyage', label: 'Instagram' },
    { key: 'youtube', href: 'https://youtube.com/@himalayanvoyage', label: 'YouTube' },
    { key: 'x', href: 'https://x.com/himalayanvoyage', label: 'X (Twitter)' },
    { key: 'tiktok', href: 'https://tiktok.com/@himalayanvoyage', label: 'TikTok' }
  ];

  const socialRow = () => SOCIAL.map((s) =>
    `<a class="social-icon" href="${s.href}" target="_blank" rel="noopener noreferrer" aria-label="${s.label}" title="${s.label}">${ICON[s.key]}</a>`
  ).join('');

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
          ${socialRow()}
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
            <h4>Social Media Links</h4>
            <div class="social-links">${socialRow()}</div>
            <h4 style="margin-top:16px">Newsletter</h4>
            <form id="newsletter-form" class="form" style="gap:8px">
              <input type="email" required placeholder="you@example.com" aria-label="Email address"
                style="padding:.6rem .75rem;border:0;border-radius:9px;font:inherit;font-size:.85rem">
              <button class="btn btn--accent btn--sm" type="submit">Subscribe</button>
            </form>
          </div>
        </div>
        <div class="logo-row" aria-label="Affiliations">
          <span class="logo-row__label">Affiliated With:</span>
          <a class="logo-badge" href="https://www.iso.org/" target="_blank" rel="noopener noreferrer" aria-label="ISO certified" title="ISO certified">
            <span class="logo-badge__abbr">ISO</span><span class="logo-badge__cap">Certified</span>
          </a>
          <a class="logo-badge" href="https://ntb.gov.np/" target="_blank" rel="noopener noreferrer" aria-label="Nepal Tourism Board" title="Nepal Tourism Board">
            <span class="logo-badge__abbr">NTB</span><span class="logo-badge__cap">Nepal Tourism</span>
          </a>
          <a class="logo-badge" href="https://natta.org.np/" target="_blank" rel="noopener noreferrer" aria-label="NATTA" title="Nepal Association of Tour &amp; Travel Agents">
            <span class="logo-badge__abbr">NATTA</span><span class="logo-badge__cap">Tour &amp; Travel</span>
          </a>
          <a class="logo-badge" href="https://www.iata.org/" target="_blank" rel="noopener noreferrer" aria-label="IATA" title="International Air Transport Association">
            <span class="logo-badge__abbr">IATA</span><span class="logo-badge__cap">Air Transport</span>
          </a>
          <a class="logo-badge" href="https://www.nrb.org.np/" target="_blank" rel="noopener noreferrer" aria-label="Nepal Rastra Bank" title="Nepal Rastra Bank (central bank)">
            <span class="logo-badge__abbr">NRB</span><span class="logo-badge__cap">Nepal Rastra Bank</span>
          </a>
          <a class="logo-badge" href="https://nepal.gov.np/" target="_blank" rel="noopener noreferrer" aria-label="Government of Nepal" title="Government of Nepal">
            <span class="logo-badge__abbr">GoN</span><span class="logo-badge__cap">Govt. of Nepal</span>
          </a>
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

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mount);
    } else {
      mount();
    }
  }
})();

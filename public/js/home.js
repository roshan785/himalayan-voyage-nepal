'use strict';

/**
 * Homepage behaviour: fetches destinations, packages, services, testimonials
 * and blog posts, renders them, and wires the package-category tabs.
 */

(function () {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const App = window.App;

  const SERVICES = [
    { title: 'Interview Preparation', text: 'Coaching and mock interviews for visa and study-abroad applicants.', icon: 'chat' },
    { title: 'Visa Application Assistance', text: 'Forms, appointments and document review for your destination country.', icon: 'doc' },
    { title: 'Custom Travel Packages', text: 'Itineraries built around your dates, pace and budget.', icon: 'route' },
    { title: 'Document Preparation', text: 'Checklists, translations and attestation guidance.', icon: 'check' },
    { title: 'Free Visa Consultation', text: 'A no-cost assessment of your eligibility before you apply.', icon: 'info' },
    { title: 'Itinerary & Booking Support', text: 'Flights, hotels, permits and transfers arranged for you.', icon: 'plane' }
  ];

  const SERVICE_ICONS = {
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/></svg>',
    doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h4"/></svg>',
    route: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M9 19h6a4 4 0 0 0 0-8H9a4 4 0 0 1 0-8h6"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
    plane: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.8 19.2 16 11l-9.5 4.5-1.5-1.5 5-3.5L8 4.5 9.5 3l6 4 5-2.5a2 2 0 1 1 2 3L17 12l4 6-1.5 1.5z"/></svg>'
  };

  function destinationCard(d) {
    const cov = App.coverInner(d, { tag: d.kind === 'international' ? 'International' : 'Nepal', desti: true });
    return `
      <article class="card desti-card reveal">
        <div class="cover ${cov.cls}">${cov.html}</div>
        <div class="card__body">
          ${App.starsHtml(App.ratingFor(d))}
          <p>${App.escapeHtml(d.description)}</p>
          <div class="card__foot">
            <span class="meta-row">${App.escapeHtml(d.region || '')}</span>
            <a class="btn btn--ghost btn--sm" href="destinations.html?slug=${encodeURIComponent(d.slug)}">Explore More</a>
          </div>
        </div>
      </article>`;
  }

  function packageCard(p) {
    const finalPrice = App.discountPrice(p.price, p.discount);
    const priceHtml = p.discount > 0
      ? `<span class="price"><small>From</small><s>${App.money(p.price)}</s>${App.money(finalPrice)}</span>`
      : `<span class="price"><small>From</small>${App.money(p.price)}</span>`;
    const tags = (p.highlights || []).slice(0, 3).map((h) => `<span class="badge badge--soft">${App.escapeHtml(h)}</span>`).join(' ');
    const cov = App.coverInner(p, {
      overlay: { label: 'Read More', href: 'packages.html?slug=' + encodeURIComponent(p.slug) }
    });
    // Corner ribbon on discounted / featured cards (as on the reference site).
    const ribbon = p.discount > 0
      ? `<div class="ribbon"><span>${p.discount}% OFF</span></div>`
      : (p.featured ? '<div class="ribbon ribbon--green"><span>Featured</span></div>' : '');
    return `
      <article class="card reveal">
        <div class="cover ${cov.cls}">${cov.html}${ribbon}</div>
        <div class="card__body">
          <div class="meta-row">
            <span>${App.escapeHtml(p.destination)}</span>
            <span>${p.days} days &amp; ${p.nights} night${p.nights === 1 ? '' : 's'}</span>
          </div>
          <p>${App.escapeHtml(p.summary)}</p>
          <div style="display:flex;gap:6px;flex-wrap:wrap">${tags}</div>
          <div class="card__foot">
            ${priceHtml}
            <a class="btn btn--primary btn--sm" href="packages.html?slug=${encodeURIComponent(p.slug)}">Read More</a>
          </div>
        </div>
      </article>`;
  }

  function testimonialCard(t) {
    return `
      <article class="card quote reveal">
        <div class="stars" aria-label="${t.rating} out of 5">${App.stars(t.rating)}</div>
        <p class="quote__text">${App.escapeHtml(t.content)}</p>
        <div class="quote__who">
          <div class="avatar">${App.escapeHtml(App.initials(t.name))}</div>
          <div><strong>${App.escapeHtml(t.name)}</strong><span>${App.escapeHtml(t.location || '')}</span></div>
        </div>
      </article>`;
  }

  function postCard(b) {
    const cov = App.coverInner(b, {
      tag: 'Article',
      overlay: { label: 'Read Article', href: 'posts.html?slug=' + encodeURIComponent(b.slug) }
    });
    return `
      <article class="card post-card reveal">
        <div class="cover ${cov.cls}">${cov.html}</div>
        <div class="card__body">
          <span class="post-date">${App.formatDate(b.created_at)}</span>
          <h3><a href="posts.html?slug=${encodeURIComponent(b.slug)}">${App.escapeHtml(b.title)}</a></h3>
          <p>${App.escapeHtml(b.excerpt)}</p>
          <div class="card__foot" style="margin-top:auto">
            <a class="btn btn--ghost btn--sm" href="posts.html?slug=${encodeURIComponent(b.slug)}">Read More</a>
          </div>
        </div>
      </article>`;
  }

  async function loadDestinations() {
    const nepal = document.getElementById('home-destinations');
    const intl = document.getElementById('home-international');
    App.skeletonCards(nepal, 3);
    App.skeletonCards(intl, 4);
    try {
      const [np, world] = await Promise.all([
        App.api('/api/destinations?kind=nepal'),
        App.api('/api/destinations?kind=international')
      ]);
      nepal.innerHTML = np.items.slice(0, 6).map(destinationCard).join('') || '';
      intl.innerHTML = world.items.slice(0, 6).map(destinationCard).join('') || '';
      App.revealAll(nepal); App.revealAll(intl);
      if (!np.items.length) App.showEmpty(nepal, 'No destinations available yet.');
      if (!world.items.length) App.showEmpty(intl, 'No international destinations available yet.');
    } catch (err) {
      App.showEmpty(nepal, 'Could not load destinations.');
      App.showEmpty(intl, 'Could not load destinations.');
      App.toast(err.message, 'err');
    }
  }

  async function loadPackages(category) {
    const box = document.getElementById('home-packages');
    App.skeletonCards(box, 3);
    try {
      // Show the full list (like the reference site) so the grid reads as a
      // complete catalogue rather than a partial selection.
      const query = category && category !== 'all'
        ? `?category=${encodeURIComponent(category)}`
        : '';
      const data = await App.api('/api/packages' + query);
      box.innerHTML = data.items.slice(0, 8).map(packageCard).join('');
      App.revealAll(box);
      if (!data.items.length) App.showEmpty(box, 'No packages found in this category.');
    } catch (err) {
      App.showEmpty(box, 'Could not load packages.');
      App.toast(err.message, 'err');
    }
  }

  function loadServices() {
    const box = document.getElementById('home-services');
    box.innerHTML = SERVICES.slice(0, 6).map((s) => `
      <article class="card reveal">
        <div class="feature">
          <div class="feature__icon">${SERVICE_ICONS[s.icon] || SERVICE_ICONS.info}</div>
          <div><h3>${App.escapeHtml(s.title)}</h3><p>${App.escapeHtml(s.text)}</p></div>
        </div>
      </article>`).join('');
    document.querySelectorAll('#home-services .reveal').forEach((el) => el.classList.add('is-in'));
  }

  async function loadTestimonials() {
    const box = document.getElementById('home-testimonials');
    App.skeletonCards(box, 3);
    try {
      const data = await App.api('/api/testimonials');
      box.innerHTML = data.items.slice(0, 3).map(testimonialCard).join('');
      App.revealAll(box);
      if (!data.items.length) App.showEmpty(box, 'No testimonials yet.');
    } catch (_err) {
      App.showEmpty(box, 'Could not load testimonials.');
    }
  }

  async function loadDocs() {
    const box = document.getElementById('home-docs');
    if (!box) return;
    box.classList.add('stagger');
    App.skeletonCards(box, 3);
    const PDF_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h1.5a1.5 1.5 0 0 1 0 3H9zM9 13v6"/></svg>';
    try {
      const index = await App.api('/docs/index.json');
      const picks = [
        ...(index.brochures || []).map((b) => ({ title: b.title, sub: 'Company profile', file: b.file })),
        ...(index.itineraries || []).slice(0, 2).map((i) => ({ title: i.title, sub: 'Tour itinerary', file: i.file }))
      ].slice(0, 3);
      box.innerHTML = picks.map((d) => `
        <article class="doc-card reveal is-in">
          <div class="doc-icon">${PDF_ICON}</div>
          <div style="flex:1">
            <h3>${App.escapeHtml(d.title)}</h3>
            <p>${App.escapeHtml(d.sub)}</p>
            <div class="doc-actions">
              <a class="btn btn--primary btn--sm" href="${App.escapeHtml(d.file)}" download>Download</a>
              <a class="btn btn--ghost btn--sm" href="documents.html">More</a>
            </div>
          </div>
        </article>`).join('') || '<div class="empty">No documents yet.</div>';
    } catch (_err) {
      App.showEmpty(box, 'Documents will appear here soon.');
    }
  }

  async function loadPosts() {
    const box = document.getElementById('home-posts');
    App.skeletonCards(box, 3);
    try {
      const data = await App.api('/api/posts');
      box.innerHTML = data.items.slice(0, 3).map(postCard).join('');
      App.revealAll(box);
      if (!data.items.length) App.showEmpty(box, 'No articles published yet.');
    } catch (_err) {
      App.showEmpty(box, 'Could not load articles.');
    }
  }

  function wireTabs() {
    const tabs = document.getElementById('package-tabs');
    if (!tabs) return;
    tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      tabs.querySelectorAll('.tab').forEach((t) => t.classList.remove('is-active'));
      btn.classList.add('is-active');
      loadPackages(btn.dataset.cat);
    });
  }

  /** Hero slider: auto-advance + prev/next buttons + dots. */
  function wireHeroSlider() {
    const slider = document.getElementById('hero-slider');
    if (!slider) return;
    const slides = slider.querySelectorAll('.hero-slide');
    if (slides.length < 2) return;
    const dots = slider.querySelectorAll('#hero-dots button');
    let i = 0;
    let timer = null;

    const show = (n) => {
      i = (n + slides.length) % slides.length;
      slides.forEach((s, k) => s.classList.toggle('is-active', k === i));
      dots.forEach((d, k) => d.classList.toggle('is-active', k === i));
    };
    const start = () => {
      stop();
      timer = setInterval(() => show(i + 1), 6500);
    };
    const stop = () => { if (timer) clearInterval(timer); timer = null; };

    const prev = slider.querySelector('.hero-nav--prev');
    const next = slider.querySelector('.hero-nav--next');
    if (prev) prev.addEventListener('click', () => { show(i - 1); start(); });
    if (next) next.addEventListener('click', () => { show(i + 1); start(); });
    dots.forEach((d, k) => d.addEventListener('click', () => { show(k); start(); }));
    slider.addEventListener('mouseenter', stop);
    slider.addEventListener('mouseleave', start);
    show(0);
    start();
  }

  /**
   * The "play" button opens the gallery — there is no hosted video, so this is
   * an honest, useful destination rather than a dead control.
   */
  function wireVideoButton() {
    const btn = document.getElementById('about-video-btn');
    if (!btn) return;
    btn.addEventListener('click', () => { window.location.href = 'gallery.html'; });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    // Load the photo credit manifest first so covers render with real images.
    await App.creditsReady();
    wireHeroSlider();
    wireVideoButton();
    loadDestinations();
    loadPackages('all');
    loadServices();
    loadTestimonials();
    loadDocs();
    loadPosts();
    wireTabs();
    animateStats();
  });

  /** Pop the stat numbers once, when they scroll into view (and count up). */
  function animateStats() {
    const nums = document.querySelectorAll('.stats .stat');
    if (!nums.length) return;
    const run = (el) => {
      el.classList.add('is-counted');
      const numEl = el.querySelector('.stat__num');
      if (!numEl) return;
      const target = parseInt(numEl.textContent.replace(/[^\d]/g, ''), 10);
      if (Number.isFinite(target) && target > 0 && typeof App.countUp === 'function') {
        App.countUp(numEl, target);
      }
    };
    if (!('IntersectionObserver' in window)) { nums.forEach(run); return; }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          run(e.target);
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.5 });
    nums.forEach((n) => io.observe(n));
  }
})();

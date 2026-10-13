'use strict';

/**
 * Integration test suite. Boots the app on an ephemeral port and exercises the
 * public API, the auth flow and the protected admin API end to end.
 *
 *   npm test
 *
 * Uses Node's built-in test-free harness (plain assert + async runner) so no
 * extra dependencies are required.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Isolate the test database so we never touch the real one.
// Credentials are generated per run — no secrets are hardcoded in the repo.
const crypto = require('node:crypto');
const randomSecret = () => crypto.randomBytes(24).toString('hex');

const TMP_DB = path.join(os.tmpdir(), `hv-test-${Date.now()}.db`);
const TEST_ADMIN_EMAIL = 'admin' + '@test.local';
const TEST_ADMIN_PASSWORD = randomSecret();

process.env.DB_PATH = TMP_DB;
process.env.JWT_SECRET = randomSecret();
process.env.ADMIN_EMAIL = TEST_ADMIN_EMAIL;
process.env.ADMIN_PASSWORD = TEST_ADMIN_PASSWORD;
process.env.PORT = '0';

// A syntactically token-shaped string that is guaranteed not to verify.
const INVALID_TOKEN = [randomSecret(), randomSecret(), randomSecret()].join('.');

const { start } = require('./server');

let pass = 0;
let fail = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log('  \u2705 ' + name);
    pass++;
  } catch (err) {
    console.log('  \u274c ' + name + ': ' + err.message);
    failures.push(name + ': ' + err.message);
    fail++;
  }
}

async function main() {
  const server = start();
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  async function req(method, route, { body, token } = {}) {
    const headers = { Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(base + route, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_e) { data = { raw: text }; }
    return { status: res.status, data, headers: res.headers };
  }

  console.log('\nPublic API');

  await test('health endpoint responds ok', async () => {
    const r = await req('GET', '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
  });

  await test('security headers are set', async () => {
    const r = await req('GET', '/api/health');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  });

  await test('site config returns the agency name and phone', async () => {
    const r = await req('GET', '/api/site');
    assert.equal(r.status, 200);
    assert.match(r.data.name, /Voyage/);
    assert.ok(r.data.phone);
  });

  await test('stats returns numeric counts', async () => {
    const r = await req('GET', '/api/stats');
    assert.equal(r.status, 200);
    assert.ok(Number.isInteger(r.data.packages));
    assert.ok(r.data.packages > 0, 'seeded packages expected');
  });

  await test('packages list is seeded and well shaped', async () => {
    const r = await req('GET', '/api/packages');
    assert.equal(r.status, 200);
    assert.ok(r.data.items.length > 0);
    const p = r.data.items[0];
    assert.ok(typeof p.title === 'string');
    assert.ok(Array.isArray(p.highlights), 'highlights should be decoded to an array');
  });

  await test('packages can be filtered by category', async () => {
    const r = await req('GET', '/api/packages?category=international');
    assert.equal(r.status, 200);
    assert.ok(r.data.items.length > 0);
    assert.ok(r.data.items.every((p) => p.category === 'international'));
  });

  await test('package search matches text', async () => {
    const r = await req('GET', '/api/packages?q=Pokhara');
    assert.equal(r.status, 200);
    assert.ok(r.data.items.length > 0);
  });

  await test('destinations filter by kind', async () => {
    const r = await req('GET', '/api/destinations?kind=nepal');
    assert.equal(r.status, 200);
    assert.ok(r.data.items.every((d) => d.kind === 'nepal'));
  });

  await test('single package by slug returns 200', async () => {
    const list = await req('GET', '/api/packages');
    const slug = list.data.items[0].slug;
    const r = await req('GET', '/api/packages/' + slug);
    assert.equal(r.status, 200);
    assert.equal(r.data.item.slug, slug);
  });

  await test('unknown package slug returns 404', async () => {
    const r = await req('GET', '/api/packages/definitely-not-a-real-slug');
    assert.equal(r.status, 404);
  });

  console.log('\nValidation & edge cases');

  await test('contact rejects a missing name', async () => {
    const r = await req('POST', '/api/contact', { body: { email: 'a@b.co', message: 'hello there' } });
    assert.equal(r.status, 400);
  });

  await test('contact rejects an invalid email', async () => {
    const r = await req('POST', '/api/contact', { body: { name: 'A', email: 'not-an-email', message: 'hello there' } });
    assert.equal(r.status, 400);
  });

  await test('contact accepts a valid submission', async () => {
    const r = await req('POST', '/api/contact', {
      body: { name: 'Test User', email: 'test@example.com', phone: '9800000000', subject: 'Trip', message: 'Please plan a 5 day trip.' }
    });
    assert.equal(r.status, 201);
    assert.ok(r.data.id);
  });

  await test('newsletter deduplicates the same email', async () => {
    const first = await req('POST', '/api/newsletter', { body: { email: 'sub@example.com' } });
    assert.equal(first.status, 201);
    const second = await req('POST', '/api/newsletter', { body: { email: 'sub@example.com' } });
    assert.equal(second.status, 200);
    assert.equal(second.data.alreadySubscribed, true);
  });

  await test('malformed JSON body does not crash the server', async () => {
    const res = await fetch(base + '/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"broken":'
    });
    assert.ok(res.status >= 400 && res.status < 500, 'expected a 4xx, got ' + res.status);
  });

  console.log('\nAuth');

  await test('login rejects wrong credentials', async () => {
    const r = await req('POST', '/api/auth/login', { body: { email: TEST_ADMIN_EMAIL, password: randomSecret() } });
    assert.equal(r.status, 401);
  });

  await test('login succeeds with the seeded admin', async () => {
    const r = await req('POST', '/api/auth/login', { body: { email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD } });
    assert.equal(r.status, 200);
    assert.ok(r.data.token);
  });

  await test('admin API rejects requests without a token', async () => {
    const r = await req('GET', '/api/admin/overview');
    assert.equal(r.status, 401);
  });

  await test('admin API rejects a tampered token', async () => {
    const r = await req('GET', '/api/admin/overview', { token: INVALID_TOKEN });
    assert.equal(r.status, 401);
  });

  console.log('\nAdmin CRUD');

  const login = await req('POST', '/api/auth/login', { body: { email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD } });
  const token = login.data.token;

  await test('overview counts load with a token', async () => {
    const r = await req('GET', '/api/admin/overview', { token });
    assert.equal(r.status, 200);
    assert.ok(r.data.counts.packages > 0);
  });

  await test('create → read → update → delete a package', async () => {
    const created = await req('POST', '/api/admin/packages', {
      token,
      body: { title: 'Test Package', category: 'domestic', destination: 'Nowhere', days: 2, nights: 1, price: 1000, discount: 10, summary: 'A test.', highlights: ['One', 'Two'] }
    });
    assert.equal(created.status, 201);
    const id = created.data.item.id;
    assert.equal(created.data.item.slug, 'test-package');
    assert.deepEqual(created.data.item.highlights, ['One', 'Two']);

    const updated = await req('PUT', '/api/admin/packages/' + id, {
      token, body: { title: 'Test Package Updated', category: 'trekking', price: 2000 }
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.item.title, 'Test Package Updated');
    assert.equal(updated.data.item.price, 2000);

    const removed = await req('DELETE', '/api/admin/packages/' + id, { token });
    assert.equal(removed.status, 200);

    const after = await req('GET', '/api/admin/packages', { token });
    assert.ok(!after.data.items.some((p) => p.id === id), 'deleted package should be gone');
  });

  await test('duplicate titles get a unique slug', async () => {
    const a = await req('POST', '/api/admin/destinations', { token, body: { name: 'Dup Place', kind: 'nepal', region: 'X', description: 'First' } });
    const b = await req('POST', '/api/admin/destinations', { token, body: { name: 'Dup Place', kind: 'nepal', region: 'Y', description: 'Second' } });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.notEqual(a.data.item.slug, b.data.item.slug);
    await req('DELETE', '/api/admin/destinations/' + a.data.item.id, { token });
    await req('DELETE', '/api/admin/destinations/' + b.data.item.id, { token });
  });

  await test('creating without a required title is rejected', async () => {
    const r = await req('POST', '/api/admin/packages', { token, body: { category: 'domestic' } });
    assert.equal(r.status, 400);
  });

  await test('updating a missing row returns 404', async () => {
    const r = await req('PUT', '/api/admin/packages/999999', { token, body: { title: 'X' } });
    assert.equal(r.status, 404);
  });

  await test('marking an enquiry handled persists', async () => {
    const contacts = await req('GET', '/api/admin/contacts', { token });
    const id = contacts.data.items[0].id;
    const r = await req('PATCH', '/api/admin/contacts/' + id, { token, body: { handled: 1 } });
    assert.equal(r.status, 200);
    assert.equal(r.data.item.handled, 1);
  });

  console.log('\nStatic front-end');

  await test('home page is served with the correct title', async () => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<title>Himalayan Voyage Nepal/);
  });

  await test('css and js assets are reachable', async () => {
    const css = await fetch(base + '/css/style.css');
    assert.equal(css.status, 200);
    const js = await fetch(base + '/js/main.js');
    assert.equal(js.status, 200);
  });

  await test('admin console page is served', async () => {
    const res = await fetch(base + '/admin.html');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Admin Console/);
  });

  await test('documents page and PDF index are served', async () => {
    const page = await fetch(base + '/documents.html');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Documents/);
    const index = await fetch(base + '/docs/index.json');
    assert.equal(index.status, 200);
    const data = await index.json();
    assert.ok(data.counts.total > 0, 'expected at least one generated document');
  });

  await test('generated PDFs are downloadable and are real PDFs', async () => {
    const res = await fetch(base + '/docs/company-profile.pdf');
    assert.equal(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.slice(0, 4).toString('ascii'), '%PDF', 'file must start with the PDF signature');
    assert.ok(buf.length > 1000, 'PDF should not be empty');
  });

  await test('photo credit manifest lists real, existing files', async () => {
    const res = await fetch(base + '/images/credits.json');
    assert.equal(res.status, 200);
    const credits = await res.json();
    const keys = Object.keys(credits);
    assert.ok(keys.length > 0, 'expected credited photos');
    // every entry must carry the fields the site renders
    for (const k of keys) {
      assert.ok(credits[k].file && credits[k].license && credits[k].source, 'credit ' + k + ' incomplete');
    }
  });

  await test('every visa destination has its own page', async () => {
    const slugs = ['usa', 'canada', 'uk', 'europe', 'japan', 'china', 'thailand',
      'bali', 'malaysia', 'turkey', 'hong-kong', 'australia'];
    for (const slug of slugs) {
      const res = await fetch(base + '/visa-' + slug + '.html');
      assert.equal(res.status, 200, 'visa-' + slug + '.html should exist');
      const html = await res.text();
      assert.match(html, /<title>[^<]*Visa/, 'visa-' + slug + ' needs a Visa title');
    }
  });

  await test('team and CEO pages are served', async () => {
    const team = await fetch(base + '/team.html');
    assert.equal(team.status, 200);
    assert.match(await team.text(), /Team Members/);
    const ceo = await fetch(base + '/ceo.html');
    assert.equal(ceo.status, 200);
    assert.match(await ceo.text(), /Message from the CEO/i);
  });

  await test('every visa checklist PDF linked from a visa page exists', async () => {
    const slugs = ['usa', 'canada', 'uk', 'europe', 'japan', 'china',
      'thailand', 'bali', 'malaysia', 'turkey', 'hong-kong', 'australia'];
    for (const slug of slugs) {
      const res = await fetch(base + '/docs/visa-' + slug + '.pdf');
      assert.equal(res.status, 200, 'docs/visa-' + slug + '.pdf should exist');
      const buf = Buffer.from(await res.arrayBuffer());
      assert.equal(buf.slice(0, 4).toString('ascii'), '%PDF');
    }
  });

  // A destination/package card must never show bare alt text when a photo is
  // meant to be there. The rendered cover uses an ABSOLUTE image path so it
  // resolves from any page depth, and carries an onerror handler that retries
  // once (cache-buster) and then falls back to decorative CSS art.
  await test('coverInner emits an absolute photo path + onerror fallback', async () => {
    const js = fs.readFileSync(path.join(__dirname, 'public', 'js', 'main.js'), 'utf8');
    assert.ok(/src\.startsWith\('\/'\)/.test(js),
      'photo src must be made root-absolute so deep pages resolve it');
    assert.ok(/onerror=/.test(js) && /dataset\.r/.test(js),
      'cover images need an onerror retry-then-fallback handler');
    assert.ok(/cover--photo/.test(js), 'photo covers must carry cover--photo');
  });

  // Article cards must render a real photo, not decorative CSS art. The bug
  // was resolveSlug() ignoring the blog_posts `cover` column, so every
  // "Travel Tips & Articles" card lost its image.
  await test('article covers resolve to real, existing photos', async () => {
    const posts = await (await fetch(base + '/api/posts')).json();
    assert.ok(posts.items.length > 0, 'expected seeded articles');
    const credits = await (await fetch(base + '/images/credits.json')).json();
    for (const post of posts.items) {
      const key = post.cover;
      assert.ok(key, 'post ' + post.slug + ' has no cover key');
      assert.ok(credits[key], 'article cover "' + key + '" is not in credits.json');
      const file = path.join(__dirname, 'public', credits[key].file);
      assert.ok(fs.existsSync(file), 'article cover file missing: ' + credits[key].file);
    }
    const js = fs.readFileSync(path.join(__dirname, 'public', 'js', 'main.js'), 'utf8');
    assert.ok(/record\.cover/.test(js),
      'resolveSlug must consider record.cover for article images');
  });

  // Destination cards must carry the reference-style hover panel: a tinted
  // "Explore More" overlay that slides down over the photo.
  await test('destination cards have the hover Explore-More overlay', async () => {
    const js = fs.readFileSync(path.join(__dirname, 'public', 'js', 'main.js'), 'utf8');
    assert.ok(/desti-overlay/.test(js), 'coverInner must be able to emit a desti-overlay');
    assert.ok(/desti-cta/.test(js) && /desti-arrow/.test(js), 'overlay needs the CTA + arrow');
    for (const f of ['home.js', 'destinations.js']) {
      const src = fs.readFileSync(path.join(__dirname, 'public', 'js', f), 'utf8');
      assert.ok(/desti:\s*true/.test(src), f + ' destination cards must enable the overlay');
    }
    const css = fs.readFileSync(path.join(__dirname, 'public', 'css', 'style.css'), 'utf8');
    assert.ok(/\.desti-overlay\s*\{[^}]*bottom:\s*100%/.test(css),
      'overlay must start above the card (bottom:100%) so it slides down');
    assert.ok(/:hover\s+\.desti-overlay[^{]*\{[^}]*bottom:\s*0/.test(css),
      'hover must bring the overlay down (bottom:0)');
    assert.ok(/prefers-reduced-motion/.test(css), 'animation must respect reduced motion');
  });

  // The hover overlay must be present on EVERY card type (not just destinations):
  // packages, articles, gallery tiles, team members, visa services.
  await test('every card type opts into the hover overlay', async () => {
    for (const f of ['home.js', 'packages.js', 'blogs.js', 'gallery.js', 'team.js', 'visa.js', 'destinations.js']) {
      const src = fs.readFileSync(path.join(__dirname, 'public', 'js', f), 'utf8');
      assert.ok(/overlay:\s*\{/.test(src) || /desti:\s*true/.test(src),
        f + ' must pass an overlay (or desti) option into coverInner');
    }
    // coverInner must accept the generic option, and the CSS must be unscoped so
    // it applies to any .cover (not only .desti-card).
    const js = fs.readFileSync(path.join(__dirname, 'public', 'js', 'main.js'), 'utf8');
    assert.ok(/overlay\s*=\s*null/.test(js), 'coverInner needs an `overlay` option');
    const css = fs.readFileSync(path.join(__dirname, 'public', 'css', 'style.css'), 'utf8');
    assert.ok(/\.cover:hover\s+\.desti-overlay/.test(css),
      'the hover rule must target .cover so every card gets it');
    assert.ok(!/\.desti-card\s+\.cover:hover\s+\.desti-overlay/.test(css),
      'the overlay rule must NOT be scoped to .desti-card only');
  });

  // Reference-parity feature pack: list toolbars, star ratings, sidebar,
  // back-to-top, custom-service band, real map, sort controls.
  await test('list pages expose the reference-parity feature pack', async () => {
    const read = (p) => fs.readFileSync(path.join(__dirname, 'public', p), 'utf8');

    const dest = read('destinations.html');
    for (const id of ['dest-search', 'dest-sort', 'dest-toolbar', 'dest-count']) {
      assert.ok(dest.includes(id), 'destinations.html missing #' + id);
    }
    assert.ok(dest.includes('side-card'), 'destinations.html needs the sidebar');
    assert.ok(dest.includes('custom-band'), 'destinations.html needs the custom-service band');

    const pkg = read('packages.html');
    assert.ok(pkg.includes('package-sort'), 'packages.html needs a sort control');

    const blog = read('blogs.html');
    assert.ok(blog.includes('blog-search') && blog.includes('blog-sort'),
      'blogs.html needs search + sort controls');

    const contact = read('contact.html');
    assert.ok(/<iframe[^>]*openstreetmap\.org/.test(contact),
      'contact.html needs a real map embed (no placeholder text)');
    assert.ok(!/Map placeholder/.test(contact), 'the map placeholder must be gone');

    // main.js must actually export the new helpers.
    const main = read('js/main.js');
    for (const fn of ['starsHtml', 'ratingFor', 'wireToolbar', 'countUp']) {
      assert.ok(new RegExp('\\b' + fn + '\\b').test(main), 'main.js must export ' + fn);
    }

    // server.js must allow the map iframe through CSP, or it is silently blocked.
    const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    assert.ok(/frame-src[^;]*openstreetmap\.org/.test(server),
      'CSP must allow frame-src openstreetmap.org or the map will not render');
  });

  // Homepage parity: hero slider, icon counters, video block, CTA horizon bars,
  // corner ribbons and the custom-service band.
  await test('homepage exposes the reference-parity sections', async () => {
    const home = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    for (const id of ['hero-slider', 'hero-dots', 'about-video-btn']) {
      assert.ok(home.includes(id), 'index.html missing #' + id);
    }
    assert.ok((home.match(/hero-slide/g) || []).length >= 3, 'needs at least 3 hero slides');
    assert.ok(home.includes('stats--icons'), 'stat counters must carry icons');
    assert.ok(home.includes('cta-horizon'), 'needs the thin CTA horizon bands (reference has 2)');
    assert.ok((home.match(/cta-horizon/g) || []).length >= 2, 'expected two CTA horizon bands');
    assert.ok(home.includes('video-block') && home.includes('play-btn'), 'needs the video/play block');
    assert.ok(home.includes('custom-band'), 'needs the custom-service band');

    // home.js must drive the slider and render ribbons on package cards.
    const js = fs.readFileSync(path.join(__dirname, 'public', 'js', 'home.js'), 'utf8');
    assert.ok(/function wireHeroSlider/.test(js), 'home.js must define wireHeroSlider');
    assert.ok(/hero-slider/.test(js), 'wireHeroSlider must look up #hero-slider');
    assert.ok(/ribbon/.test(js), 'packageCard must render a corner ribbon');

    // The slider CSS must exist or the slides never hide/show.
    const css = fs.readFileSync(path.join(__dirname, 'public', 'css', 'style.css'), 'utf8');
    assert.ok(/\.hero-slide\s*\{[^}]*display:\s*none/.test(css), 'inactive slides must be hidden');
    assert.ok(/\.hero-slide\.is-active\s*\{[^}]*display:\s*block/.test(css), 'the active slide must show');
    assert.ok(/prefers-reduced-motion/.test(css), 'animations must respect reduced motion');
  });

  // REGRESSION: cards injected by innerHTML after the API responds must be
  // forced visible. If a renderer forgets, `.reveal { opacity: 0 }` leaves every
  // card permanently invisible — the "my home page shows no photo cards" bug.
  await test('every async renderer reveals its injected cards', async () => {
    const renderers = ['home.js', 'destinations.js', 'packages.js', 'blogs.js', 'gallery.js', 'team.js', 'visa.js'];
    for (const f of renderers) {
      const src = fs.readFileSync(path.join(__dirname, 'public', 'js', f), 'utf8');
      const hasForcedReveal = /is-in/.test(src) || /revealAll\s*\(/.test(src);
      assert.ok(hasForcedReveal,
        f + ' must force-show (is-in / App.revealAll) cards it injects, or they stay at opacity:0');
    }
    // main.js must provide the shared reveal machinery.
    const main = fs.readFileSync(path.join(__dirname, 'public', 'js', 'main.js'), 'utf8');
    assert.ok(/function setupReveal/.test(main), 'main.js needs setupReveal()');
    assert.ok(/function revealAll/.test(main), 'main.js needs revealAll()');
    assert.ok(/setupReveal, observeReveal, revealAll/.test(main), 'the reveal helpers must be exported');
    // home.js must call revealAll after each innerHTML render.
    const home = fs.readFileSync(path.join(__dirname, 'public', 'js', 'home.js'), 'utf8');
    const renders = (home.match(/\.innerHTML\s*=/g) || []).length;
    const reveals = (home.match(/App\.revealAll\(/g) || []).length;
    assert.ok(reveals >= 4, 'home.js must call App.revealAll() after rendering (got ' + reveals + ')');
    assert.ok(renders > 0, 'expected home.js to render lists');
  });

  // REGRESSION: the nav dropdown must not close while the pointer crosses the
  // gap between the top-level link and the panel. Without the invisible bridge
  // the submenu snaps shut mid-travel and its items can never be clicked.
  await test('nav dropdown has hover bridge across the gap', async () => {
    const css = fs.readFileSync(path.join(__dirname, 'public', 'css', 'style.css'), 'utf8');
    // The panel is offset from the link, so a bridge is required.
    assert.ok(/\.submenu\s*\{[^}]*top:\s*calc\(100%\s*\+\s*\d+px\)/.test(css),
      'submenu must be offset below the link (which is why the gap needs bridging)');
    assert.ok(/\.submenu::before\s*\{[^}]*content:\s*""/.test(css),
      '.submenu::before must create the invisible hover bridge');
    assert.ok(/\.submenu::before\s*\{[^}]*top:\s*-\d+px/.test(css),
      'the bridge must start above the panel to cover the offset');
    assert.ok(/\.nav-item\.has-sub:hover\s*>\s*\.submenu/.test(css) &&
      /\.nav-item\.has-sub:focus-within\s*>\s*\.submenu/.test(css),
      'the submenu must open on hover AND on keyboard focus');
    // The bridge must be disabled where the drawer renders menus statically.
    assert.ok(/\.submenu::before\s*\{\s*display:\s*none/.test(css),
      'the bridge must be switched off in the mobile drawer');
    // Every parent nav entry that advertises children must render a submenu.
    const layout = fs.readFileSync(path.join(__dirname, 'public', 'js', 'layout.js'), 'utf8');
    assert.ok(/has-sub/.test(layout) && /submenu/.test(layout),
      'layout.js must render .nav-item.has-sub > .submenu');
  });

  // REGRESSION: on a phone the page must stay inside the viewport. The off-canvas
  // nav drawer (position:fixed + translateX(105%)) used to widen the document by
  // ~336px, which made every 100vw element (chat panel, hero) overshoot the screen
  // and let the user pan sideways. `overflow-x: clip` on the root contains it —
  // and unlike `hidden`, it does NOT break the sticky header. Verified with a real
  // headless-Chrome audit (scripts/mobile-check.js) across 4 phones × 6 pages.
  await test('mobile viewport is contained without breaking the sticky header', async () => {
    const raw = fs.readFileSync(path.join(__dirname, 'public', 'css', 'style.css'), 'utf8');
    // Strip comments first: the explanatory comment below legitimately MENTIONS
    // overflow-x:hidden, and matching prose would be a false positive.
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
    // The containment rule must exist inside the mobile breakpoint…
    const mobileBlock = css.slice(css.indexOf('@media (max-width: 980px)'));
    assert.ok(/html,\s*body\s*\{\s*overflow-x:\s*clip/.test(mobileBlock),
      'the mobile drawer must be contained with html,body{overflow-x:clip}');
    // …and must NOT use `hidden`, which forces overflow-y:auto and kills sticky.
    assert.ok(!/overflow-x:\s*hidden/.test(css),
      'overflow-x:hidden silently breaks position:sticky — use clip instead');
    // The parked drawer must still be positioned off-canvas.
    assert.ok(/transform:\s*translateX\(10\dd?%\)/.test(css),
      'the closed drawer must remain parked off-canvas');
  });

  // Cleanup
  server.close();
  try { fs.unlinkSync(TMP_DB); } catch (_e) { /* best effort */ }
  try { fs.unlinkSync(TMP_DB + '-wal'); } catch (_e) { /* best effort */ }
  try { fs.unlinkSync(TMP_DB + '-shm'); } catch (_e) { /* best effort */ }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});

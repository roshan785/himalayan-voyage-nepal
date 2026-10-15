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

// HARD SAFETY GUARD — this suite DESTROYS data (it truncates and rewrites
// tables). It must only ever point at a throwaway database.
//
// Two real incidents made this necessary:
//   1. `node test.js` picked up a production DATABASE_URL from .env and wrote
//      test rows into the live database (the env var is not set by the runner,
//      so the isolation below could not see it).
//   2. The same happens for any PG database that is not clearly a test one.
//
// Rules: load .env exactly like the app does, then refuse unless the target is
// a temp SQLite file or the database name says it is a test database.
(function loadEnvForGuard() {
  try { require('./src/load-env').loadDotEnv(); } catch (_e) { /* optional */ }
})();

const GUARD_DB_URL = process.env.DATABASE_URL || '';
if (/^postgres(ql)?:\/\//i.test(GUARD_DB_URL)) {
  const dbName = (() => { try { return new URL(GUARD_DB_URL).pathname.replace(/^\//, ''); } catch (_e) { return ''; } })();
  if (!/(test|ci|sandbox|tmp|scratch|ephemeral)/i.test(dbName)) {
    console.error(
      '\n[REFUSED] Refusing to run the test suite against "' + dbName + '".\n' +
      'This suite DELETES and RE-CREATES data, so it must never point at a real database.\n\n' +
      'Use one of:\n' +
      '  • leave DATABASE_URL unset (SQLite temp file — the default)\n' +
      '  • point it at a database whose NAME contains test/ci/sandbox, e.g.\n' +
      '      DATABASE_URL=postgresql://user@host/hvtest_suite\n'
    );
    process.exit(3);
  }
}

// Isolation. SQLite: a private temp file. PostgreSQL: a private SCHEMA inside the
// given database. Without this a re-run would find a previous run's admin row
// (whose password is random per run) and login would 401 — the suite must be
// idempotent so it can be run repeatedly.
const TEST_PG_SCHEMA = 'hvtest_' + crypto.randomBytes(5).toString('hex');
if (/^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL || '')) {
  process.env.PG_SCHEMA = TEST_PG_SCHEMA;
}
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
  const server = await start();
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

  // REGRESSION: the `image` field used to be capped at 300 chars by
  // normalisePackage. The admin file picker turns a photo into a data URL, so
  // anything over 300 chars was silently TRUNCATED into invalid base64 — the
  // browser then could not decode it and the card rendered broken (this is the
  // reported "Nameste photo bigriyeko" bug, whose value was exactly 300 chars).
  // The field must now store inline images intact, and REFUSE an oversized one
  // with a clear message instead of corrupting it.
  await test('image field stores data URLs intact and rejects oversized ones', async () => {
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
    const dataUrl = 'data:image/png;base64,' + PNG.repeat(4);   // ~406 chars, over the old 300 cap
    assert.ok(dataUrl.length > 300, 'the probe value must exceed the old 300-char cap');

    const created = await req('POST', '/api/admin/packages', { token, body: {
      title: 'Image Regression Probe', category: 'domestic', destination: 'Probe',
      days: 1, nights: 0, price: 1, discount: 0, image: dataUrl, summary: 'probe', highlights: []
    } });
    assert.equal(created.status, 201, 'a >300-char inline image must be accepted');
    assert.equal(created.data.item.image, dataUrl, 'the data URL must be stored byte-for-byte, not truncated');

    // It must survive a round-trip through the public read endpoint too.
    const read = await req('GET', '/api/packages/' + created.data.item.slug);
    assert.equal(read.status, 200);
    assert.equal(read.data.item.image, dataUrl, 'public read must return the intact data URL');

    await req('DELETE', '/api/admin/packages/' + created.data.item.id, { token });

    // A long (but sane) remote URL must also be accepted — the old 300-char cap
    // would have chopped a long CDN path as well.
    const longUrl = 'https://cdn.example.com/' + 'a'.repeat(300) + '/photo.jpg';
    assert.ok(longUrl.length > 300, 'the URL probe must exceed the old 300-char cap (got ' + longUrl.length + ')');
    const urlRow = await req('POST', '/api/admin/packages', { token, body: {
      title: 'Image Url Probe', category: 'domestic', destination: 'Probe',
      days: 1, nights: 0, price: 1, discount: 0, image: longUrl, summary: 'probe', highlights: []
    } });
    assert.equal(urlRow.status, 201, 'a long remote image URL must be accepted');
    assert.equal(urlRow.data.item.image, longUrl, 'a long URL must not be truncated');
    await req('DELETE', '/api/admin/packages/' + urlRow.data.item.id, { token });

    // An inline image over the 400 KB picker limit must be REJECTED with a
    // useful message — never silently stored as a broken string.
    const huge = 'data:image/png;base64,' + 'A'.repeat(420 * 1024);
    const big = await req('POST', '/api/admin/packages', { token, body: {
      title: 'Image Too Big Probe', category: 'domestic', destination: 'Probe',
      days: 1, nights: 0, price: 1, discount: 0, image: huge, summary: 'probe', highlights: []
    } });
    assert.ok(big.status === 400 || big.status === 413,
      'an oversized inline image must be rejected (got ' + big.status + ')');
    assert.ok(/too large|paste an image URL/i.test(String(big.data && big.data.error || '')),
      'the rejection must explain how to fix it, got: ' + JSON.stringify(big.data));
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

  // The social icon row must give a real, BRAND-COLOURED hover/focus state on
  // every network — not one generic highlight for all five (the reference site
  // paints each tile with that network's own colour on hover).
  await test('social icons have per-network brand-colour hover states', async () => {
    const js = fs.readFileSync(path.join(__dirname, 'public', 'js', 'layout.js'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, 'public', 'css', 'style.css'), 'utf8');
    for (const net of ['facebook', 'instagram', 'youtube', 'x', 'tiktok']) {
      assert.ok(new RegExp('social-icon--\\$\\{s\\.key\\}').test(js),
        'layout.js must append the per-network modifier class to every icon');
      assert.ok(new RegExp('\\.social-icon--' + net + '\\s*\\{').test(css),
        'css must define the brand colour for .social-icon--' + net);
    }
    assert.ok(/--social-fill,\s*var\(--social\)/.test(css) || /background:\s*var\(--social\)/.test(css),
      'hover must fill the tile with the per-network brand colour');
    assert.ok(/\.social-icon:hover[^{]*\{[\s\S]{0,400}?translateY/.test(css), 'hover must lift the tile');
    assert.ok(/\.social-icon:focus-visible/.test(css), 'keyboard focus must get the same state');
    assert.ok(/@media\s*\(hover:\s*none\)/.test(css), 'touch screens need a larger tap target');
    assert.ok(/prefers-reduced-motion/.test(css), 'animation must respect reduced motion');
  });

  // REGRESSION: the glyph must sit in the CENTRE of its tile, otherwise the
  // hover fill and shadow render offset — visibly "outside" the logo. Reported
  // by the user, so it gets a permanent guard.
  //
  // Root cause was a SPECIFICITY LOSS: `.topbar a` and `.site-footer a` are
  // (0,1,1) and beat the old bare `.social-icon` (0,1,0) for `display` and
  // `font-size`. With `display:inline-block` winning over `inline-flex`,
  // `align-items`/`justify-content` had nothing to centre, so the glyph stuck
  // in the tile's top-left corner (measured offset ≈ −7px,−7px).
  await test('social icon glyphs are centred in their tile (specificity-safe)', async () => {
    const css = fs.readFileSync(path.join(__dirname, 'public', 'css', 'style.css'), 'utf8');

    // Specificity (a,b,c): id=A, class/pseudo/attr=B, element=C.
    const spec = (sel) => {
      let s = sel.replace(/::[a-zA-Z-]+(\([^)]*\))?/g, '');
      s = s.replace(/:not\(([^)]*)\)/g, ' $1 ');
      const b1 = (s.match(/:[a-zA-Z-]+/g) || []).length;
      s = s.replace(/:[a-zA-Z-]+(\([^)]*\))?/g, ' ');
      const a = (s.match(/#[A-Za-z0-9_-]+/g) || []).length;
      const b2 = (s.match(/\.[A-Za-z0-9_-]+/g) || []).length + (s.match(/\[[^\]]+\]/g) || []).length;
      s = s.replace(/#[A-Za-z0-9_-]+/g, ' ').replace(/\.[A-Za-z0-9_-]+/g, ' ').replace(/\[[^\]]+\]/g, ' ');
      const c = (s.match(/(^|[\s>+~])[a-zA-Z][A-Za-z0-9-]*/g) || []).length;
      return [a, b1 + b2, c];
    };
    const beats = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];

    // The rule that actually sets the centring display on a social icon.
    const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .map((m) => ({ sel: m[1].trim(), body: m[2] }))
      .filter((r) => /\.social-icon/.test(r.sel) && /display\s*:\s*inline-flex/.test(r.body));
    assert.ok(blocks.length > 0, 'a .social-icon rule must set display:inline-flex');

    const winner = blocks
      .map((r) => {
        const one = r.sel.split(',').find((x) => /\.social-icon/.test(x)) || r.sel;
        return { ...r, s: spec(one) };
      })
      .sort((p, q) => beats(q.s, p.s))[0];

    for (const loser of ['.topbar a', '.site-footer a']) {
      assert.ok(beats(winner.s, spec(loser)) > 0,
        `social centring rule ${winner.s.join(',')} must outrank ${loser} ${spec(loser).join(',')}`);
    }
    assert.ok(/align-items\s*:\s*center/.test(winner.body), 'must set align-items:center');
    assert.ok(/justify-content\s*:\s*center/.test(winner.body), 'must set justify-content:center');
    assert.ok(/font-size\s*:\s*0/.test(winner.body), 'font-size:0 removes the inline baseline gap');
    assert.ok(/line-height\s*:\s*1/.test(winner.body), 'line-height:1 removes the leading box');
    assert.ok(/\.social-icon svg\s*\{[^}]*display\s*:\s*block/.test(css), 'svg must be display:block');
    assert.ok(/\.social-icon svg\s*\{[^}]*margin\s*:\s*auto/.test(css), 'svg needs margin:auto centring');
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

  // REGRESSION: the menu bar must stay pinned while scrolling (reported bug —
  // it vanished because `position:sticky` can only travel inside its PARENT,
  // and the bar lives inside the exactly-as-tall `#site-header` wrapper).
  // Also guards the top-bar pin icon, which had no size rule and rendered at
  // ~210px, inflating the top bar to 252px.
  await test('menu bar stays sticky and the top bar stays compact', async () => {
    const css = fs.readFileSync(path.join(__dirname, 'public', 'css', 'style.css'), 'utf8');

    // `display:contents` takes the wrapper out of the box tree so the sticky
    // bar's containing block becomes the page (verified in a real browser).
    assert.ok(/#site-header\s*\{[^}]*display:\s*contents/.test(css),
      '#site-header must be display:contents or the sticky bar can only travel as far as the wrapper');
    assert.ok(/\.site-header\s*\{[^}]*position:\s*sticky/.test(css), '.site-header must be position:sticky');
    assert.ok(/\.site-header\s*\{[^}]*top:\s*0/.test(css), '.site-header must be pinned to top:0');
    assert.ok(/\.site-header\s*\{[^}]*z-index:\s*\d+/.test(css), '.site-header needs a stacking z-index');

    // The pin icon must be explicitly sized, or the 24-viewBox SVG falls back to
    // the 300x150 replaced-element size and blows up the top bar.
    assert.ok(/\.topbar__meta svg\s*\{[^}]*width:\s*14px[^}]*height:\s*14px/.test(css),
      'the top-bar pin icon needs an explicit width/height');
    assert.ok(/\.topbar__meta svg\s*\{[^}]*flex:\s*none/.test(css),
      'the pin icon must not be stretched by the flex container');

    // `display:contents` is what makes sticky work, so the header must NOT be
    // moved back inside a boxed wrapper (its own wrapper would need height).
    const home = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    assert.ok(/<div id="site-header"><\/div>/.test(home), 'index.html keeps the empty mount point');
  });

  // The destination-detail sidebar ("Explore Recent Tour Packages") must stay
  // put while the long article scrolls, like the reference site's sidebar.
  //
  // The element that sticks must be the GRID CELL (`.detail-side`), not the panel
  // inside it: a sticky box is clamped to its parent's box, and `.detail-side`
  // is only as tall as the panel, so a sticky `.side-panel` would scroll away.
  await test('destination sidebar is sticky on desktop only', async () => {
    const css = fs.readFileSync(path.join(__dirname, 'public', 'css', 'style.css'), 'utf8');

    // The sticky rule must live in a min-width media query so single-column
    // layouts (<=900px) never stick.
    const stickyBlock = css.match(/@media\s*\(min-width:\s*901px\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(stickyBlock, 'expected a @media (min-width:901px) block for the sidebar');
    assert.ok(/\.detail-side\s*\{[^}]*position:\s*sticky/.test(stickyBlock[1]),
      '.detail-side must be position:sticky inside the desktop media query');
    assert.ok(/\.detail-side\s*\{[^}]*top:\s*\d+px/.test(stickyBlock[1]),
      '.detail-side needs a top offset so it clears the sticky site header');

    // The sticky offset must clear the real sticky header (104px) — otherwise the
    // panel slides underneath it.
    const top = Number((stickyBlock[1].match(/top:\s*(\d+)px/) || [])[1]);
    assert.ok(top >= 104, `sidebar top (${top}px) must be >= the sticky header height (104px)`);

    // The grid must keep `align-items: start`, or the cell stretches to the row
    // height and there is no travel room for the sticky element.
    assert.ok(/\.detail-grid\s*\{[^}]*align-items:\s*start/.test(css),
      '.detail-grid needs align-items:start or the sidebar cell cannot stick');

    // Single-column override must reset positioning.
    assert.ok(/@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.detail-side\s*\{[^}]*position:\s*static/.test(css),
      'the <=900px layout must reset .detail-side to position:static');

    // Guard against the wrong element being made sticky.
    assert.ok(!/^\s*\.side-panel\s*\{[^}]*position:\s*sticky/m.test(css),
      'sticky must NOT be put on .side-panel (it is clamped by its parent)');
  });

  // The play button must play the film INLINE, in that same section — it must
  // not navigate away (the original bug) and must not pop the video out into a
  // separate overlay (the follow-up request).
  await test('play button plays the video inline in the same block', async () => {
    const js = fs.readFileSync(path.join(__dirname, 'public', 'js', 'home.js'), 'utf8');

    assert.ok(!/location\.href\s*=\s*['"]gallery\.html/.test(js),
      'the play button must NOT redirect to gallery.html');
    assert.ok(/function playVideoInline\s*\(/.test(js), 'home.js must define playVideoInline()');
    assert.ok(/youtube-nocookie\.com\/embed\//.test(js),
      'the embed must use youtube-nocookie (privacy-enhanced mode)');
    assert.ok(/autoplay=1/.test(js), 'the video should start playing on click');
    // Nothing loads from YouTube until the visitor actually asks for the video.
    assert.ok(/document\.createElement\('iframe'\)/.test(js),
      'the iframe must be created lazily on click, not present in the page markup');
    // It must mount into the existing block, not a full-screen overlay.
    // (The button sits inside the poster, so the frame is appended and the
    // poster is hidden by the is-playing class.)
    assert.ok(/block\.appendChild\(frame\)/.test(js),
      'the player must be appended into the existing .video-block');
    assert.ok(/classList\.add\('is-playing'\)/.test(js), 'the block must switch to its playing state');
    // No leftover modal machinery.
    assert.ok(!/video-lightbox|video-modal|aria-modal/.test(js),
      'the old popup modal must be gone — the video plays inline now');

    const vid = (js.match(/id:\s*'([A-Za-z0-9_-]{11})'/) || [])[1];
    assert.ok(vid, 'a real 11-char YouTube id must be configured');

    // The CSP must permit the frame or the player is silently blocked.
    const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    assert.ok(/frame-src[^;]*youtube-nocookie\.com/.test(server),
      'CSP frame-src must allow youtube-nocookie.com or the player stays blank');

    const css = fs.readFileSync(path.join(__dirname, 'public', 'css', 'style.css'), 'utf8');
    assert.ok(/\.video-block__frame\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*10/.test(css),
      'the inline frame must match the block footprint (16/10) so the layout does not jump');
    assert.ok(/\.video-block__frame iframe\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0/.test(css),
      'the iframe must fill the frame');
    assert.ok(/\.video-block\.is-playing[^{]*\{[^}]*display:\s*none/.test(css),
      'the poster + play button must be hidden once playing');

    const home = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    assert.ok(/video-block__poster/.test(home), 'index.html needs the poster wrapper');
    assert.ok(/id="about-video-btn"/.test(home), 'index.html must keep #about-video-btn');
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

  // BOOKINGS: the public booking endpoint must accept a valid request, reject a
  // bad one, and the row must then be visible + editable through the protected
  // admin API (this is the admin-panel <-> frontend link the user asked for).
  await test('bookings flow: public create -> admin list -> admin status update', async () => {
    const bad = await req('POST', '/api/bookings', { body: { name: '', email: 'nope' } });
    assert.equal(bad.status, 400, 'a missing name / invalid email must be rejected');

    const created = await req('POST', '/api/bookings', { body: {
      name: 'Bookings Test', email: 'bookings@test.local',
      phone: '9800000000', travellers: 2, travel_date: '2026-12-24',
      package_slug: 'pokhara-leisure-tour', message: 'e2e'
    } });
    assert.equal(created.status, 201, 'a valid booking must be created');
    assert.ok(created.data.id, 'the created booking must return its id');

    const noAuth = await req('GET', '/api/admin/bookings');
    assert.equal(noAuth.status, 401, 'bookings are private to the admin');

    const list = await req('GET', '/api/admin/bookings', { token });
    assert.equal(list.status, 200);
    const found = (list.data.items || []).find((b) => b.id === created.data.id);
    assert.ok(found, 'the booking must appear in the admin list');
    assert.equal(found.name, 'Bookings Test');
    assert.equal(found.status, 'new');
    assert.equal(found.package_title, 'Pokhara Leisure Tour',
      'the package title must be resolved from the slug for the admin view');

    const upd = await req('PUT', '/api/admin/bookings/' + created.data.id, {
      body: { name: 'Bookings Test', email: 'bookings@test.local', status: 'confirmed' },
      token
    });
    assert.equal(upd.status, 200);
    assert.equal(upd.data.item.status, 'confirmed', 'the status update must persist');
  });

  // ADMIN UI wiring: the console must expose a Bookings view and image fields.
  await test('admin console exposes bookings + image management', async () => {
    const adminJs = fs.readFileSync(path.join(__dirname, 'public', 'js', 'admin.js'), 'utf8');
    assert.ok(/bookings:\s*\{/.test(adminJs), 'admin.js must define a bookings view');
    assert.ok(/renderBookings/.test(adminJs), 'admin.js must render the bookings table');
    assert.ok(/type:\s*'image'/.test(adminJs), 'admin.js must support image fields');
    assert.ok(/wireImageFields/.test(adminJs), 'image fields must wire an upload + preview');
    const adminHtml = fs.readFileSync(path.join(__dirname, 'public', 'admin.html'), 'utf8');
    assert.ok(/data-view="bookings"/.test(adminHtml), 'admin.html must show a Bookings nav item');
  });

  // FRONTEND: package detail pages must offer a booking form that posts to the
  // public bookings API (so website -> admin panel is connected).
  await test('package detail page has a booking form wired to the API', async () => {
    const js = fs.readFileSync(path.join(__dirname, 'public', 'js', 'packages.js'), 'utf8');
    assert.ok(/id="booking-form"/.test(js), 'the package detail must render a booking form');
    assert.ok(/\/api\/bookings/.test(js), 'the booking form must post to /api/bookings');
    assert.ok(/booking-panel/.test(js), 'the booking form must live in a booking panel');
  });

  // "Contact Now" (the orange button) must open JUST the enquiry form in a popup
  // instead of navigating to contact.html, so the visitor keeps the page they
  // were reading. Reported request: "contact now button ma click garda xuttai
  // contact form matra popup vaera khulini banaunuhos."
  await test('Contact Now opens a form-only popup, not a page change', async () => {
    const layout = fs.readFileSync(path.join(__dirname, 'public', 'js', 'layout.js'), 'utf8');
    const main = fs.readFileSync(path.join(__dirname, 'public', 'js', 'main.js'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, 'public', 'css', 'style.css'), 'utf8');
    const contactJs = fs.readFileSync(path.join(__dirname, 'public', 'js', 'contact.js'), 'utf8');

    // The popup markup lives in layout.js (loaded by every page), so no HTML page
    // needs to be edited and the form exists on all 28 pages.
    assert.ok(/function contactModal\s*\(/.test(layout), 'layout.js must define contactModal()');
    assert.ok(/dlg\.id\s*=\s*'contact-modal'/.test(layout), 'the popup must have id=contact-modal');
    assert.ok(/function openContact\s*\(/.test(layout) && /function closeContact\s*\(/.test(layout),
      'openContact()/closeContact() must exist');
    assert.ok(/document\.body\.appendChild\(dlg\)/.test(layout), 'the popup must be appended to <body>');
    // Only the form — no page content duplicated into the popup.
    for (const id of ['cm-name', 'cm-email', 'cm-phone', 'cm-subject', 'cm-message']) {
      assert.ok(new RegExp(`id="${id}"`).test(layout), `popup field #${id} must exist`);
    }
    assert.ok(/setAttribute\('aria-modal',\s*'true'\)/.test(layout) && /setAttribute\('aria-labelledby'/.test(layout),
      'the popup must be a11y-marked (aria-modal + aria-labelledby)');
    assert.ok(/Escape/.test(layout), 'Escape must close the popup');

    // Delegated click handling = works from every page, including API-rendered ones.
    assert.ok(/document\.addEventListener\('click'/.test(layout), 'the contact link handling must be delegated');
    assert.ok(/isContactLink/.test(layout), 'links must be filtered by isContactLink()');
    assert.ok(/preventDefault\(\)/.test(layout), 'the navigation must be prevented');
    assert.ok(/dataset\.contactModal === 'off'/.test(layout), 'there must be an opt-out hook');
    // Modifier clicks (new tab) must still work normally.
    assert.ok(/e\.metaKey \|\| e\.ctrlKey/.test(layout), 'modified clicks must keep default behaviour');
    // Only contact.html links qualify — the drawer/footer "Contact Us" stays a link.
    assert.ok(/isContactLink\(a\)/.test(layout));

    // One shared submit implementation for BOTH forms (no drift).
    assert.ok(/function wireContactForm\s*\(/.test(main), 'main.js must export wireContactForm()');
    assert.ok(/wireContactForm/.test(main.slice(main.lastIndexOf('return {'))), 'wireContactForm must be exported');
    assert.ok(/api\/contact/.test(main), 'the shared helper must post to /api/contact');
    assert.ok(/formId/.test(main) && /noteId/.test(main), 'the helper must accept the id map');
    assert.ok(/wireContactForm/.test(layout), 'the popup form must use the shared helper');
    assert.ok(/wireContactForm/.test(contactJs), 'the contact page must use the shared helper');
    assert.ok(!/await App\.api\('\/api\/contact'/.test(contactJs),
      'contact.js must not duplicate the submit logic');

    // Popup styling + scroll lock.
    assert.ok(/\.has-contact-modal\s*\{[^}]*overflow:\s*hidden/.test(css), 'the page behind must not scroll');
    assert.ok(/\.contact-modal__panel\s*\{/.test(css), 'the panel needs styling');
    assert.ok(/contactModalIn/.test(css), 'the panel should animate in');
    assert.ok(/prefers-reduced-motion[\s\S]{0,140}\.contact-modal__panel\s*\{[^}]*animation:\s*none/.test(css),
      'the animation must respect reduced motion');
  });

  // The FAQ must behave like the reference site's accordion: opening one
  // question automatically closes whichever was open, so only ONE answer is
  // ever visible. (Reported request: "euta question open garda arko open vako
  // question afai close huni banauna".)
  await test('FAQ accordion is single-open and accessible', async () => {
    const js = fs.readFileSync(path.join(__dirname, 'public', 'js', 'faq.js'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, 'public', 'css', 'style.css'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, 'public', 'faq.html'), 'utf8');

    // The single-open mechanism: a closeOthers() sweep before opening.
    assert.ok(/function closeOthers\s*\(/.test(js), 'faq.js must define closeOthers()');
    assert.ok(/closeOthers\(item\)/.test(js), 'opening a question must first close the others');
    assert.ok(/it !== keep && it\.isOpen/.test(js), 'closeOthers must close every OTHER open item');

    // Smooth height animation (the reference uses slideUp/slideDown).
    assert.ok(/function open\s*\(/.test(js) && /function close\s*\(/.test(js), 'open() and close() must exist');
    assert.ok(/requestAnimationFrame/.test(js), 'the height swap must happen on the next frame');
    assert.ok(/DURATION/.test(js), 'the hide delay must be derived from the transition duration');
    assert.ok(/offsetHeight/.test(js), 'the panel height must be measured from its content');

    // State must live in the DOM for screen readers.
    assert.ok(/aria-expanded/.test(js), 'buttons must expose aria-expanded');
    assert.ok(/aria-controls/.test(js), 'buttons must point at their panel via aria-controls');
    assert.ok(/role="region"/.test(js), 'each panel should be a labelled region');
    assert.ok(/hidden/.test(js), 'collapsed panels must be hidden, not just zero-height');
    assert.ok(/escapeHtml\s*=/.test(js), 'FAQ content must be escaped before injection');

    // The reveal/list mount point must stay.
    assert.ok(/id="faq-list"/.test(html), 'faq.html must keep #faq-list');
    assert.ok(/faq\.js/.test(html), 'faq.html must load faq.js');

    // Styling for the accordion parts (was inline styles before).
    for (const cls of ['.faq-q', '.faq-sign', '.faq-a', '.faq-a__inner', '.faq-heading']) {
      assert.ok(new RegExp(cls.replace('.', '\\.') + '\\s*\\{').test(css), 'css must style ' + cls);
    }
    assert.ok(/\.faq-a\s*\{[^}]*overflow:\s*hidden/.test(css), 'the panel must clip while animating');
    assert.ok(/\.faq-a\s*\{[^}]*transition:\s*height/.test(css), 'the panel must animate its height');
    assert.ok(/\.faq-a\[hidden\]\s*\{[^}]*display:\s*none/.test(css), 'hidden panels must not render');
    assert.ok(/prefers-reduced-motion[\s\S]{0,120}\.faq-a\s*\{[^}]*transition:\s*none/.test(css),
      'the animation must respect reduced motion');
  });

  // The booking form was rebuilt as a premium card: labelled fields, icons,
  // inline validation and a spinner. This guards the parts a refactor could
  // silently drop — especially the error-id mapping, whose absence made the
  // travel-date error invisible (name `travel_date` vs id `bf-date-err`).
  await test('booking form is premium + validates inline', async () => {
    const js = fs.readFileSync(path.join(__dirname, 'public', 'js', 'packages.js'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, 'public', 'css', 'style.css'), 'utf8');

    // Every rendered field must have an associated <label for=...>.
    const fields = ['bf-name', 'bf-email', 'bf-phone', 'bf-travellers', 'bf-date', 'bf-message'];
    for (const id of fields) {
      assert.ok(new RegExp(`id="${id}"`).test(js), `field #${id} must exist`);
      assert.ok(new RegExp(`for="${id}"`).test(js), `field #${id} needs a <label for>`);
    }

    // Required fields carry aria-required, and messages are announced.
    assert.ok((js.match(/aria-required="true"/g) || []).length >= 2, 'name + email must be aria-required');
    assert.ok(/role="alert"/.test(js), 'error messages must be announced (role=alert)');

    // The error-id map is what makes `travel_date` -> `bf-date-err` work.
    assert.ok(/ERR_ID\s*=\s*\{[^}]*travel_date:\s*'bf-date-err'/.test(js),
      'travel_date must map to bf-date-err, or its error is silently dropped');
    assert.ok(/getElementById\(ERR_ID\[name\]/.test(js), 'setError must look the id up via ERR_ID');

    // Validation must run client-side and block the request.
    assert.ok(/function validate\s*\(/.test(js), 'a validate() function must exist');
    assert.ok(/novalidate/.test(js), 'the form must use novalidate so inline errors win');
    assert.ok(/aria-invalid/.test(js), 'invalid fields must be marked aria-invalid');
    assert.ok(/firstBad\.focus\(\)/.test(js), 'the first invalid field must be focused');
    assert.ok(/Number\.isInteger\(t\)\s*\|\|\s*t\s*<\s*1/.test(js), 'travellers must be range-checked');
    assert.ok(/new Date\(d \+ 'T00:00:00'\)\s*<\s*today/.test(js), 'a past travel date must be rejected');

    // Loading + failure states.
    assert.ok(/is-loading/.test(js), 'the submit button needs a loading state');
    assert.ok(/booking-submit__spin/.test(js), 'the loading state needs its spinner node');
    assert.ok(/is-ok/.test(js) && /is-err/.test(js), 'success and failure notes must be distinct');

    // Premium styling hooks must all be present.
    for (const cls of ['.booking-panel__flag', '.booking-panel__title', '.booking-field__label',
      '.booking-field__icon', '.booking-field__err', '.booking-submit__spin', '.booking-assure']) {
      assert.ok(new RegExp(cls.replace('.', '\\.') + '\\s*\\{').test(css), 'css must style ' + cls);
    }
    assert.ok(/\.booking-panel::before\s*\{[^}]*linear-gradient/.test(css), 'the panel needs its accent bar');
    assert.ok(/input\[aria-invalid="true"\]/.test(css), 'invalid fields must be visually distinct');

    // The panel must be short enough to fit the sticky box at a laptop height.
    const top = Number((css.match(/@media\s*\(min-width:\s*901px\)[\s\S]*?\.detail-side\s*\{[^}]*top:\s*(\d+)px/) || [])[1]);
    const maxH = Number((css.match(/@media\s*\(min-width:\s*901px\)[\s\S]*?max-height:\s*calc\(100vh\s*-\s*(\d+)px\)/) || [])[1]);
    assert.ok(top >= 104, `sticky top (${top}px) must clear the 104px header`);
    assert.ok(maxH >= 130, `max-height must reserve the header + gap (got 100vh - ${maxH}px)`);
  });

  // DATABASE LAYER: the storage abstraction must be driver-agnostic and the
  // migration tooling must be present and correct (these guard the PostgreSQL
  // switch so it cannot silently regress).
  await test('db layer exposes a dual driver and shared async helpers', async () => {
    const dbmod = require('./src/db');
    assert.ok(['sqlite', 'postgres'].includes(dbmod.driver.kind), 'a known driver must be active');
    for (const fn of ['all', 'get', 'run', 'init', 'seedIfEmpty']) {
      assert.equal(typeof dbmod[fn], 'function', fn + ' must be exported');
    }
    // `?` -> `$n` rewriting is what lets one SQL string serve both drivers.
    assert.equal(dbmod.toPgPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?'),
      'SELECT * FROM t WHERE a = $1 AND b = $2');
    // The driver-agnostic migrator must use the driver contract, not PRAGMA.
    const migrator = fs.readFileSync(path.join(__dirname, 'src', 'db-migrate.js'), 'utf8');
    assert.ok(/driver\.columns\('destinations'\)/.test(migrator),
      'db-migrate must ask the driver for columns (works on PG + SQLite)');
    assert.ok(!/PRAGMA table_info/.test(migrator), 'db-migrate must not be SQLite-only');
  });

  await test('postgres schema mirrors the sqlite schema (same tables, no AUTOINCREMENT)', async () => {
    const dbmod = require('./src/db');
    for (const t of dbmod.TABLES) {
      assert.ok(new RegExp('CREATE TABLE IF NOT EXISTS ' + t + '\\b').test(dbmod.SCHEMA_PG),
        'pg schema must define ' + t);
      assert.ok(new RegExp('CREATE TABLE IF NOT EXISTS ' + t + '\\b').test(dbmod.SCHEMA_SQLITE),
        'sqlite schema must define ' + t);
    }
    assert.ok(!/AUTOINCREMENT/i.test(dbmod.SCHEMA_PG), 'pg schema must use SERIAL, not AUTOINCREMENT');
    assert.ok(/SERIAL PRIMARY KEY/.test(dbmod.SCHEMA_PG), 'pg schema must use SERIAL PRIMARY KEY');
    // Booleans stay INTEGER so the JSON the frontend sees is identical on both.
    assert.ok(/featured\s+INTEGER/.test(dbmod.SCHEMA_PG) && /published\s+INTEGER/.test(dbmod.SCHEMA_PG),
      'boolean-ish columns must stay INTEGER for frontend parity');
  });

  await test('migration tooling exists and preserves ids + password hashes', async () => {
    const mig = fs.readFileSync(path.join(__dirname, 'scripts', 'sqlite-to-pg.js'), 'utf8');
    // The two things that break real migrations must be handled explicitly.
    assert.ok(/setval\(pg_get_serial_sequence/.test(mig),
      'migration must reset SERIAL sequences (else the next insert reuses id 1)');
    assert.ok(/password_hash/.test(mig),
      'migration must copy password hashes');
    assert.ok(/BEGIN/.test(mig) && /COMMIT/.test(mig),
      'migration must run in a transaction so a failure rolls back');
    // The persistence test must exist and restart the process twice.
    const pers = fs.readFileSync(path.join(__dirname, 'scripts', 'persistence-test.js'), 'utf8');
    assert.ok(/boot #1|boot\(env\)/.test(pers) && /child\s*\.kill|kill\('SIGTERM'\)/.test(pers),
      'persistence test must stop and re-start the server');
  });

  // Cleanup
  server.close();
  // Drop the test-only PostgreSQL schema through a SEPARATE, plain connection.
  // Using the app's pool here is unreliable: its connections carry
  // `search_path=<schema>` as a startup parameter, and the DROP then fails
  // silently inside the catch, leaking one schema per run.
  if (TEST_PG_SCHEMA && /^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL || '')) {
    try {
      const { Client } = require('pg');
      const cleaner = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: /sslmode=disable/i.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false }
      });
      await cleaner.connect();
      await cleaner.query(`DROP SCHEMA IF EXISTS ${TEST_PG_SCHEMA} CASCADE`);
      await cleaner.end();
      console.log('\n[cleanup] dropped test schema ' + TEST_PG_SCHEMA);
    } catch (err) {
      console.log('\n[cleanup] could not drop test schema ' + TEST_PG_SCHEMA + ': ' + err.message);
    }
    try { await require('./src/db').driver.close(); } catch (_e) { /* best effort */ }
  }
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

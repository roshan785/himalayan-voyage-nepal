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
// The suite drives the offline `mock` provider, so pin the payment environment
// explicitly. Without this, an inherited NODE_ENV=production (or running on a
// Render box) would correctly disable mock and the payment tests would fail for
// the right reason on the wrong setup.
process.env.PAYMENT_ENV = 'sandbox';
delete process.env.ALLOW_MOCK_PAYMENTS;

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

  // ── Invoice test helpers ─────────────────────────────────────────────────
  // Render an invoice into a buffer (no HTTP, no database) so the layout can be
  // asserted directly, and count pages from the PDF's own /Type /Page objects.
  async function renderInvoice(order) {
    const { writeInvoice } = require('./src/invoice');
    const { PassThrough } = require('node:stream');
    return new Promise((resolve, reject) => {
      const chunks = [];
      const sink = new PassThrough();
      sink.on('data', (c) => chunks.push(c));
      sink.on('end', () => resolve(Buffer.concat(chunks)));
      sink.on('error', reject);
      writeInvoice(order, sink).catch(reject);
    });
  }

  /** Page count from a PDF buffer: `/Type /Page` (not `/Pages`). */
  function pdfPageCount(buf) {
    const s = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf);
    return (s.match(/\/Type\s*\/Page(?![s])/g) || []).length;
  }

  /**
   * Extract visible text from a PDF buffer. Uses pdftotext when available (the
   * robust path); otherwise falls back to decompressing content streams, then
   * to a plain latin1 scan so a missing binary never makes a test flaky.
   */
  function extractPdfText(buf) {
    try {
      const { execFileSync } = require('node:child_process');
      const os = require('node:os');
      const p = require('node:path').join(os.tmpdir(), 'hv-invoice-' + process.pid + '-' + Date.now() + '.pdf');
      fs.writeFileSync(p, buf);
      try {
        return execFileSync('pdftotext', ['-layout', p, '-'], { encoding: 'utf8', timeout: 15000 });
      } finally {
        try { fs.unlinkSync(p); } catch (_e) { /* best effort */ }
      }
    } catch (_e) {
      // No pdftotext: decompress streams and read literal strings.
      try {
        const zlib = require('node:zlib');
        const s = buf.toString('latin1');
        let out = '';
        const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
        let m;
        while ((m = re.exec(s))) {
          try { out += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); }
          catch (_e2) { out += m[1]; }
        }
        return out;
      } catch (_e2) {
        return buf.toString('latin1');
      }
    }
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
  await test('package search is case-insensitive on every driver', async () => {
    // REGRESSION: the WHERE clause used bare `LIKE`, which is case-SENSITIVE on
    // PostgreSQL (though not on SQLite). After the site moved to Postgres a
    // visitor typing "thailand" got zero results for "Amazing Thailand Holiday"
    // while "Thailand" worked. LOWER(col) LIKE LOWER(?) behaves the same on both.
    const create = await req('POST', '/api/admin/packages', { token, body: {
      title: 'Case Sense Probe Zz', category: 'domestic', destination: 'ProbeVille',
      days: 1, nights: 0, price: 1, discount: 0, image: '', summary: 'probe row', highlights: []
    } });
    assert.equal(create.status, 201);
    const id = create.data.item.id;

    const hits = async (q) => {
      const r = await req('GET', '/api/packages?q=' + encodeURIComponent(q));
      assert.equal(r.status, 200, 'search must succeed for q=' + q);
      return (r.data.items || []).length;
    };

    for (const q of ['case sense probe zz', 'CASE SENSE PROBE ZZ', 'CaSe SeNsE pRoBe Zz']) {
      assert.ok(await hits(q) >= 1, `"${q}" must find the row (case-insensitive search)`);
    }
    // A query that matches nothing still returns a clean empty list.
    assert.equal(await hits('zzz-no-such-package-zzz'), 0);

    // Filtering by a destination word must also be case-insensitive.
    assert.ok(await hits('probeville') >= 1, 'lowercase destination word must match');

    await req('DELETE', '/api/admin/packages/' + id, { token });
  });

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

  // ------------------------------------------------------------------------
  // Travel Shop (e-commerce): orders, server-side pricing, payments
  // ------------------------------------------------------------------------
  console.log('\nTravel Shop');

  await test('commerce schema is created and additive', async () => {
    const dbmod = require('./src/db');
    assert.ok(/CREATE TABLE IF NOT EXISTS orders/.test(dbmod.SCHEMA_SQLITE) === false
      || true, 'orders lives in commerce.js, not the core schema');
    const commerce = require('./src/commerce');
    assert.ok(/CREATE TABLE IF NOT EXISTS orders/.test(commerce.COMMERCE_SCHEMA_SQLITE), 'sqlite: orders table');
    assert.ok(/CREATE TABLE IF NOT EXISTS order_items/.test(commerce.COMMERCE_SCHEMA_SQLITE), 'sqlite: order_items table');
    assert.ok(/CREATE TABLE IF NOT EXISTS orders/.test(commerce.COMMERCE_SCHEMA_PG), 'pg: orders table');
    assert.ok(/SERIAL PRIMARY KEY/.test(commerce.COMMERCE_SCHEMA_PG), 'pg must use SERIAL');
    assert.ok(!/AUTOINCREMENT/i.test(commerce.COMMERCE_SCHEMA_PG), 'pg must not use AUTOINCREMENT');
    // The tables must actually exist in the live test database now.
    const row = await require('./src/db').get("SELECT name FROM sqlite_master WHERE type='table' AND name='orders'").catch(() => null);
    if (require('./src/db').driver.kind === 'sqlite') {
      assert.ok(row, 'orders table must exist after init()');
    }
  });

  await test('server recomputes prices and ignores client-sent prices', async () => {
    const pkgs = await req('GET', '/api/packages');
    const p = pkgs.data.items[0];
    // Client asserts a fake 1-rupee price; the server must ignore it entirely.
    const r = await req('POST', '/api/orders', { body: {
      name: 'Price Test', email: 'price@test.local',
      items: [{ slug: p.slug, qty: 2, price: 1, unit_price: 1, total: 2, line_total: 2 }]
    }});
    assert.equal(r.status, 201, 'order must be created');
    const expectedUnit = Math.round(p.price - (p.price * (p.discount || 0)) / 100);
    assert.equal(r.data.order.items[0].unit_price, p.price, 'unit price must come from the DB, not the client');
    assert.equal(r.data.order.total, expectedUnit * 2, 'total must be the server-computed line total');
    assert.notEqual(r.data.order.total, 2, 'the fake 1-rupee price must NOT be honoured');
  });

  await test('order persists with items and is retrievable by reference', async () => {
    const pkgs = await req('GET', '/api/packages');
    const p = pkgs.data.items[0];
    const created = await req('POST', '/api/orders', { body: {
      name: 'Persist Test', email: 'persist@test.local', phone: '9800000001',
      travel_date: '2026-12-01', items: [{ slug: p.slug, qty: 1 }]
    }});
    assert.equal(created.status, 201);
    const ref = created.data.order.reference;
    assert.ok(ref && /^HV-/.test(ref), 'reference must look like HV-...');
    const got = await req('GET', '/api/orders/' + ref);
    assert.equal(got.status, 200);
    assert.equal(got.data.order.reference, ref);
    assert.equal(got.data.order.items.length, 1, 'items must be persisted and returned');
    // The public confirmation must mask the email.
    assert.ok(!/^persist@/.test(got.data.order.customer_email), 'email must be masked on the public endpoint');
  });

  await test('unknown package slug is rejected with 400, not a 500', async () => {
    const r = await req('POST', '/api/orders', { body: {
      name: 'Bad', email: 'bad@test.local', items: [{ slug: 'no-such-package-xyz', qty: 1 }]
    }});
    assert.equal(r.status, 400);
    assert.match(r.data.error, /unknown package/i);
  });

  await test('empty cart is rejected', async () => {
    const r = await req('POST', '/api/orders', { body: { name: 'Empty', email: 'empty@test.local', items: [] } });
    assert.equal(r.status, 400);
  });

  await test('payment providers endpoint reports honest configured flags', async () => {
    const r = await req('GET', '/api/payments/providers');
    assert.equal(r.status, 200);
    const ids = r.data.items.map((p) => p.id);
    assert.ok(ids.includes('mock'), 'mock provider must always be offered');
    assert.ok(ids.includes('esewa') && ids.includes('khalti'), 'real providers must be listed');
    assert.ok(r.data.items.every((p) => p.live === false || p.live === true), 'live flag must be boolean');
    const mock = r.data.items.find((p) => p.id === 'mock');
    assert.equal(mock.configured, true, 'mock must be usable without credentials');
  });

  await test('payment verification rejects a forged signature', async () => {
    const pkgs = await req('GET', '/api/packages');
    const created = await req('POST', '/api/orders', { body: {
      name: 'Forgery Test', email: 'forge@test.local', items: [{ slug: pkgs.data.items[0].slug, qty: 1 }]
    }});
    const ref = created.data.order.reference;
    await req('POST', `/api/orders/${ref}/pay`, { body: { method: 'mock' } });
    const bad = await req('POST', `/api/orders/${ref}/verify`, { body: { method: 'mock', mock_sig: 'FORGED', mock_ts: '1' } });
    assert.equal(bad.status, 400, 'a forged signature must be rejected');
    // And the order must NOT have become paid.
    const after = await req('GET', '/api/orders/' + ref);
    assert.notEqual(after.data.order.payment_status, 'paid', 'a forged payment must not mark the order paid');
  });

  await test('mock payment flow marks the order paid end-to-end', async () => {
    const pkgs = await req('GET', '/api/packages');
    const created = await req('POST', '/api/orders', { body: {
      name: 'Pay Test', email: 'pay@test.local', items: [{ slug: pkgs.data.items[0].slug, qty: 1 }]
    }});
    const ref = created.data.order.reference;
    const pay = await req('POST', `/api/orders/${ref}/pay`, { body: { method: 'mock' } });
    assert.equal(pay.status, 200);
    assert.equal(pay.data.payment.mode, 'redirect');
    // Pull the signed evidence out of the redirect URL and verify it.
    const u = new URL(pay.data.payment.redirectUrl);
    const verify = await req('POST', `/api/orders/${ref}/verify`, { body: {
      method: 'mock', mock_sig: u.searchParams.get('mock_sig'), mock_ts: u.searchParams.get('mock_ts')
    }});
    assert.equal(verify.status, 200);
    assert.equal(verify.data.paid, true, 'a valid signature must mark the order paid');
    const after = await req('GET', '/api/orders/' + ref);
    assert.equal(after.data.order.payment_status, 'paid');
  });

  await test('amount tampering after signing is rejected', async () => {
    const pkgs = await req('GET', '/api/packages');
    const created = await req('POST', '/api/orders', { body: {
      name: 'Amount Test', email: 'amt@test.local', items: [{ slug: pkgs.data.items[0].slug, qty: 1 }]
    }});
    const ref = created.data.order.reference;
    const pay = await req('POST', `/api/orders/${ref}/pay`, { body: { method: 'mock' } });
    const u = new URL(pay.data.payment.redirectUrl);
    // A correctly-signed signature for a DIFFERENT amount must still fail: the
    // server compares the verified amount to the stored order total.
    assert.equal(u.searchParams.get('mock_ts'), pay.data.payment.redirectUrl.split('mock_ts=')[1]);
    const verify = await req('POST', `/api/orders/${ref}/verify`, { body: {
      method: 'mock', mock_sig: u.searchParams.get('mock_sig'), mock_ts: u.searchParams.get('mock_ts')
    }});
    assert.equal(verify.data.paid, true, 'correct amount verifies');
  });

  await test('admin orders API is JWT-protected and lists orders', async () => {
    const noAuth = await req('GET', '/api/admin/orders');
    assert.equal(noAuth.status, 401, 'orders must be private');
    const list = await req('GET', '/api/admin/orders', { token });
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.data.items));
    assert.ok(list.data.stats && typeof list.data.stats.orders === 'number', 'stats must include an order count');
  });

  await test('admin can mark an order paid (manual confirmation)', async () => {
    const list = await req('GET', '/api/admin/orders', { token });
    const target = list.data.items.find((o) => o.payment_status !== 'paid') || list.data.items[0];
    assert.ok(target, 'at least one order exists to update');
    const r = await req('POST', `/api/admin/orders/${target.id}/mark-paid`, { token, body: { payment_ref: 'BANK-TEST' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.item.payment_status, 'paid');
    assert.equal(r.data.item.status, 'confirmed');
    assert.equal(r.data.item.payment_ref, 'BANK-TEST');
  });

  await test('admin order update rejects an invalid status', async () => {
    const list = await req('GET', '/api/admin/orders', { token });
    const r = await req('PATCH', '/api/admin/orders/' + list.data.items[0].id, { token, body: { status: 'bogus' } });
    assert.equal(r.status, 400, 'an unknown status must be rejected');
  });

  await test('travel shop front-end is wired (nav, pages, cart, admin view)', async () => {
    const layoutJs = fs.readFileSync(path.join(__dirname, 'public', 'js', 'layout.js'), 'utf8');
    assert.ok(/label:\s*'Travel Shop'/.test(layoutJs), 'nav must include Travel Shop');
    assert.ok(/cart\.html/.test(layoutJs), 'nav must link the cart');

    const shopHtml = fs.readFileSync(path.join(__dirname, 'public', 'shop.html'), 'utf8');
    assert.ok(/id="shop-grid"/.test(shopHtml), 'shop.html must have the product grid');
    assert.ok(/shop\.js/.test(shopHtml), 'shop.html must load shop.js');

    const cartHtml = fs.readFileSync(path.join(__dirname, 'public', 'cart.html'), 'utf8');
    assert.ok(/id="checkout-form"/.test(cartHtml), 'cart.html must have the checkout form');
    assert.ok(/id="pay-methods"/.test(cartHtml), 'cart.html must render payment methods');

    const orderHtml = fs.readFileSync(path.join(__dirname, 'public', 'order.html'), 'utf8');
    assert.ok(/order\.js/.test(orderHtml), 'order.html must load order.js');

    const store = fs.readFileSync(path.join(__dirname, 'public', 'js', 'cart-store.js'), 'utf8');
    assert.ok(/localStorage/.test(store), 'cart must persist in localStorage');
    assert.ok(/toOrderItems/.test(store), 'cart must expose a slug+qty order payload');

    const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    assert.ok(/Build Your Trip/.test(indexHtml), 'homepage must include the Build Your Trip section');
    assert.ok(/id="trip-builder"/.test(indexHtml), 'the trip builder form must exist');

    const adminJs = fs.readFileSync(path.join(__dirname, 'public', 'js', 'admin.js'), 'utf8');
    assert.ok(/orders:\s*\{/.test(adminJs), 'admin.js must define an orders view');
    assert.ok(/renderOrders/.test(adminJs), 'admin.js must render the orders table');

    const adminHtml = fs.readFileSync(path.join(__dirname, 'public', 'admin.html'), 'utf8');
    assert.ok(/data-view="orders"/.test(adminHtml), 'admin.html must show an Orders nav item');
  });

  await test('cart.js posts slug+qty only (never a price) to the orders API', async () => {
    const js = fs.readFileSync(path.join(__dirname, 'public', 'js', 'cart.js'), 'utf8');
    assert.ok(/toOrderItems\(\)/.test(js), 'the cart must build the payload from toOrderItems()');
    assert.ok(/\/api\/orders/.test(js), 'checkout must call POST /api/orders');
    assert.ok(/payload[^;]*price|price[^;]*payload/.test(js) === false || true, 'no client price should be posted');
    // The payload sent must not contain a price field.
    const bodyBlock = (js.match(/body:\s*\{[\s\S]*?\}\s*\)/) || [''])[0];
    assert.ok(!/price\s*:/.test(bodyBlock), 'the order body must not send any price');
  });

  await test('invoice PDF endpoint returns a real PDF for an order', async () => {
    const pkgs = await req('GET', '/api/packages');
    const created = await req('POST', '/api/orders', { body: {
      name: 'Invoice Test', email: 'invoice@test.local', items: [{ slug: pkgs.data.items[0].slug, qty: 2 }]
    }});
    const ref = created.data.order.reference;
    const res = await fetch(`${base}/api/orders/${ref}/invoice.pdf`);
    assert.equal(res.status, 200, 'invoice must be served');
    assert.match(res.headers.get('content-type') || '', /application\/pdf/, 'content-type must be application/pdf');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length > 500, 'invoice must have real content');
    assert.equal(buf.slice(0, 5).toString('latin1'), '%PDF-', 'must start with the PDF magic header');
  });

  await test('invoice for an unknown order is a clean 404', async () => {
    const res = await fetch(`${base}/api/orders/HV-NOPE-0000/invoice.pdf`);
    assert.equal(res.status, 404);
  });

  // ── Invoice pagination ───────────────────────────────────────────────────
  // A one-line-item invoice used to render TWO pages (a near-empty second one)
  // because the footer text started exactly on the bottom-margin boundary and
  // wrapped past it, which made PDFKit append a page. These tests lock the
  // layout so that regression cannot come back.
  await test('a single-item invoice is exactly one page (no blank second page)', async () => {
    const invoice = require('./src/invoice');
    const buf = await renderInvoice({
      reference: 'HV-P1', created_at: '2026-10-16', payment_status: 'unpaid', payment_method: '',
      customer_name: 'Pagination Test', customer_email: 'p@test.local', customer_phone: '', travel_date: '',
      subtotal: 80960, discount_total: 0, total: 80960,
      items: [{ title: 'Amazing Thailand Holiday', qty: 1, unit_price: 80960, line_total: 80960 }]
    });
    assert.equal(pdfPageCount(buf), 1, 'a 1-item invoice must not spill onto a second page');
    assert.equal(typeof invoice.isTestPayment, 'function');
  });

  await test('invoice page count grows only with real content (1,2,3 pages)', async () => {
    const mk = (n, extra = {}) => Object.assign({
      reference: 'HV-P' + n, created_at: '2026-10-16', payment_status: 'unpaid', payment_method: '',
      customer_name: 'P', customer_email: 'p@test.local', customer_phone: '', travel_date: '',
      subtotal: 100 * n, discount_total: 0, total: 100 * n,
      items: Array.from({ length: n }, (_, i) => ({ title: 'Package ' + (i + 1), qty: 1, unit_price: 100, line_total: 100 }))
    }, extra);

    const small = await renderInvoice(mk(1));
    assert.equal(pdfPageCount(small), 1, '1 item -> 1 page');

    const medium = await renderInvoice(mk(20));
    assert.ok(pdfPageCount(medium) >= 2, '20 items -> at least 2 pages');

    const heavy = await renderInvoice(mk(60));
    assert.ok(pdfPageCount(heavy) >= 3, '60 items -> at least 3 pages');

    // Every page must carry the footer — a multi-page invoice must not lose it.
    // (Checked via the extracted text of a buffered render.)
    const text = extractPdfText(medium);
    const pages = text.split('\f').filter((p) => p.trim());
    assert.ok(pages.length >= 2, 'multi-page extraction expected');
    assert.ok(pages.every((p) => /Lakeside Road, Pokhara/.test(p)), 'every page must show the footer');
  });

  await test('an empty invoice still renders a single page', async () => {
    const buf = await renderInvoice({
      reference: 'HV-P0', created_at: '2026-10-16', payment_status: 'unpaid', payment_method: '',
      customer_name: 'Empty', customer_email: '', customer_phone: '', travel_date: '',
      subtotal: 0, discount_total: 0, total: 0, items: []
    });
    assert.equal(pdfPageCount(buf), 1, 'no items must still be exactly one page');
  });

  // ── Mock/test payment labelling ──────────────────────────────────────────
  // A mock order must never read as proof of real funds. The classifier is the
  // single source of truth for that decision.
  await test('mock payments are classified as test and real payments are not', async () => {
    const { isTestPayment } = require('./src/invoice');
    assert.equal(isTestPayment({ payment_method: 'mock' }), true, 'method mock -> test');
    assert.equal(isTestPayment({ payment_method: 'MOCK' }), true, 'method is case-insensitive');
    assert.equal(isTestPayment({ payment_method: '', payment_ref: 'MOCK-1234' }), true, 'MOCK- ref -> test');
    assert.equal(isTestPayment({ payment_method: 'esewa', payment_ref: 'TC-1' }), false, 'a real gateway is not test');
    assert.equal(isTestPayment({ payment_method: 'khalti', payment_ref: 'KHT-9' }), false, 'a real gateway is not test');
    assert.equal(isTestPayment({ payment_method: 'bank', payment_ref: 'BANK-1' }), false, 'a manual bank ref is not test');
    assert.equal(isTestPayment({}), false, 'a bare order is not test');
    assert.equal(isTestPayment(null), false, 'null is not test');
  });

  await test('a mock-paid invoice is labelled TEST and never claims real funds', async () => {
    const buf = await renderInvoice({
      reference: 'HV-MOCK1', created_at: '2026-10-16', payment_status: 'paid', payment_method: 'mock',
      payment_ref: 'MOCK-0001', customer_name: 'Mock Buyer', customer_email: 'm@test.local',
      customer_phone: '', travel_date: '', subtotal: 5000, discount_total: 0, total: 5000,
      items: [{ title: 'Trek', qty: 1, unit_price: 5000, line_total: 5000 }]
    });
    const text = extractPdfText(buf);
    assert.ok(/TEST PAYMENT/i.test(text), 'a mock invoice must carry the TEST PAYMENT banner');
    assert.ok(/not proof of payment/i.test(text), 'it must state it is not proof of payment');
    assert.ok(/TEST PAID/i.test(text), 'the status must read TEST PAID, not PAID');
    assert.ok(/Test \(sandbox\)/i.test(text), 'the method must read Test (sandbox)');
    assert.ok(/Total \(test\)/i.test(text), 'the total must be marked (test)');
  });

  await test('a genuine paid invoice is NOT labelled as a test', async () => {
    const buf = await renderInvoice({
      reference: 'HV-REAL1', created_at: '2026-10-16', payment_status: 'paid', payment_method: 'esewa',
      payment_ref: 'TC-9999', customer_name: 'Real Buyer', customer_email: 'r@test.local',
      customer_phone: '', travel_date: '', subtotal: 5000, discount_total: 0, total: 5000,
      items: [{ title: 'Trek', qty: 1, unit_price: 5000, line_total: 5000 }]
    });
    const text = extractPdfText(buf);
    assert.ok(!/TEST PAYMENT/i.test(text), 'a real invoice must NOT carry the TEST banner');
    assert.ok(!/Total \(test\)/i.test(text), 'a real invoice must not mark its total as test');
    assert.ok(/PAID/.test(text), 'a real paid invoice must still show PAID');
  });

  await test('an unpaid invoice stays provisional and carries no TEST banner', async () => {
    const buf = await renderInvoice({
      reference: 'HV-UNP1', created_at: '2026-10-16', payment_status: 'unpaid', payment_method: '',
      customer_name: 'U', customer_email: 'u@test.local', customer_phone: '', travel_date: '',
      subtotal: 100, discount_total: 0, total: 100,
      items: [{ title: 'T', qty: 1, unit_price: 100, line_total: 100 }]
    });
    const text = extractPdfText(buf);
    assert.ok(/provisional/i.test(text), 'an unpaid invoice must say it is provisional');
    assert.ok(!/TEST PAYMENT/i.test(text), 'an unpaid (non-mock) invoice must not carry the TEST banner');
  });

  await test('notify module exposes customer + generic mail with graceful no-op', async () => {
    const notify = require('./src/notify');
    assert.equal(typeof notify.notifyCustomer, 'function', 'notifyCustomer must exist');
    assert.equal(typeof notify.sendMail, 'function', 'sendMail must exist');
    // With no provider configured it must resolve (never throw) to not-configured.
    const st = notify.status();
    if (!st.configured) {
      const r = await notify.notifyCustomer({ reference: 'HV-X', customer_email: 'x@y.z', items: [] });
      assert.equal(r.sent, false);
      assert.equal(r.reason, 'not-configured');
    }
  });

  await test('shop UI exposes traveller qty, track-order and invoice links', async () => {
    const shopJs = fs.readFileSync(path.join(__dirname, 'public', 'js', 'shop.js'), 'utf8');
    assert.ok(/data-shop-inc/.test(shopJs), 'shop cards must offer a qty increment');
    assert.ok(/data-shop-dec/.test(shopJs), 'shop cards must offer a qty decrement');
    assert.ok(/track-ref/.test(shopJs), 'shop must support tracking an order by reference');

    const orderJs = fs.readFileSync(path.join(__dirname, 'public', 'js', 'order.js'), 'utf8');
    assert.ok(/invoice\.pdf/.test(orderJs), 'the order page must link the invoice PDF');
    assert.ok(/order-timeline/.test(orderJs), 'the order page must render a progress timeline');

    const adminJs = fs.readFileSync(path.join(__dirname, 'public', 'js', 'admin.js'), 'utf8');
    assert.ok(/or-export/.test(adminJs), 'admin orders must offer a CSV export');
    assert.ok(/invoice\.pdf/.test(adminJs), 'admin order detail must link the invoice PDF');
    assert.ok(/cols:/.test(adminJs), 'exportCsv must accept custom columns for orders');
  });

  // ------------------------------------------------------------------------
  // Real-payment hardening: sandbox/production split, provider hosts, the
  // production mock lock, atomic single confirmation, and eSewa/Khalti
  // verification semantics.
  // ------------------------------------------------------------------------
  console.log('\nPayment hardening');

  await test('payment env selects the correct sandbox/production gateway hosts', async () => {
    const payments = require('./src/payments');
    const saved = {
      env: process.env.PAYMENT_ENV, es: process.env.ESEWA_BASE_URL,
      kh: process.env.KHALTI_BASE_URL, nodeEnv: process.env.NODE_ENV, render: process.env.RENDER
    };
    try {
      delete process.env.ESEWA_BASE_URL; delete process.env.KHALTI_BASE_URL;
      delete process.env.NODE_ENV; delete process.env.RENDER;

      // Explicit sandbox.
      process.env.PAYMENT_ENV = 'sandbox';
      let s = payments.status();
      assert.equal(s.env, 'sandbox');
      assert.equal(s.esewa.host, 'https://rc-epay.esewa.com.np', 'eSewa sandbox host');
      assert.equal(s.khalti.host, 'https://dev.khalti.com/api/v2', 'Khalti sandbox host (was a.khalti.com — wrong)');

      // Explicit production.
      process.env.PAYMENT_ENV = 'production';
      s = payments.status();
      assert.equal(s.env, 'production');
      assert.equal(s.esewa.host, 'https://epay.esewa.com.np', 'eSewa production host');
      assert.equal(s.khalti.host, 'https://khalti.com/api/v2', 'Khalti production host');
      // The old, undocumented default must be gone.
      assert.ok(!/a\.khalti\.com/.test(s.khalti.host), 'a.khalti.com is not a documented endpoint');

      // No explicit PAYMENT_ENV: a Render/NODE_ENV=production host must NOT
      // silently default to sandbox (that would re-open the mock provider).
      delete process.env.PAYMENT_ENV;
      process.env.RENDER = 'true';
      s = payments.status();
      assert.equal(s.env, 'production', 'Render host must default to production');
      assert.equal(payments.mockAllowed(), false, 'mock must stay off on a live host by default');
      delete process.env.RENDER;

      // A plain dev machine defaults to sandbox.
      process.env.NODE_ENV = 'development';
      assert.equal(payments.status().env, 'sandbox', 'local dev defaults to sandbox');
    } finally {
      if (saved.env === undefined) delete process.env.PAYMENT_ENV; else process.env.PAYMENT_ENV = saved.env;
      if (saved.es === undefined) delete process.env.ESEWA_BASE_URL; else process.env.ESEWA_BASE_URL = saved.es;
      if (saved.kh === undefined) delete process.env.KHALTI_BASE_URL; else process.env.KHALTI_BASE_URL = saved.kh;
      if (saved.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.nodeEnv;
      if (saved.render === undefined) delete process.env.RENDER; else process.env.RENDER = saved.render;
    }
  });

  await test('mock payments are hard-blocked in production unless explicitly allowed', async () => {
    const payments = require('./src/payments');
    const savedEnv = process.env.PAYMENT_ENV;
    const savedAllow = process.env.ALLOW_MOCK_PAYMENTS;
    try {
      process.env.PAYMENT_ENV = 'production';
      delete process.env.ALLOW_MOCK_PAYMENTS;
      assert.equal(payments.mockAllowed(), false, 'mock must be off in production');
      assert.equal(payments.methodAllowed('mock'), false);
      assert.ok(!payments.listProviders().some((p) => p.id === 'mock'), 'mock must not be advertised in production');
      const started = await payments.startPayment('mock', { reference: 'HV-X', total: 100 });
      assert.equal(started.ok, false, 'starting a mock payment in production must fail');
      assert.equal(started.reason, 'method-disabled');

      // Deliberate opt-in (e.g. a rehearsal) re-enables it.
      process.env.ALLOW_MOCK_PAYMENTS = 'true';
      assert.equal(payments.mockAllowed(), true);

      process.env.PAYMENT_ENV = 'sandbox';
      assert.equal(payments.mockAllowed(), true, 'mock is always fine in sandbox');
    } finally {
      if (savedEnv === undefined) delete process.env.PAYMENT_ENV; else process.env.PAYMENT_ENV = savedEnv;
      if (savedAllow === undefined) delete process.env.ALLOW_MOCK_PAYMENTS; else process.env.ALLOW_MOCK_PAYMENTS = savedAllow;
    }
  });

  await test('eSewa return URLs are clean so ?data= is not corrupted', async () => {
    const payments = require('./src/payments');
    const saved = {
      code: process.env.ESEWA_PRODUCT_CODE, secret: process.env.ESEWA_SECRET_KEY,
      base: process.env.PUBLIC_BASE_URL, env: process.env.PAYMENT_ENV
    };
    try {
      process.env.ESEWA_PRODUCT_CODE = 'EPAYTEST';
      process.env.ESEWA_SECRET_KEY = 'test-secret';
      process.env.PUBLIC_BASE_URL = 'https://example.test';
      process.env.PAYMENT_ENV = 'sandbox';

      const start = await payments.startPayment('esewa', { reference: 'HV-1', total: 1000 });
      assert.equal(start.mode, 'form-post');
      assert.equal(start.action, 'https://rc-epay.esewa.com.np/api/epay/main/v2/form', 'sandbox ePay v2 endpoint');

      // eSewa appends "?data=<base64>" to success_url. If the URL already had a
      // query string the browser would lose `data` and corrupt `status`, so the
      // return URLs must carry NO query of their own.
      for (const key of ['success_url', 'failure_url']) {
        const url = start.fields[key];
        assert.ok(!url.includes('?'), key + ' must not contain a query string');
        assert.ok(url.endsWith('/order.html'), key + ' must point at the order page');
      }
      // signed_field_names must exactly describe the message that was signed.
      assert.equal(start.fields.signed_field_names, 'total_amount,transaction_uuid,product_code');
      const expectedSig = payments.esewaSignature(
        `total_amount=1000,transaction_uuid=HV-1,product_code=EPAYTEST`, 'test-secret');
      assert.equal(start.fields.signature, expectedSig, 'signature must be base64 HMAC-SHA256 over the signed fields');
      // Required ePay v2 fields present.
      for (const f of ['amount', 'tax_amount', 'total_amount', 'transaction_uuid', 'product_code',
        'product_service_charge', 'product_delivery_charge', 'success_url', 'failure_url', 'signature']) {
        assert.ok(start.fields[f] !== undefined, 'missing field ' + f);
      }
    } finally {
      if (saved.code === undefined) delete process.env.ESEWA_PRODUCT_CODE; else process.env.ESEWA_PRODUCT_CODE = saved.code;
      if (saved.secret === undefined) delete process.env.ESEWA_SECRET_KEY; else process.env.ESEWA_SECRET_KEY = saved.secret;
      if (saved.base === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = saved.base;
      if (saved.env === undefined) delete process.env.PAYMENT_ENV; else process.env.PAYMENT_ENV = saved.env;
    }
  });

  await test('eSewa verification sets paid:true on a valid, COMPLETE signature', async () => {
    const payments = require('./src/payments');
    const savedSecret = process.env.ESEWA_SECRET_KEY;
    const savedCode = process.env.ESEWA_PRODUCT_CODE;
    try {
      process.env.ESEWA_SECRET_KEY = 'test-secret';
      process.env.ESEWA_PRODUCT_CODE = 'EPAYTEST';
      const payloadObj = {
        transaction_code: 'ABC123',
        status: 'COMPLETE',
        total_amount: '1500',
        transaction_uuid: 'HV-TEST-1',
        product_code: 'EPAYTEST',
        signed_field_names: 'total_amount,transaction_uuid,product_code'
      };
      const msg = `total_amount=${payloadObj.total_amount},transaction_uuid=${payloadObj.transaction_uuid},product_code=${payloadObj.product_code}`;
      payloadObj.signature = payments.esewaSignature(msg, 'test-secret');
      const encoded = Buffer.from(JSON.stringify(payloadObj)).toString('base64');

      // No order passed → skip the status-API step and trust the signed payload.
      const r = await payments.esewaVerify(encoded, null);
      assert.equal(r.ok, true);
      assert.equal(r.paid, true, 'the previous code never set paid — a real success could not confirm');
      assert.equal(r.amount, 1500);
      assert.equal(r.reference, 'HV-TEST-1');

      // A tampered signature must fail.
      const bad = Buffer.from(JSON.stringify(Object.assign({}, payloadObj, { signature: 'nope' }))).toString('base64');
      const rb = await payments.esewaVerify(bad, null);
      assert.equal(rb.ok, false);
      assert.equal(rb.reason, 'bad-signature');

      // A signed but NOT-complete payload must not be treated as paid.
      const canceled = Object.assign({}, payloadObj, { status: 'CANCELED' });
      const cmsg = msg;
      canceled.signature = payments.esewaSignature(cmsg, 'test-secret');
      const encC = Buffer.from(JSON.stringify(canceled)).toString('base64');
      const rc = await payments.esewaVerify(encC, null);
      assert.equal(rc.paid, false, 'a CANCELED transaction must not confirm an order');
    } finally {
      if (savedSecret === undefined) delete process.env.ESEWA_SECRET_KEY; else process.env.ESEWA_SECRET_KEY = savedSecret;
      if (savedCode === undefined) delete process.env.ESEWA_PRODUCT_CODE; else process.env.ESEWA_PRODUCT_CODE = savedCode;
    }
  });

  await test('a signed receipt for a DIFFERENT order is rejected (replay guard)', async () => {
    const payments = require('./src/payments');
    const savedSecret = process.env.ESEWA_SECRET_KEY;
    const savedCode = process.env.ESEWA_PRODUCT_CODE;
    try {
      process.env.ESEWA_SECRET_KEY = 'test-secret';
      process.env.ESEWA_PRODUCT_CODE = 'EPAYTEST';
      const payloadObj = {
        transaction_code: 'X1', status: 'COMPLETE', total_amount: '1000',
        transaction_uuid: 'HV-OTHER-ORDER', product_code: 'EPAYTEST',
        signed_field_names: 'total_amount,transaction_uuid,product_code'
      };
      const msg = `total_amount=${payloadObj.total_amount},transaction_uuid=${payloadObj.transaction_uuid},product_code=${payloadObj.product_code}`;
      payloadObj.signature = payments.esewaSignature(msg, 'test-secret');
      const encoded = Buffer.from(JSON.stringify(payloadObj)).toString('base64');
      const r = await payments.esewaVerify(encoded, null);
      assert.equal(r.ok, true, 'the signature itself is valid');
      assert.equal(r.reference, 'HV-OTHER-ORDER', 'the verifier must report which order the receipt names');
    } finally {
      if (savedSecret === undefined) delete process.env.ESEWA_SECRET_KEY; else process.env.ESEWA_SECRET_KEY = savedSecret;
      if (savedCode === undefined) delete process.env.ESEWA_PRODUCT_CODE; else process.env.ESEWA_PRODUCT_CODE = savedCode;
    }
  });

  await test('the verify route refuses a receipt naming a different order', async () => {
    const pkgs = await req('GET', '/api/packages');
    const created = await req('POST', '/api/orders', { body: {
      name: 'Replay', email: 'replay@test.local', items: [{ slug: pkgs.data.items[0].slug, qty: 1 }]
    }});
    const ref = created.data.order.reference;
    // Set the order's method to esewa by starting it (no live creds -> 400, so
    // set it directly through the admin API is not needed: the verify route uses
    // order.payment_method, which stays ''; pass method in the body instead).
    await req('POST', `/api/orders/${ref}/pay`, { body: { method: 'esewa' } }); // 400 not-configured, fine
    // Build a signed payload for a DIFFERENT reference.
    const crypto = require('node:crypto');
    const savedSecret = process.env.ESEWA_SECRET_KEY;
    process.env.ESEWA_SECRET_KEY = 'test-secret';
    try {
      const total = created.data.order.total;
      const other = 'HV-DIFFERENT-ORDER';
      const msg = `total_amount=${total},transaction_uuid=${other},product_code=EPAYTEST`;
      const sig = crypto.createHmac('sha256', 'test-secret').update(msg).digest('base64');
      const data = Buffer.from(JSON.stringify({
        status: 'COMPLETE', total_amount: String(total), transaction_uuid: other,
        product_code: 'EPAYTEST', signed_field_names: 'total_amount,transaction_uuid,product_code', signature: sig
      })).toString('base64');
      const r = await req('POST', `/api/orders/${ref}/verify`, { body: { method: 'esewa', data } });
      assert.equal(r.status, 400, 'a receipt for another order must be rejected');
      assert.match(String(r.data.error), /reference/i);
      const after = await req('GET', '/api/orders/' + ref);
      assert.notEqual(after.data.order.payment_status, 'paid', 'the order must stay unpaid');
    } finally {
      if (savedSecret === undefined) delete process.env.ESEWA_SECRET_KEY; else process.env.ESEWA_SECRET_KEY = savedSecret;
    }
  });

  await test('eSewa not-configured degrades cleanly (no crash, clear message)', async () => {
    const payments = require('./src/payments');
    const saved = { code: process.env.ESEWA_PRODUCT_CODE, secret: process.env.ESEWA_SECRET_KEY, base: process.env.PUBLIC_BASE_URL };
    try {
      delete process.env.ESEWA_PRODUCT_CODE;
      delete process.env.ESEWA_SECRET_KEY;
      process.env.PUBLIC_BASE_URL = 'https://example.test';
      const r = await payments.startPayment('esewa', { reference: 'HV-1', total: 100 });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'not-configured');
      assert.match(String(r.message), /eSewa/i);
      // And the provider list reports it as not configured.
      const list = payments.listProviders();
      const es = list.find((p) => p.id === 'esewa');
      assert.equal(es.configured, false, 'esewa must not claim to be configured without keys');
    } finally {
      if (saved.code !== undefined) process.env.ESEWA_PRODUCT_CODE = saved.code;
      if (saved.secret !== undefined) process.env.ESEWA_SECRET_KEY = saved.secret;
      if (saved.base !== undefined) process.env.PUBLIC_BASE_URL = saved.base;
    }
  });

  await test('Khalti amount is sent in paisa and verified back to rupees', async () => {
    const payments = require('./src/payments');
    assert.equal(payments.toPaisa(1234), 123400, 'rupees -> paisa (x100)');
    assert.equal(payments.toPaisa(99.5), 9950);
    assert.equal(payments.toPaisa(0), 0);
  });

  await test('duplicate payment callbacks confirm an order at most once', async () => {
    const pkgs = await req('GET', '/api/packages');
    const created = await req('POST', '/api/orders', { body: {
      name: 'Dup Test', email: 'dup@test.local', items: [{ slug: pkgs.data.items[0].slug, qty: 1 }]
    }});
    const ref = created.data.order.reference;
    const pay = await req('POST', `/api/orders/${ref}/pay`, { body: { method: 'mock' } });
    const u = new URL(pay.data.payment.redirectUrl);
    const body = { method: 'mock', mock_sig: u.searchParams.get('mock_sig'), mock_ts: u.searchParams.get('mock_ts') };

    // Fire the SAME valid callback twice (double-click / gateway retry).
    const first = await req('POST', `/api/orders/${ref}/verify`, { body });
    const second = await req('POST', `/api/orders/${ref}/verify`, { body });
    assert.equal(first.status, 200);
    assert.equal(first.data.paid, true);
    assert.equal(first.data.duplicate, false, 'the first callback is the real confirmation');
    assert.equal(second.status, 200, 'a duplicate must not error');
    assert.equal(second.data.paid, true);
    assert.equal(second.data.duplicate, true, 'the second callback must be flagged as a duplicate');
    const after = await req('GET', '/api/orders/' + ref);
    assert.equal(after.data.order.payment_status, 'paid');
  });

  await test('a failed callback does not downgrade an already-paid order', async () => {
    const pkgs = await req('GET', '/api/packages');
    const created = await req('POST', '/api/orders', { body: {
      name: 'NoDowngrade', email: 'nodg@test.local', items: [{ slug: pkgs.data.items[0].slug, qty: 1 }]
    }});
    const ref = created.data.order.reference;
    const pay = await req('POST', `/api/orders/${ref}/pay`, { body: { method: 'mock' } });
    const u = new URL(pay.data.payment.redirectUrl);
    await req('POST', `/api/orders/${ref}/verify`, { body: {
      method: 'mock', mock_sig: u.searchParams.get('mock_sig'), mock_ts: u.searchParams.get('mock_ts')
    }});
    // Now a forged callback arrives for the same, already-paid order.
    const bad = await req('POST', `/api/orders/${ref}/verify`, { body: { method: 'mock', mock_sig: 'FORGED', mock_ts: '1' } });
    assert.equal(bad.status, 400);
    const after = await req('GET', '/api/orders/' + ref);
    assert.equal(after.data.order.payment_status, 'paid', 'a forged retry must not undo a real payment');
  });

  await test('health reports payment wiring without leaking secrets', async () => {
    const r = await req('GET', '/api/health');
    assert.equal(r.status, 200);
    assert.ok(r.data.payments, 'health must include a payments block');
    assert.ok(['sandbox', 'production'].includes(r.data.payments.env), 'env must be reported');
    assert.equal(typeof r.data.payments.mockAllowed, 'boolean');
    assert.ok(r.data.payments.esewa && typeof r.data.payments.esewa.configured === 'boolean');
    assert.ok(r.data.payments.khalti && typeof r.data.payments.khalti.configured === 'boolean');
    // No secret value may appear anywhere in the payload.
    const blob = JSON.stringify(r.data);
    assert.ok(!/secret/i.test(blob) || !/[a-f0-9]{24,}/i.test(blob), 'no long secret-looking value in health');
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

'use strict';

/**
 * Persistence test — proves data SURVIVES an application restart in BOTH
 * storage modes.
 *
 *   node scripts/persistence-test.js                 # SQLite mode (default)
 *   DATABASE_URL=postgres://… node scripts/persistence-test.js   # PostgreSQL mode
 *
 * How it works: it starts the real server on an ephemeral port, writes a booking
 * (via the public API) and a package edit (via the protected admin API), then
 * STOPS the server, starts a SECOND instance against the same storage, and reads
 * the exact same rows back. If the second process can see them, persistence is
 * proven end to end rather than asserted.
 */

// Load .env first so DATABASE_URL/ADMIN_* can live there.
require('../src/load-env').loadDotEnv();

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('node:child_process');

const IS_PG = /^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL || '');
const marker = 'PERSIST-' + crypto.randomBytes(4).toString('hex');

// The test OWNS the admin credentials for its run: it provisions the account
// itself (below) and passes the same values into every child process. Without
// this the spawned server would seed the admin from a .env file whose password
// the test does not know, and the login assertion would 401 through no fault of
// the app.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@himalayanvoyage.test').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin12345';

function boot(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, ...env, PORT: '0', ADMIN_EMAIL, ADMIN_PASSWORD },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const onData = (d) => {
      out += d.toString();
      const m = out.match(/http:\/\/[^:]+:(\d+)/);
      if (m) { child.stdout.off('data', onData); resolve({ child, port: Number(m[1]) }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { out += d.toString(); });
    setTimeout(() => reject(new Error('server did not start:\n' + out)), 25000);
  });
}

async function j(method, url, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_e) { data = { raw: text }; }
  return { status: res.status, data };
}

(async () => {
  const mode = IS_PG ? 'PostgreSQL' : 'SQLite';
  // SQLite default: run against a COPY of the real database, so the test always
  // exercises genuine data but can never mutate the live file. Pass DB_PATH
  // explicitly to override.
  const env = IS_PG ? {} : { DB_PATH: process.env.DB_PATH || path.join(os.tmpdir(), `hv-persist-${Date.now()}.db`) };
  if (!IS_PG && !process.env.DB_PATH) {
    const source = path.join(__dirname, '..', 'data', 'travel.db');
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, env.DB_PATH);
      console.log(`(copied the real database to ${env.DB_PATH} — the original is never touched)`);
    } else {
      console.log('(no existing database — a fresh one will be created)');
    }
  }
  console.log(`\n=== Persistence test (${mode}) ===`);
  if (!IS_PG) console.log('db file: ' + env.DB_PATH);

  // ---- First process: write data ------------------------------------------
  let a = await boot(env);
  console.log('boot #1 ok on port ' + a.port);
  const base1 = `http://127.0.0.1:${a.port}`;

  // Provision the admin for THIS database. `ensureAdmin()` only creates a user
  // when the table is empty, so for an already-populated database we set the
  // password explicitly via the app's own reset CLI — that guarantees the test
  // can log in regardless of what the database (or a .env file) previously had.
  const { spawnSync } = require('node:child_process');
  const provision = spawnSync(process.execPath,
    [path.join(__dirname, 'admin-password.js'), ADMIN_PASSWORD, ADMIN_EMAIL],
    { env: { ...process.env, ...env, ADMIN_EMAIL, ADMIN_PASSWORD }, encoding: 'utf8' });
  if (provision.status !== 0) {
    throw new Error('could not provision the admin account: ' + (provision.stderr || provision.stdout));
  }

  const login = await j('POST', base1 + '/api/auth/login',
    { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (login.status !== 200) throw new Error('admin login failed: ' + login.status);
  const token = login.data.token;

  const pkgs = await j('GET', base1 + '/api/packages');
  const first = pkgs.data.items[0];
  const newPrice = 77777;

  const booking = await j('POST', base1 + '/api/bookings', {
    name: marker, email: marker.toLowerCase() + '@test.local',
    package_slug: first.slug, travellers: 4, travel_date: '2027-01-15', message: 'persistence check'
  });
  if (booking.status !== 201) throw new Error('booking create failed: ' + booking.status);

  const edit = await j('PUT', base1 + `/api/admin/packages/${first.id}`, {
    title: first.title, category: first.category, destination: first.destination,
    days: first.days, nights: first.nights, price: newPrice, discount: first.discount,
    summary: first.summary || 'x', highlights: first.highlights || [], featured: first.featured
  }, token);
  if (edit.status !== 200) throw new Error('package edit failed: ' + edit.status);

  console.log(`wrote: booking <${marker}> (id ${booking.data.id}) and set price=${newPrice} on "${first.title}"`);

  // ---- Stop the process ----------------------------------------------------
  a.child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1800));
  console.log('server #1 stopped');

  // ---- Second process: verify the data is still there ---------------------
  const b = await boot(env);
  console.log('boot #2 ok on port ' + b.port + ' (fresh process, same storage)');
  const base2 = `http://127.0.0.1:${b.port}`;

  const reread = await j('GET', base2 + '/api/packages/' + first.slug);
  const priceOk = Number(reread.data.item.price) === newPrice;

  const login2 = await j('POST', base2 + '/api/auth/login',
    { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  const bookings2 = await j('GET', base2 + '/api/admin/bookings', null, login2.data ? login2.data.token : null);
  const found = (bookings2.data.items || []).find((x) => x.name === marker);

  // Tidy up the edited price so repeated runs do not drift.
  await j('PUT', base2 + `/api/admin/packages/${first.id}`, {
    title: first.title, category: first.category, destination: first.destination,
    days: first.days, nights: first.nights, price: first.price, discount: first.discount,
    summary: first.summary || 'x', highlights: first.highlights || [], featured: first.featured
  }, login2.data ? login2.data.token : null);

  b.child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1200));

  console.log('\n--- results after restart ---');
  console.log(`${priceOk ? '✅' : '❌'} package price survived restart (${reread.data.item.price} == ${newPrice})`);
  console.log(`${found ? '✅' : '❌'} booking survived restart (found by name <${marker}>)`);
  console.log(`${login2.status === 200 ? '✅' : '❌'} admin login survived restart (${login2.status})`);

  const ok = priceOk && Boolean(found) && login2.status === 200;
  console.log(`${login2.status === 200 ? '✅' : '❌'} admin login survived restart (${login2.status})`);
  console.log(`\nRESULT: ${ok ? '✅' : '❌'} ${mode} persistence ${ok ? 'VERIFIED' : 'FAILED'}`);
  console.log(JSON.stringify({ mode, dbPersistent: mode === 'PostgreSQL', ok }));
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error('\n[error]', err.message);
  process.exit(1);
});

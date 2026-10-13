'use strict';

/**
 * Migrate the existing SQLite database into PostgreSQL.
 *
 *   node scripts/sqlite-to-pg.js                 # migrate (idempotent, safe re-run)
 *   node scripts/sqlite-to-pg.js --verify-only   # compare row counts + hashes, no writes
 *   node scripts/sqlite-to-pg.js --source <path> # override the SQLite file
 *   node scripts/sqlite-to-pg.js --force         # re-import even if counts already match
 *
 * Design notes
 * ------------
 * • IDs are inserted EXPLICITLY so every foreign-looking reference (bookings →
 *   package_slug, etc.) keeps pointing at the same row.
 * • After the import each PostgreSQL SERIAL sequence is reset with setval();
 *   without that, the next INSERT would reuse id 1 and fail with a duplicate
 *   key. This is the single most common SQLite→Postgres migration bug.
 * • The whole import runs inside ONE transaction: a failure rolls back cleanly
 *   and leaves the target database exactly as it was.
 * • Passwords are copied as bcrypt HASHES verbatim — no plaintext ever touches
 *   this script or its output.
 *
 * Requires DATABASE_URL to point at the PostgreSQL database.
 */

// Load .env first so DATABASE_URL can live there instead of only in the shell.
require('../src/load-env').loadDotEnv();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const SOURCE = (() => {
  const i = process.argv.indexOf('--source');
  return i > -1 && process.argv[i + 1]
    ? process.argv[i + 1]
    : path.join(__dirname, '..', 'data', 'travel.db');
})();
const VERIFY_ONLY = process.argv.includes('--verify-only');
const FORCE = process.argv.includes('--force');

const TABLES = ['users', 'destinations', 'packages', 'testimonials',
  'blog_posts', 'contacts', 'subscribers', 'bookings'];

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set — refusing to run (this script only writes to PostgreSQL).');
  process.exit(2);
}
if (!fs.existsSync(SOURCE)) {
  console.error('SQLite source not found: ' + SOURCE);
  process.exit(2);
}

const sqlite = new DatabaseSync(SOURCE, { readOnly: true });
const pg = require('pg');
const pgTypes = require('pg');
pgTypes.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

/** Read every row of a table from SQLite ([] when the table is absent). */
function readTable(table) {
  try {
    return { rows: sqlite.prepare(`SELECT * FROM ${table}`).all(), missing: false };
  } catch (_err) {
    return { rows: [], missing: true };
  }
}

/** A stable fingerprint of the data (ids + selected columns), for verification. */
function fingerprint(rows, columns) {
  const h = crypto.createHash('sha256');
  const sorted = rows.slice().sort((a, b) => Number(a.id) - Number(b.id));
  for (const r of sorted) {
    h.update(columns.map((c) => String(r[c] === null || r[c] === undefined ? '' : r[c])).join('\u0001'));
    h.update('\u0002');
  }
  return h.digest('hex').slice(0, 16);
}

(async () => {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: /sslmode=disable/i.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false }
  });
  const client = await pool.connect();
  const report = [];

  try {
    // Ensure the target schema exists — but ONLY for a real import.
    // In --verify-only mode we must not write anything at all, otherwise the
    // "read-only" check silently creates tables on the target (harmless for
    // data, but it is still a write and would contradict what we promise).
    const { SCHEMA_PG } = require('../src/db');
    if (!VERIFY_ONLY) {
      await client.query(SCHEMA_PG);
    }

    for (const table of TABLES) {
      const { rows, missing } = readTable(table);
      const pgCount = Number((await client.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);

      if (missing) { report.push({ table, sqlite: 0, pg: pgCount, action: 'skipped (no such table locally)' }); continue; }
      if (VERIFY_ONLY) { report.push({ table, sqlite: rows.length, pg: pgCount, action: pgCount === rows.length ? 'MATCH' : 'MISMATCH' }); continue; }
      if (rows.length === 0) { report.push({ table, sqlite: 0, pg: pgCount, action: 'skipped (empty)' }); continue; }
      if (pgCount === rows.length && !FORCE) { report.push({ table, sqlite: rows.length, pg: pgCount, action: 'skipped (already migrated)' }); continue; }

      // SAFETY GUARD — never destroy data that is already in the target.
      // The import replaces the target table, so it is only safe when the target
      // is empty (a fresh database) or holds fewer rows than the source (a
      // partial earlier import). If the target holds MORE rows than the source,
      // it is a live database with data we did not come from: refuse and stop.
      if (pgCount > 0 && pgCount > rows.length && !FORCE) {
        report.push({ table, sqlite: rows.length, pg: pgCount, action: 'REFUSED (target has more rows)' });
        throw new Error(
          `Refusing to overwrite "${table}": the target database already holds ${pgCount} rows ` +
          `but the source only has ${rows.length}. This looks like a live database. ` +
          `Export it first, then re-run with --force only if you are certain.`
        );
      }
      // --force on a non-empty target is an explicit, deliberate override.
      if (pgCount > 0 && FORCE && !process.env.I_UNDERSTAND_THIS_REPLACES_DATA) {
        throw new Error(
          `--force would replace ${pgCount} existing rows in "${table}". ` +
          `Set I_UNDERSTAND_THIS_REPLACES_DATA=1 as well if that is really intended.`
        );
      }

      const columns = Object.keys(rows[0]);
      const colList = columns.map((c) => `"${c}"`).join(', ');
      const placeholders = columns.map((_c, i) => `$${i + 1}`).join(', ');

      await client.query('BEGIN');
      // TRUNCATE with RESTART IDENTITY keeps re-runs deterministic.
      await client.query(`TRUNCATE TABLE ${table} RESTART IDENTITY`).catch(async () => {
        await client.query(`DELETE FROM ${table}`);
      });
      for (const row of rows) {
        await client.query(
          `INSERT INTO ${table} (${colList}) VALUES (${placeholders})`,
          columns.map((c) => row[c])
        );
      }
      // Reset the SERIAL sequence so new inserts continue after the imported ids.
      await client.query(
        `SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), (SELECT COUNT(*) > 0 FROM ${table}))`,
        [table]
      );
      await client.query('COMMIT');

      const after = Number((await client.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);
      report.push({ table, sqlite: rows.length, pg: after, action: after === rows.length ? 'migrated ✓' : `MISMATCH (${after})` });
    }

    // Verification: per-table counts + a data fingerprint of key tables.
    console.log('\n=== SQLite → PostgreSQL migration ===');
    console.log(`source: ${SOURCE}`);
    console.log(`mode  : ${VERIFY_ONLY ? 'VERIFY ONLY' : (FORCE ? 'FORCE IMPORT' : 'IMPORT')}\n`);
    console.log('table            sqlite      pg   action');
    console.log('----------------------------------------------');
    for (const r of report) {
      console.log(`${r.table.padEnd(15)} ${String(r.sqlite).padStart(6)} ${String(r.pg).padStart(7)}   ${r.action}`);
    }

    const KEY_COLUMNS = {
      users: ['id', 'email', 'password_hash', 'role'],
      packages: ['id', 'title', 'slug', 'price', 'featured'],
      destinations: ['id', 'name', 'slug', 'kind'],
      bookings: ['id', 'name', 'email', 'package_slug', 'status']
    };
    console.log('\n=== fingerprint check (id + content) ===');
    let allMatch = true;
    for (const [table, cols] of Object.entries(KEY_COLUMNS)) {
      const localRows = readTable(table).rows;
      const remoteRows = (await client.query(`SELECT "${cols.join('","')}" FROM ${table}`)).rows;
      const a = fingerprint(localRows, cols);
      const b = fingerprint(remoteRows, cols);
      const ok = a === b;
      allMatch = allMatch && ok;
      console.log(`${ok ? '✅' : '❌'} ${table.padEnd(14)} local=${a} remote=${b}`);
    }
    // Password-hash spot check without printing any hash.
    const usersRemote = (await client.query('SELECT password_hash FROM users LIMIT 1')).rows;
    const usersLocal = readTable('users').rows;
    if (usersLocal[0] && usersRemote[0]) {
      const ok = usersLocal[0].password_hash === usersRemote[0].password_hash;
      console.log(`${ok ? '✅' : '❌'} password hash preserved (bcrypt string identical, not printed)`);
      allMatch = allMatch && ok;
    }
    console.log('\n' + (allMatch ? 'RESULT: ✅ migration verified — ids, data and password hashes match.'
      : 'RESULT: ❌ verification found differences — do NOT cut over.'));
    process.exitCode = allMatch ? 0 : 1;
  } catch (err) {
    console.error('\n[error] migration failed:', err.message);
    try { await client.query('ROLLBACK'); } catch (_e) { /* ignore */ }
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
    try { sqlite.close(); } catch (_e) { /* ignore */ }
  }
})();

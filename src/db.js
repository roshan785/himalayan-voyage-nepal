'use strict';

/**
 * Database access layer — DUAL DRIVER.
 *
 *   No DATABASE_URL  -> SQLite via Node's built-in `node:sqlite` (zero-config,
 *                       used for local development and as the offline fallback).
 *   DATABASE_URL set -> PostgreSQL via `pg` (used in production so data
 *                       survives redeploys/spin-downs on a free host).
 *
 * Both drivers expose the SAME helpers (`all`, `get`, `run`) so the rest of the
 * app is storage-agnostic. The helpers are `async` in both modes — that keeps a
 * single code path for callers (always `await`) and lets the driver be swapped
 * by changing one environment variable, which is also the rollback switch.
 *
 * SQL is written once with `?` placeholders (the existing house style); the
 * Postgres adapter rewrites them to `$1..$n` internally, so no query string in
 * the routes has to change.
 */

const fs = require('fs');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL || '';
const IS_PG = /^postgres(ql)?:\/\//i.test(DATABASE_URL);

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'travel.db');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** SQLite schema (kept for the zero-config local/fallback mode). */
const SCHEMA_SQLITE = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT 'Admin',
  role          TEXT NOT NULL DEFAULT 'admin',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS destinations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'nepal',
  region      TEXT NOT NULL DEFAULT '',
  image       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  country     TEXT NOT NULL DEFAULT '',
  capital     TEXT NOT NULL DEFAULT '',
  currency    TEXT NOT NULL DEFAULT '',
  language    TEXT NOT NULL DEFAULT '',
  best_time   TEXT NOT NULL DEFAULT '',
  visa        TEXT NOT NULL DEFAULT '',
  featured    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS packages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  category    TEXT NOT NULL DEFAULT 'domestic',
  destination TEXT NOT NULL DEFAULT '',
  days        INTEGER NOT NULL DEFAULT 1,
  nights      INTEGER NOT NULL DEFAULT 0,
  price       REAL NOT NULL DEFAULT 0,
  discount    REAL NOT NULL DEFAULT 0,
  image       TEXT NOT NULL DEFAULT '',
  summary     TEXT NOT NULL DEFAULT '',
  highlights  TEXT NOT NULL DEFAULT '[]',
  featured    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS testimonials (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  location   TEXT NOT NULL DEFAULT '',
  rating     INTEGER NOT NULL DEFAULT 5,
  content    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS blog_posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  slug       TEXT UNIQUE NOT NULL,
  excerpt    TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  author     TEXT NOT NULL DEFAULT 'Editorial Team',
  cover      TEXT NOT NULL DEFAULT '',
  published  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  phone      TEXT NOT NULL DEFAULT '',
  subject    TEXT NOT NULL DEFAULT '',
  message    TEXT NOT NULL DEFAULT '',
  handled    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subscribers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bookings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id    INTEGER,
  package_slug  TEXT NOT NULL DEFAULT '',
  package_title TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT NOT NULL DEFAULT '',
  travellers    INTEGER NOT NULL DEFAULT 1,
  travel_date   TEXT NOT NULL DEFAULT '',
  message       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'new',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_packages_category ON packages(category);
CREATE INDEX IF NOT EXISTS idx_destinations_kind ON destinations(kind);
CREATE INDEX IF NOT EXISTS idx_contacts_created ON contacts(created_at);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
`;

/**
 * PostgreSQL schema. Mirrors the SQLite one so behaviour (including JSON field
 * shapes) is identical: booleans stay INTEGER 0/1 and timestamps stay TEXT so
 * the frontend never has to special-case a driver.
 */
const SCHEMA_PG = `
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT 'Admin',
  role          TEXT NOT NULL DEFAULT 'admin',
  created_at    TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS destinations (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'nepal',
  region      TEXT NOT NULL DEFAULT '',
  image       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  country     TEXT NOT NULL DEFAULT '',
  capital     TEXT NOT NULL DEFAULT '',
  currency    TEXT NOT NULL DEFAULT '',
  language    TEXT NOT NULL DEFAULT '',
  best_time   TEXT NOT NULL DEFAULT '',
  visa        TEXT NOT NULL DEFAULT '',
  featured    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS packages (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  category    TEXT NOT NULL DEFAULT 'domestic',
  destination TEXT NOT NULL DEFAULT '',
  days        INTEGER NOT NULL DEFAULT 1,
  nights      INTEGER NOT NULL DEFAULT 0,
  price       DOUBLE PRECISION NOT NULL DEFAULT 0,
  discount    DOUBLE PRECISION NOT NULL DEFAULT 0,
  image       TEXT NOT NULL DEFAULT '',
  summary     TEXT NOT NULL DEFAULT '',
  highlights  TEXT NOT NULL DEFAULT '[]',
  featured    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS testimonials (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  location   TEXT NOT NULL DEFAULT '',
  rating     INTEGER NOT NULL DEFAULT 5,
  content    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS blog_posts (
  id         SERIAL PRIMARY KEY,
  title      TEXT NOT NULL,
  slug       TEXT UNIQUE NOT NULL,
  excerpt    TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  author     TEXT NOT NULL DEFAULT 'Editorial Team',
  cover      TEXT NOT NULL DEFAULT '',
  published  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS contacts (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  phone      TEXT NOT NULL DEFAULT '',
  subject    TEXT NOT NULL DEFAULT '',
  message    TEXT NOT NULL DEFAULT '',
  handled    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS subscribers (
  id         SERIAL PRIMARY KEY,
  email      TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS bookings (
  id            SERIAL PRIMARY KEY,
  package_id    INTEGER,
  package_slug  TEXT NOT NULL DEFAULT '',
  package_title TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT NOT NULL DEFAULT '',
  travellers    INTEGER NOT NULL DEFAULT 1,
  travel_date   TEXT NOT NULL DEFAULT '',
  message       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'new',
  created_at    TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE INDEX IF NOT EXISTS idx_packages_category ON packages(category);
CREATE INDEX IF NOT EXISTS idx_destinations_kind ON destinations(kind);
CREATE INDEX IF NOT EXISTS idx_contacts_created ON contacts(created_at);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
`;

/** The tables the app owns, in dependency-free order (no FKs are declared). */
const TABLES = ['users', 'destinations', 'packages', 'testimonials',
  'blog_posts', 'contacts', 'subscribers', 'bookings'];

// ---------------------------------------------------------------------------
// Driver: SQLite (node:sqlite)
// ---------------------------------------------------------------------------

function createSqliteDriver() {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const sqlite = new DatabaseSync(DB_PATH);
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(SCHEMA_SQLITE);

  return {
    kind: 'sqlite',
    label: DB_PATH,
    raw: sqlite,
    async all(sql, params = []) { return sqlite.prepare(sql).all(...params); },
    async get(sql, params = []) { return sqlite.prepare(sql).get(...params); },
    async run(sql, params = []) {
      const info = sqlite.prepare(sql).run(...params);
      return { changes: Number(info.changes), lastInsertRowid: Number(info.lastInsertRowid) };
    },
    // Runs ONLY the schema constant defined in this module — never a parameter,
    // so no caller can pass SQL through it.
    async applySchema() { sqlite.exec(SCHEMA_SQLITE); },
    async close() { try { sqlite.close(); } catch (_e) { /* best effort */ } },
    /** Column names for a table (used by the idempotent migrator). */
    async columns(table) {
      return sqlite.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    },
    /** Postgres uses setval; SQLite sequences are implicit in AUTOINCREMENT. */
    async syncSequence() { /* no-op for SQLite */ },
    async tableExists(table) {
      const r = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      return Boolean(r);
    }
  };
}

// ---------------------------------------------------------------------------
// Driver: PostgreSQL (pg)
// ---------------------------------------------------------------------------

/**
 * Rewrite `?` placeholders to Postgres `$1..$n`.
 * Only `?` characters are touched, and the existing code never puts a literal
 * `?` inside a SQL string, so this is safe for every query in the project.
 */
function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function createPgDriver() {
  const pg = require('pg');
  const { Pool } = pg;
  // Postgres returns BIGINT (COUNT(*), etc.) as a STRING to avoid precision loss.
  // The app treats counts as numbers (`Number.isInteger`, `=== 0`), so parse
  // int8 back to a JS number — safe here because our row counts are tiny.
  pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
  // Managed free tiers (Neon/Supabase/Render) terminate TLS at their proxy and
  // present a certificate the default trust store may not know; `ssl.rejectUnauthorized:false`
  // is the documented setting for those providers. Localhost does not use SSL.
  const host = (() => { try { return new URL(DATABASE_URL).hostname; } catch (_e) { return ''; } })();
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const needsSsl = !isLocal && !/sslmode=disable/i.test(DATABASE_URL);
  const pool = new Pool({
    connectionString: DATABASE_URL,
    max: Number(process.env.PG_POOL_MAX || 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    ssl: needsSsl ? { rejectUnauthorized: false } : false
  });
  // A failed idle client must never crash the process.
  pool.on('error', (err) => console.error('[db] idle pg client error:', err.message));

  return {
    kind: 'postgres',
    label: host + '/' + (() => { try { return new URL(DATABASE_URL).pathname.replace(/^\//, ''); } catch (_e) { return ''; } })(),
    raw: pool,
    async all(sql, params = []) { return (await pool.query(toPgPlaceholders(sql), params)).rows; },
    async get(sql, params = []) { return (await pool.query(toPgPlaceholders(sql), params)).rows[0] || null; },
    async run(sql, params = []) {
      // SQLite reports lastInsertRowid natively; PostgreSQL does not, so for an
      // INSERT we append `RETURNING id` and read it back. This keeps every call
      // site identical across both drivers — no query in the app has to change.
      const isInsert = /^\s*insert\s/i.test(sql);
      let finalSql = toPgPlaceholders(sql);
      if (isInsert && !/returning\b/i.test(sql)) finalSql += ' RETURNING id';
      const res = await pool.query(finalSql, params);
      const lastInsertRowid = isInsert && res.rows[0] ? Number(res.rows[0].id) : undefined;
      return { changes: Number(res.rowCount), lastInsertRowid };
    },
    // Runs ONLY the schema constant defined in this module — never a parameter,
    // so no caller can pass SQL through it.
    async applySchema() { await pool.query(SCHEMA_PG); },
    async close() { try { await pool.end(); } catch (_e) { /* best effort */ } },
    async columns(table) {
      const res = await pool.query(
        'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1',
        [table]
      );
      return res.rows.map((r) => r.column_name);
    },
    /** Reset SERIAL sequences so inserts after an explicit-id import do not clash. */
    async syncSequence(table) {
      try {
        await pool.query(
          `SELECT setval(pg_get_serial_sequence($1, 'id'), ` +
          `COALESCE((SELECT MAX(id) FROM ${table}), 1), (SELECT COUNT(*) > 0 FROM ${table}))`,
          [table]
        );
      } catch (err) {
        console.warn(`[db] could not sync sequence for ${table}: ${err.message}`);
      }
    },
    async tableExists(table) {
      const res = await pool.query(
        'SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1',
        [table]
      );
      return res.rowCount > 0;
    }
  };
}

// ---------------------------------------------------------------------------
// Active driver
// ---------------------------------------------------------------------------

const driver = IS_PG ? createPgDriver() : createSqliteDriver();
const db = driver.raw;

async function all(sql, params = []) { return driver.all(sql, params); }
async function get(sql, params = []) { return driver.get(sql, params); }
async function run(sql, params = []) { return driver.run(sql, params); }

/** Create the schema (idempotent) — explicit so a deploy can call it. */
async function init() {
  await driver.applySchema();
  const { ensureDestinationColumns } = require('./db-migrate');
  await ensureDestinationColumns(driver);
  return driver.kind;
}

/** Turn a title into a URL-safe slug. */
function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

// ---------------------------------------------------------------------------
// Seed data (only inserted when the relevant table is empty)
// ---------------------------------------------------------------------------

const DESTINATION_DETAILS = {
  'pokhara': { country: 'Nepal', capital: 'Kathmandu', currency: 'Nepali Rupees', language: 'Nepali', best_time: 'Spring, Autumn, and Winter', visa: 'No visa requirement' },
  'rara-lake': { country: 'Nepal', capital: 'Kathmandu', currency: 'Nepali Rupees', language: 'Nepali', best_time: 'Spring, Autumn, and Winter', visa: 'No visa requirement' },
  'mustang': { country: 'Nepal', capital: 'Kathmandu', currency: 'Nepali Rupees', language: 'Nepali', best_time: 'Spring, Autumn, and Winter', visa: 'No visa requirement' },
  'ghandruk': { country: 'Nepal', capital: 'Kathmandu', currency: 'Nepali Rupees', language: 'Nepali', best_time: 'Spring, Autumn, and Winter', visa: 'No visa requirement' },
  'chitwan-national-park': { country: 'Nepal', capital: 'Kathmandu', currency: 'Nepali Rupees', language: 'Nepali', best_time: 'Autumn and Spring', visa: 'No visa requirement' },
  'dhorpatan': { country: 'Nepal', capital: 'Kathmandu', currency: 'Nepali Rupees', language: 'Nepali', best_time: 'Spring and Autumn', visa: 'No visa requirement' },
  'london': { country: 'United Kingdom', capital: 'London', currency: 'Pound Sterling', language: 'English', best_time: 'May to September', visa: 'Visa required' },
  'tokyo': { country: 'Japan', capital: 'Tokyo', currency: 'Japanese Yen', language: 'Japanese', best_time: 'March to May, October to November', visa: 'Visa required' },
  'bangkok': { country: 'Thailand', capital: 'Bangkok', currency: 'Thai Baht', language: 'Thai', best_time: 'November to February', visa: 'Visa required' },
  'paris': { country: 'France', capital: 'Paris', currency: 'Euro', language: 'French', best_time: 'April to June, September to October', visa: 'Visa required (Schengen)' },
  'barcelona': { country: 'Spain', capital: 'Madrid', currency: 'Euro', language: 'Spanish', best_time: 'May to September', visa: 'Visa required (Schengen)' },
  'rome': { country: 'Italy', capital: 'Rome', currency: 'Euro', language: 'Italian', best_time: 'April to June, September to October', visa: 'Visa required (Schengen)' }
};

const SEED_DESTINATIONS = [
  { name: 'Pokhara', kind: 'nepal', region: 'Gandaki', featured: 1, image: 'phewa-lake',
    description: 'Pokhara is Nepal\'s second-largest city and the country\'s premier lakeside destination, set on the shores of Phewa Lake with the Annapurna range rising behind it. Known as the gateway to the Annapurna region, it blends relaxed cafés and lakeside walks with easy access to Sarangkot, the World Peace Pagoda, Davis Falls and Gupteshwor Cave. Paragliding, zip-lining and boating make it a favourite for travellers who want adventure without a long trek.' },
  { name: 'Rara Lake', kind: 'nepal', region: 'Karnali', featured: 1, image: 'rara-lake',
    description: 'Rara Lake is the largest freshwater lake in Nepal and one of the country\u2019s most spectacular natural attractions. Nestled within Rara National Park, the lake is renowned for its crystal-clear blue waters, pristine forests, peaceful surroundings and breathtaking mountain scenery. Often referred to as the \u201cQueen of Lakes,\u201d Rara offers a tranquil escape for nature lovers, trekkers and photographers who make the journey to remote Karnali.' },
  { name: 'Mustang', kind: 'nepal', region: 'Gandaki', featured: 1, image: 'mustang',
    description: 'Mustang is the high, arid trans-Himalayan plateau hidden beyond the world\'s deepest gorge, the Kali Gandaki. The walled capital of Lo Manthang, ochre cliffs and centuries-old monasteries give Upper Mustang the feel of a different world. The landscape is dry, wind-carved and full of Tibetan-influenced culture — a superb region for travellers seeking a trek unlike any other in Nepal.' },
  { name: 'Ghandruk', kind: 'nepal', region: 'Gandaki', featured: 0, image: 'ghandruk',
    description: 'Ghandruk is a traditional Gurung village perched on the hillside of the Annapurna region, famous for its stone-paved lanes, terraced fields and close-up views of Machhapuchhre and Annapurna South. It is one of the most popular short-trek destinations in Nepal and a window into local Gurung culture, with homestays and a Gurung museum at the top of the village.' },
  { name: 'Chitwan National Park', kind: 'nepal', region: 'Bagmati', featured: 0, image: 'chitwan',
    description: 'Chitwan National Park is Nepal\'s first national park and a UNESCO World Heritage Site, protecting a rich lowland ecosystem of sal forest, tall grassland and riverine floodplain. It is home to the greater one-horned rhinoceros, Bengal tiger, gharial crocodile and hundreds of bird species. Jungle walks, canoe trips on the Rapti and Tharu cultural evenings make it one of Asia\'s finest wildlife destinations.' },
  { name: 'Dhorpatan', kind: 'nepal', region: 'Dhaulagiri', featured: 0, image: 'dhorpatan',
    description: 'Dhorpatan is a wide, quiet valley in western Nepal that holds the country\u2019s only hunting reserve, ringed by fir and rhododendron forest at around 3,000 metres. Dhorpatan is little-visited, making it ideal for travellers who want solitude, open skies and a genuine off-the-beaten-path trek far from the main tourist routes.' },
  { name: 'London', kind: 'international', region: 'United Kingdom', featured: 0, image: 'london',
    description: 'London is the United Kingdom\'s capital and one of the world\'s great cities, mixing royal history with modern culture. Visit the Tower of London, Buckingham Palace, the Houses of Parliament and Westminster Abbey, then the British Museum, Tate Modern and West End theatres. Day trips to Stonehenge, Windsor Castle and Bath are easy, and world-class shopping and dining lie around every corner.' },
  { name: 'Tokyo', kind: 'international', region: 'Japan', featured: 0, image: 'tokyo',
    description: 'Tokyo is Japan\'s vast, orderly capital, where neon-lit districts sit beside quiet shrines and immaculate gardens. Explore Senso-ji temple, the Meiji Shrine and the Imperial Palace, then dive into Shibuya, Shinjuku and the old lanes of Asakusa. Tokyo is also the perfect base for day trips to Mount Fuji and Nikko, with some of the best food and transport in the world.' },
  { name: 'Bangkok', kind: 'international', region: 'Thailand', featured: 1, image: 'bangkok',
    description: 'Bangkok is Thailand\u2019s energetic capital, famous for its golden temples, floating markets and legendary street food. Visit the Grand Palace and Wat Pho, cruise the Chao Phraya river, and shop from Chatuchak market to luxury malls. With a warm welcome, excellent value and a springboard to the rest of Thailand, Bangkok works for both first-time and returning travellers.' },
  { name: 'Paris', kind: 'international', region: 'France', featured: 0, image: 'paris',
    description: 'Paris is France\'s elegant capital, built around the Seine and packed with world-famous art, architecture and cuisine. See the Eiffel Tower, the Louvre, Notre-Dame and Montmartre, then stroll the boulevards and riverside cafés. Day trips to Versailles and Giverny round off a city that has inspired travellers for centuries.' },
  { name: 'Barcelona', kind: 'international', region: 'Spain', featured: 0, image: 'barcelona',
    description: 'Barcelona is Spain\u2019s vibrant Catalan capital, where Gaud\u00ed\u2019s architecture meets beaches, markets and a famously energetic old town. Tour the Sagrada Fam\u00edlia and Park G\u00fcell, wander the Gothic Quarter and Las Ramblas, and enjoy the tapas culture. With sunshine, art and sea air, Barcelona is one of Europe\'s most enjoyable city breaks.' },
  { name: 'Rome', kind: 'international', region: 'Italy', featured: 0, image: 'rome',
    description: 'Rome is Italy\'s capital and an open-air museum, layering ancient, Renaissance and baroque history across every quarter. Explore the Colosseum, Roman Forum and Pantheon, toss a coin in the Trevi Fountain, and visit Vatican City. With superb food and the Amalfi, Florence and Tuscany within reach, Rome is the perfect base for a European adventure.' }
];

const SEED_PACKAGES = [
  {
    title: 'Pokhara Leisure Tour', category: 'domestic', destination: 'Pokhara, Nepal',
    days: 3, nights: 2, price: 18500, discount: 10, image: 'pokhara-leisure', featured: 1,
    summary: 'Escape to the lakeside city of Pokhara \u2014 paragliding, sunrise at Sarangkot, and a slow boat on Phewa Lake.',
    highlights: ['Sunrise at Sarangkot', 'Phewa Lake boating', 'Davis Falls & Gupteshwor Cave', 'Lakeside evening walk']
  },
  {
    title: 'Annapurna Base Camp Trek', category: 'trekking', destination: 'Annapurna, Nepal',
    days: 12, nights: 11, price: 78000, discount: 8, image: 'annapurna-base-camp', featured: 1,
    summary: 'A classic teahouse trek into the heart of the Annapurna sanctuary, ending beneath a 360\u00b0 ring of giants.',
    highlights: ['Annapurna Sanctuary', 'Machhapuchhre views', 'Jhinu Danda hot springs', 'Gurung villages']
  },
  {
    title: 'Kathmandu Heritage & Culture Tour', category: 'historical', destination: 'Kathmandu Valley, Nepal',
    days: 4, nights: 3, price: 24000, discount: 5, image: 'kathmandu-heritage', featured: 1,
    summary: 'Seven UNESCO World Heritage Sites, ancient durbar squares and living temple courtyards across the valley.',
    highlights: ['Kathmandu Durbar Square', 'Swayambhunath Stupa', 'Patan & Bhaktapur', 'Boudhanath at dusk']
  },
  {
    title: 'Everest Base Camp Trek', category: 'trekking', destination: 'Khumbu, Nepal',
    days: 14, nights: 13, price: 145000, discount: 0, image: 'everest-base-camp', featured: 1,
    summary: 'The world\u2019s most famous trek \u2014 Sherpa villages, Tengboche monastery and sunrise from Kala Patthar.',
    highlights: ['Lukla to Namche', 'Tengboche Monastery', 'Kala Patthar sunrise', 'Everest Base Camp']
  },
  {
    title: 'Chitwan Jungle Safari', category: 'domestic', destination: 'Chitwan, Nepal',
    days: 3, nights: 2, price: 21000, discount: 0, image: 'chitwan', featured: 0,
    summary: 'Canoe the Rapti, walk the sal forest and look for rhino, tiger and crocodile in Nepal\u2019s first national park.',
    highlights: ['Canoe safari', 'Jungle walk', 'Tharu cultural evening', 'Elephant breeding centre']
  },
  {
    title: 'Muktinath Pilgrimage Yatra', category: 'religious', destination: 'Mustang, Nepal',
    days: 5, nights: 4, price: 32000, discount: 0, image: 'muktinath-yatra', featured: 0,
    summary: 'A sacred journey to the 108 water spouts of Muktinath, set high in the trans-Himalayan Mustang valley.',
    highlights: ['Muktinath temple', '108 water spouts', 'Jomsom valley', 'Kagbeni village']
  },
  {
    title: 'Amazing Thailand Holiday', category: 'international', destination: 'Bangkok & Pattaya, Thailand',
    days: 6, nights: 5, price: 92000, discount: 12, image: 'thailand-holiday', featured: 1,
    summary: 'Golden temples, floating markets and island beaches \u2014 a six-day taste of Thailand at an easy pace.',
    highlights: ['Grand Palace & Wat Pho', 'Pattaya beaches', 'Floating market', 'Chao Phraya cruise']
  },
  {
    title: 'Bali Escape', category: 'international', destination: 'Bali, Indonesia',
    days: 5, nights: 4, price: 88000, discount: 10, image: 'bali-escape', featured: 0,
    summary: 'Rice terraces, temple sunsets and beach clubs \u2014 the island of the gods in a five-day escape.',
    highlights: ['Tegallalang rice terraces', 'Uluwatu sunset', 'Nusa Penida day trip', 'Ubud art market']
  },
  {
    title: 'London Heritage & Culture Tour Package', category: 'international', destination: 'London, United Kingdom',
    days: 7, nights: 6, price: 165000, discount: 0, image: 'london-heritage', featured: 0,
    summary: 'A week in the British capital \u2014 royal palaces, world-class museums and day trips to Windsor and Bath.',
    highlights: ['Tower of London', 'Buckingham Palace', 'British Museum', 'Windsor Castle day trip']
  }
];

const SEED_TESTIMONIALS = [
  { name: 'Anjali Sharma', location: 'Kathmandu, Nepal', rating: 5, content: 'The Annapurna trek was perfectly organised \u2014 clear itinerary, kind guides and a fair price. I would book again without hesitation.' },
  { name: 'David Miller', location: 'Bristol, UK', rating: 5, content: 'From visa paperwork to airport pickup, everything was handled. Our family trip to Nepal ran smoothly from start to finish.' },
  { name: 'Priya Nair', location: 'Kochi, India', rating: 4, content: 'Great value for the Thailand package and quick replies on WhatsApp. Only the hotel shuttle could have been faster.' }
];

const SEED_POSTS = [
  { title: 'Best Time to Visit Nepal: A Season-by-Season Guide',
    excerpt: 'Nepal rewards travellers in every season \u2014 but the right month depends on what you want to do.',
    body: 'Autumn (late September to November) brings the clearest mountain views and is the peak trekking window. Spring (March to May) is warmer and famous for rhododendron forests in bloom. Winter (December to February) is cold at altitude but superb for lower-elevation culture trips and wildlife. The monsoon (June to August) is quiet, green and cheap, best for city tours and Chitwan.',
    author: 'Editorial Team', cover: 'best-time-nepal' },
  { title: 'Top Destinations in Nepal for Every Kind of Traveller',
    excerpt: 'From high-altitude plateaus to jungle lowlands, here is where to start planning.',
    body: 'Trekkers head for the Annapurna and Everest regions. Culture seekers stay in the Kathmandu Valley, with its seven UNESCO sites. Wildlife lovers go to Chitwan or Bardia. For something quieter and further off the trail, look at Rara Lake in Karnali and the wide valley of Dhorpatan.',
    author: 'Editorial Team', cover: 'top-destinations' },
  { title: 'Visa & Document Checklist Before You Travel Abroad',
    excerpt: 'A simple checklist so your passport and paperwork never hold up a trip.',
    body: 'Confirm your passport has at least six months of validity. Collect proof of funds, a confirmed return ticket, hotel bookings and a travel insurance policy. Photographs, a completed application form and bank statements are commonly required. Our visa desk reviews every file before submission so that nothing is missing at the counter.',
    author: 'Visa Desk', cover: 'visa-checklist' }
];

/** Insert the built-in content only when a table is still empty. Idempotent. */
async function seedIfEmpty() {
  const destCount = Number((await get('SELECT COUNT(*) AS n FROM destinations')).n);
  if (destCount === 0) {
    for (const d of SEED_DESTINATIONS) {
      const det = DESTINATION_DETAILS[slugify(d.name)] || {};
      await run(
        `INSERT INTO destinations
          (name, slug, kind, region, image, description, featured, country, capital, currency, language, best_time, visa)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [d.name, slugify(d.name), d.kind, d.region, d.image, d.description, d.featured,
          det.country || '', det.capital || '', det.currency || '', det.language || '',
          det.best_time || '', det.visa || '']
      );
    }
  } else {
    const missing = await all("SELECT id, slug FROM destinations WHERE country = '' OR best_time = ''");
    for (const row of missing) {
      const det = DESTINATION_DETAILS[row.slug];
      if (!det) continue;
      await run(
        'UPDATE destinations SET country = ?, capital = ?, currency = ?, language = ?, best_time = ?, visa = ? WHERE id = ?',
        [det.country, det.capital, det.currency, det.language, det.best_time, det.visa, row.id]
      );
    }
  }

  const pkgCount = Number((await get('SELECT COUNT(*) AS n FROM packages')).n);
  if (pkgCount === 0) {
    for (const p of SEED_PACKAGES) {
      await run(
        `INSERT INTO packages (title, slug, category, destination, days, nights, price, discount, image, summary, highlights, featured)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [p.title, slugify(p.title), p.category, p.destination, p.days, p.nights,
          p.price, p.discount, p.image, p.summary, JSON.stringify(p.highlights), p.featured || 0]
      );
    }
  }

  const testCount = Number((await get('SELECT COUNT(*) AS n FROM testimonials')).n);
  if (testCount === 0) {
    for (const t of SEED_TESTIMONIALS) {
      await run('INSERT INTO testimonials (name, location, rating, content) VALUES (?, ?, ?, ?)',
        [t.name, t.location, t.rating, t.content]);
    }
  }

  const postCount = Number((await get('SELECT COUNT(*) AS n FROM blog_posts')).n);
  if (postCount === 0) {
    for (const b of SEED_POSTS) {
      await run('INSERT INTO blog_posts (title, slug, excerpt, body, author, cover, published) VALUES (?, ?, ?, ?, ?, ?, 1)',
        [b.title, slugify(b.title), b.excerpt, b.body, b.author, b.cover]);
    }
  }
}

module.exports = {
  db, driver, DB_PATH, DATABASE_URL, IS_PG, TABLES,
  slugify, all, get, run, init, seedIfEmpty,
  // Exported for the migration script + tests.
  SCHEMA_PG, SCHEMA_SQLITE, toPgPlaceholders
};

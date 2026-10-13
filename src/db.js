'use strict';

/**
 * SQLite access layer.
 *
 * Uses Node's built-in `node:sqlite` (stable in Node 22+) so the project has an
 * embedded, dependency-free database. The schema is created idempotently on load
 * and a small set of seed rows is inserted only when a table is empty, which
 * keeps `npm start` self-bootstrapping on a fresh checkout.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { ensureDestinationColumns } = require('./db-migrate');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'travel.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

const SCHEMA = `
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
  kind        TEXT NOT NULL DEFAULT 'nepal',      -- 'nepal' | 'international'
  region      TEXT NOT NULL DEFAULT '',
  image       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  featured    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS packages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  category    TEXT NOT NULL DEFAULT 'domestic',   -- domestic|international|historical|religious|trekking
  destination TEXT NOT NULL DEFAULT '',
  days        INTEGER NOT NULL DEFAULT 1,
  nights      INTEGER NOT NULL DEFAULT 0,
  price       REAL NOT NULL DEFAULT 0,
  discount    REAL NOT NULL DEFAULT 0,
  image       TEXT NOT NULL DEFAULT '',
  summary     TEXT NOT NULL DEFAULT '',
  highlights  TEXT NOT NULL DEFAULT '[]',         -- JSON array of strings
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

CREATE INDEX IF NOT EXISTS idx_packages_category ON packages(category);
CREATE INDEX IF NOT EXISTS idx_destinations_kind ON destinations(kind);
CREATE INDEX IF NOT EXISTS idx_contacts_created ON contacts(created_at);
`;

db.exec(SCHEMA);

// Add destination-detail columns (country/capital/currency/language/best_time/
// visa) on databases created before those fields existed. Idempotent.
ensureDestinationColumns(db);

/** Turn a title into a URL-safe slug. */
function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

/** Read every row of a table ordered by a whitelisted column. */
function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}

/** Read a single row. */
function get(sql, params = []) {
  return db.prepare(sql).get(...params);
}

/** Execute a write and return { changes, lastInsertRowid }. */
function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}

// ---------------------------------------------------------------------------
// Seed data (only inserted when the relevant table is empty)
// ---------------------------------------------------------------------------

/**
 * Destination overview details shown on the destination detail page
 * (reference parity: Country / Capital / Currency / Language / Best time / Visa).
 * Keyed by slug so it can both seed fresh databases and backfill old rows.
 */
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
    description: 'Barcelona is Spain\u2019s vibrant Catalan capital, where Gaud\u00ed\u2019s architecture meets beaches, markets and a famously energetic old town. Tour the Sagrada Fam\u00edlia and Park G\u00fcell, wander the Gothic Quarter and Las Ramblas, and enjoy the tapas culture. With sunshine, art and sea air, Barcelona is one of Europe\u2019s most enjoyable city breaks.' },
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
    highlights: ['Annapurna Sanctuary', 'Jhinu Danda hot springs', 'Chhomrong village', 'Licensed trekking guide']
  },
  {
    title: 'Chitwan Jungle Safari', category: 'domestic', destination: 'Chitwan, Nepal',
    days: 3, nights: 2, price: 26000, discount: 0, image: 'chitwan-safari', featured: 0,
    summary: 'Canoe the Rapti, track rhinos on foot with trained naturalists, and end the day with a Tharu cultural program.',
    highlights: ['Canoe trip', 'Jungle walk with naturalist', 'Tharu cultural show', 'Elephant breeding centre visit']
  },
  {
    title: 'Kathmandu Heritage & Culture Tour', category: 'historical', destination: 'Kathmandu Valley, Nepal',
    days: 4, nights: 3, price: 32000, discount: 12, image: 'kathmandu-heritage', featured: 1,
    summary: 'Seven UNESCO World Heritage sites across Kathmandu, Patan and Bhaktapur with a specialist cultural guide.',
    highlights: ['Boudhanath Stupa', 'Pashupatinath', 'Patan Durbar Square', 'Bhaktapur Pottery Square']
  },
  {
    title: 'Pashupatinath & Muktinath Yatra', category: 'religious', destination: 'Kathmandu & Mustang, Nepal',
    days: 6, nights: 5, price: 54000, discount: 5, image: 'muktinath-yatra', featured: 0,
    summary: 'A guided pilgrimage pairing the valley\u2019s holiest temples with the high-altitude shrine of Muktinath.',
    highlights: ['Pashupatinath darshan', 'Muktinath temple', 'Jomsom flight', 'Pokhara stopover']
  },
  {
    title: 'Amazing Thailand Holiday', category: 'international', destination: 'Thailand',
    days: 5, nights: 4, price: 50000, discount: 34, image: 'thailand-holiday', featured: 1,
    summary: 'Bangkok temples, a Chao Phraya river cruise and free time in the markets \u2014 flights and visa support included.',
    highlights: ['Grand Palace & Wat Pho', 'River dinner cruise', 'Safari World', 'Visa processing assistance']
  },
  {
    title: 'London Heritage & Culture Tour', category: 'international', destination: 'United Kingdom',
    days: 6, nights: 5, price: 165000, discount: 25, image: 'london-heritage', featured: 1,
    summary: 'Stonehenge, Windsor Castle and a full London city tour \u2014 with visa documentation handled end-to-end.',
    highlights: ['Stonehenge day trip', 'Windsor Castle', 'Bath city tour', 'UK visa document support']
  },
  {
    title: 'Bali Island Escape', category: 'international', destination: 'Indonesia',
    days: 5, nights: 4, price: 62000, discount: 15, image: 'bali-escape', featured: 0,
    summary: 'Rice terraces, cliff-top temples and beach time, with a private car and driver throughout.',
    highlights: ['Ubud rice terraces', 'Uluwatu sunset temple', 'Nusa Penida day trip', 'Private transfers']
  }
];

const SEED_TESTIMONIALS = [
  { name: 'Anita Gurung', location: 'Kathmandu, Nepal', rating: 5,
    content: 'The Annapurna trek was organised down to the last detail. Our guide was patient, knowledgeable and kept the whole group safe and laughing.' },
  { name: 'David Mitchell', location: 'Manchester, UK', rating: 5,
    content: 'We booked a Nepal round-trip from abroad and the team handled airport pickup, hotels and permits without a single hiccup. Genuinely hassle-free.' },
  { name: 'Sujata Shrestha', location: 'Pokhara, Nepal', rating: 4,
    content: 'Quick, clear pricing and honest advice on which season to travel. The Pokhara package was excellent value for a family of four.' }
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

function seedIfEmpty() {
  const destCount = get('SELECT COUNT(*) AS n FROM destinations').n;
  if (destCount === 0) {
    const stmt = db.prepare(
      `INSERT INTO destinations
        (name, slug, kind, region, image, description, featured, country, capital, currency, language, best_time, visa)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const d of SEED_DESTINATIONS) {
      const det = DESTINATION_DETAILS[slugify(d.name)] || {};
      stmt.run(d.name, slugify(d.name), d.kind, d.region, d.image, d.description, d.featured,
        det.country || '', det.capital || '', det.currency || '', det.language || '',
        det.best_time || '', det.visa || '');
    }
  } else {
    // Backfill the detail columns for rows created before those columns
    // existed, so an already-seeded database gains the same Overview data
    // without needing a reset.
    const missing = all("SELECT id, slug FROM destinations WHERE country = '' OR best_time = ''");
    if (missing.length) {
      const upd = db.prepare(
        'UPDATE destinations SET country = ?, capital = ?, currency = ?, language = ?, best_time = ?, visa = ? WHERE id = ?'
      );
      for (const row of missing) {
        const det = DESTINATION_DETAILS[row.slug];
        if (!det) continue;
        upd.run(det.country, det.capital, det.currency, det.language, det.best_time, det.visa, row.id);
      }
    }
  }

  const pkgCount = get('SELECT COUNT(*) AS n FROM packages').n;
  if (pkgCount === 0) {
    const stmt = db.prepare(
      `INSERT INTO packages (title, slug, category, destination, days, nights, price, discount, image, summary, highlights, featured)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const p of SEED_PACKAGES) {
      stmt.run(p.title, slugify(p.title), p.category, p.destination, p.days, p.nights,
        p.price, p.discount, p.image, p.summary, JSON.stringify(p.highlights), p.featured || 0);
    }
  }

  const testCount = get('SELECT COUNT(*) AS n FROM testimonials').n;
  if (testCount === 0) {
    const stmt = db.prepare('INSERT INTO testimonials (name, location, rating, content) VALUES (?, ?, ?, ?)');
    for (const t of SEED_TESTIMONIALS) {
      stmt.run(t.name, t.location, t.rating, t.content);
    }
  }

  const postCount = get('SELECT COUNT(*) AS n FROM blog_posts').n;
  if (postCount === 0) {
    const stmt = db.prepare(
      'INSERT INTO blog_posts (title, slug, excerpt, body, author, cover, published) VALUES (?, ?, ?, ?, ?, ?, 1)'
    );
    for (const b of SEED_POSTS) {
      stmt.run(b.title, slugify(b.title), b.excerpt, b.body, b.author, b.cover);
    }
  }
}

seedIfEmpty();

module.exports = { db, DB_PATH, slugify, all, get, run, seedIfEmpty };

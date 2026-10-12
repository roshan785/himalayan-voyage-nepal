'use strict';

/**
 * All HTTP routes for the travel site.
 *
 * Layout:
 *   /api/site, /api/stats, /api/destinations, /api/packages, /api/posts,
 *   /api/testimonials            -> public read APIs
 *   POST /api/contact, /api/newsletter -> public write APIs (validated)
 *   POST /api/auth/login, GET /api/auth/me -> session
 *   /api/admin/*                 -> JWT-protected content management
 */

const express = require('express');
const { all, get, run, slugify } = require('./db');
const {
  verifyPassword, issueToken, requireAuth, findUserByEmail, TOKEN_COOKIE
} = require('./auth');
const chat = require('./chat');

const SITE = {
  name: 'Himalayan Voyage Nepal',
  tagline: 'Discover Nepal & Explore the World',
  phone: '+977 9800000000',
  email: 'hello@himalayanvoyage.test',
  address: 'Lakeside Road, Pokhara, Nepal',
  hours: 'Sun\u2013Fri: 10 AM \u2013 5 PM',
  social: {
    facebook: 'https://facebook.com/himalayanvoyage',
    instagram: 'https://instagram.com/himalayanvoyage',
    youtube: 'https://youtube.com/@himalayanvoyage'
  }
};

const PACKAGE_CATEGORIES = ['domestic', 'international', 'historical', 'religious', 'trekking'];

/** Parse a JSON column, tolerating bad or missing data. */
function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_err) {
    return [];
  }
}

/** Coerce a value to a finite number, falling back to a default. */
function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Trim and length-cap a string field. */
function str(value, max = 5000) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

/** Generate a slug that is unique within a table (ignoring the edited row). */
function uniqueSlug(table, base, ignoreId = null) {
  let slug = slugify(base);
  if (!slug) slug = 'item';
  let candidate = slug;
  let i = 2;
  for (;;) {
    const row = ignoreId
      ? get(`SELECT id FROM ${table} WHERE slug = ? AND id != ?`, [candidate, ignoreId])
      : get(`SELECT id FROM ${table} WHERE slug = ?`, [candidate]);
    if (!row) return candidate;
    candidate = `${slug}-${i++}`;
    if (i > 5000) return `${slug}-${Date.now()}`;
  }
}

/** Attach a 400 error to the response. */
function bad(res, message) {
  return res.status(400).json({ error: message });
}

/** Normalise a package payload coming from the admin UI or JSON body. */
function normalisePackage(body) {
  return {
    title: str(body.title, 200),
    category: PACKAGE_CATEGORIES.includes(body.category) ? body.category : 'domestic',
    destination: str(body.destination, 200),
    days: Math.max(1, Math.round(num(body.days, 1))),
    nights: Math.max(0, Math.round(num(body.nights, 0))),
    price: Math.max(0, num(body.price, 0)),
    discount: Math.min(90, Math.max(0, num(body.discount, 0))),
    image: str(body.image, 300),
    summary: str(body.summary, 2000),
    highlights: JSON.stringify(
      Array.isArray(body.highlights)
        ? body.highlights.map((h) => str(h, 200)).filter(Boolean).slice(0, 30)
        : []
    ),
    featured: body.featured ? 1 : 0
  };
}

/** Shape a package row for JSON output (decode highlights). */
function packageOut(row) {
  return Object.assign({}, row, { highlights: parseJsonArray(row.highlights) });
}

/** Normalise a destination payload. */
function normaliseDestination(body) {
  return {
    name: str(body.name, 200),
    kind: body.kind === 'international' ? 'international' : 'nepal',
    region: str(body.region, 200),
    image: str(body.image, 300),
    description: str(body.description, 2000),
    featured: body.featured ? 1 : 0
  };
}

/** Normalise a blog-post payload. */
function normalisePost(body) {
  return {
    title: str(body.title, 250),
    excerpt: str(body.excerpt, 600),
    body: str(body.body, 20000),
    author: str(body.author, 120) || 'Editorial Team',
    cover: str(body.cover, 300),
    published: body.published === false || body.published === 0 ? 0 : 1
  };
}

/** Normalise a testimonial payload. */
function normaliseTestimonial(body) {
  return {
    name: str(body.name, 120),
    location: str(body.location, 160),
    rating: Math.min(5, Math.max(1, Math.round(num(body.rating, 5)))),
    content: str(body.content, 2000)
  };
}

/**
 * Build a small CRUD router for a table with a single normaliser + slug field.
 * Keeps package/destination/post/testimonial admin endpoints consistent.
 */
function crudRouter({ table, normalise, hasSlug = true, orderBy = 'id DESC' }) {
  const router = express.Router();

  router.get('/', (_req, res) => {
    const rows = all(`SELECT * FROM ${table} ORDER BY ${orderBy}`);
    res.json({ items: table === 'packages' ? rows.map(packageOut) : rows });
  });

  router.post('/', (req, res) => {
    const data = normalise(req.body || {});
    const label = data.title || data.name;
    if (!label) return bad(res, 'A title or name is required');
    const cols = Object.keys(data);
    const values = cols.map((c) => data[c]);
    if (hasSlug) {
      cols.push('slug');
      values.push(uniqueSlug(table, label));
    }
    const placeholders = cols.map(() => '?').join(', ');
    const info = run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`, values);
    const row = get(`SELECT * FROM ${table} WHERE id = ?`, [info.lastInsertRowid]);
    const item = table === 'packages' ? packageOut(row) : row;
    // `id` is repeated at the top level so generic API clients can read the new
    // identifier without knowing the `{ item }` envelope.
    res.status(201).json({ item, id: item.id });
  });

  router.put('/:id', (req, res) => {
    const id = num(req.params.id, 0);
    const existing = get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const data = normalise(req.body || {});
    const label = data.title || data.name;
    if (!label) return bad(res, 'A title or name is required');
    const cols = Object.keys(data);
    const values = cols.map((c) => data[c]);
    if (hasSlug) {
      cols.push('slug');
      values.push(uniqueSlug(table, label, id));
    }
    values.push(id);
    run(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, values);
    const row = get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
    const item = table === 'packages' ? packageOut(row) : row;
    res.json({ item, id: item.id });
  });

  router.delete('/:id', (req, res) => {
    const id = num(req.params.id, 0);
    const info = run(`DELETE FROM ${table} WHERE id = ?`, [id]);
    if (!info.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, deleted: id });
  });

  return router;
}

/** Validate an email address well enough to reject obvious junk. */
function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || '').trim());
}

// ---------------------------------------------------------------------------
// Public API router
// ---------------------------------------------------------------------------

function publicRouter() {
  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'himalayan-voyage', uptime: process.uptime() });
  });

  // Travel-assistant chat (local Ollama, grounded in site data).
  router.get('/chat/status', async (_req, res) => {
    res.json(await chat.status());
  });

  router.post('/chat', async (req, res) => {
    try {
      const reply = await chat.chat(req.body && req.body.messages, { all, get });
      res.json({ reply });
    } catch (err) {
      const code = err.status || (String(err.message).startsWith('ollama') ? 503 : 500);
      res.status(code).json({
        error: err.message || 'Chat unavailable',
        hint: code === 503 ? 'Make sure Ollama is running: ollama serve' : undefined
      });
    }
  });

  router.get('/site', (_req, res) => res.json(SITE));

  router.get('/stats', (_req, res) => {
    res.json({
      packages: get('SELECT COUNT(*) AS n FROM packages').n,
      destinations: get('SELECT COUNT(*) AS n FROM destinations').n,
      testimonials: get('SELECT COUNT(*) AS n FROM testimonials').n,
      posts: get('SELECT COUNT(*) AS n FROM blog_posts WHERE published = 1').n
    });
  });

  router.get('/destinations', (req, res) => {
    const { kind } = req.query;
    const rows = kind
      ? all('SELECT * FROM destinations WHERE kind = ? ORDER BY featured DESC, name ASC', [str(kind, 40)])
      : all('SELECT * FROM destinations ORDER BY featured DESC, name ASC');
    res.json({ items: rows });
  });

  router.get('/destinations/:slug', (req, res) => {
    const row = get('SELECT * FROM destinations WHERE slug = ?', [str(req.params.slug, 120)]);
    if (!row) return res.status(404).json({ error: 'Destination not found' });
    res.json({ item: row });
  });

  router.get('/packages', (req, res) => {
    const { category, featured, q } = req.query;
    const clauses = [];
    const params = [];
    if (category && category !== 'all') {
      clauses.push('category = ?');
      params.push(str(category, 40));
    }
    if (featured === '1' || featured === 'true') {
      clauses.push('featured = 1');
    }
    if (q) {
      clauses.push('(title LIKE ? OR destination LIKE ? OR summary LIKE ?)');
      const like = `%${str(q, 80)}%`;
      params.push(like, like, like);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = all(`SELECT * FROM packages ${where} ORDER BY featured DESC, id DESC`, params);
    res.json({ items: rows.map(packageOut) });
  });

  router.get('/packages/:slug', (req, res) => {
    const row = get('SELECT * FROM packages WHERE slug = ?', [str(req.params.slug, 160)]);
    if (!row) return res.status(404).json({ error: 'Package not found' });
    res.json({ item: packageOut(row) });
  });

  router.get('/testimonials', (_req, res) => {
    res.json({ items: all('SELECT * FROM testimonials ORDER BY id DESC') });
  });

  router.get('/posts', (_req, res) => {
    res.json({ items: all('SELECT id, title, slug, excerpt, author, cover, created_at FROM blog_posts WHERE published = 1 ORDER BY id DESC') });
  });

  router.get('/posts/:slug', (req, res) => {
    const row = get('SELECT * FROM blog_posts WHERE slug = ? AND published = 1', [str(req.params.slug, 200)]);
    if (!row) return res.status(404).json({ error: 'Post not found' });
    res.json({ item: row });
  });

  router.post('/contact', (req, res) => {
    const body = req.body || {};
    const name = str(body.name, 150);
    const email = str(body.email, 200);
    const message = str(body.message, 5000);
    if (!name) return bad(res, 'Your name is required');
    if (!isEmail(email)) return bad(res, 'A valid email address is required');
    if (message.length < 5) return bad(res, 'Please write a short message');
    const info = run(
      'INSERT INTO contacts (name, email, phone, subject, message) VALUES (?, ?, ?, ?, ?)',
      [name, email, str(body.phone, 40), str(body.subject, 200), message]
    );
    res.status(201).json({ ok: true, id: info.lastInsertRowid });
  });

  router.post('/newsletter', (req, res) => {
    const email = str((req.body || {}).email, 200);
    if (!isEmail(email)) return bad(res, 'A valid email address is required');
    try {
      run('INSERT INTO subscribers (email) VALUES (?)', [email.toLowerCase()]);
    } catch (_err) {
      return res.json({ ok: true, alreadySubscribed: true });
    }
    res.status(201).json({ ok: true });
  });

  router.post('/auth/login', (req, res) => {
    const body = req.body || {};
    const email = str(body.email, 200).toLowerCase();
    const password = String(body.password || '');
    if (!email || !password) return bad(res, 'Email and password are required');
    const user = findUserByEmail(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = issueToken(user);
    // HttpOnly cookie for same-origin browser use; token also returned for API clients.
    res.setHeader('Set-Cookie',
      `${TOKEN_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`);
    res.json({ ok: true, token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  });

  router.post('/auth/logout', (_req, res) => {
    res.setHeader('Set-Cookie', `${TOKEN_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  router.get('/auth/me', requireAuth(true), (req, res) => {
    const user = get('SELECT id, email, name, role FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(401).json({ error: 'Account no longer exists' });
    res.json({ user });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Admin API router (all routes require a valid JWT)
// ---------------------------------------------------------------------------

function adminRouter() {
  const router = express.Router();
  router.use(requireAuth(true));

  router.get('/overview', (_req, res) => {
    res.json({
      counts: {
        packages: get('SELECT COUNT(*) AS n FROM packages').n,
        destinations: get('SELECT COUNT(*) AS n FROM destinations').n,
        posts: get('SELECT COUNT(*) AS n FROM blog_posts').n,
        testimonials: get('SELECT COUNT(*) AS n FROM testimonials').n,
        contacts: get('SELECT COUNT(*) AS n FROM contacts').n,
        unreadContacts: get('SELECT COUNT(*) AS n FROM contacts WHERE handled = 0').n,
        subscribers: get('SELECT COUNT(*) AS n FROM subscribers').n
      },
      recentContacts: all('SELECT id, name, email, subject, handled, created_at FROM contacts ORDER BY id DESC LIMIT 5')
    });
  });

  router.use('/packages', crudRouter({ table: 'packages', normalise: normalisePackage }));
  router.use('/destinations', crudRouter({ table: 'destinations', normalise: normaliseDestination }));
  router.use('/testimonials', crudRouter({ table: 'testimonials', normalise: normaliseTestimonial }));
  router.use('/posts', crudRouter({ table: 'blog_posts', normalise: normalisePost, orderBy: 'id DESC' }));

  // Contacts are read-only from the admin API except for the handled flag.
  router.get('/contacts', (_req, res) => {
    res.json({ items: all('SELECT * FROM contacts ORDER BY id DESC') });
  });

  router.patch('/contacts/:id', (req, res) => {
    const id = num(req.params.id, 0);
    const existing = get('SELECT * FROM contacts WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const handled = (req.body || {}).handled ? 1 : 0;
    run('UPDATE contacts SET handled = ? WHERE id = ?', [handled, id]);
    res.json({ item: get('SELECT * FROM contacts WHERE id = ?', [id]), id });
  });

  router.delete('/contacts/:id', (req, res) => {
    const id = num(req.params.id, 0);
    const info = run('DELETE FROM contacts WHERE id = ?', [id]);
    if (!info.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, deleted: id });
  });

  router.get('/subscribers', (_req, res) => {
    res.json({ items: all('SELECT id, email, created_at FROM subscribers ORDER BY id DESC') });
  });

  return router;
}

module.exports = { publicRouter, adminRouter, SITE, PACKAGE_CATEGORIES };

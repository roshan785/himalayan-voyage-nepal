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
const { all, get, run, slugify, driver } = require('./db');
const {
  verifyPassword, issueToken, requireAuth, findUserByEmail, TOKEN_COOKIE
} = require('./auth');
const { notifyBooking } = require('./notify');

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
async function uniqueSlug(table, base, ignoreId = null) {
  let slug = slugify(base);
  if (!slug) slug = 'item';
  let candidate = slug;
  let i = 2;
  for (;;) {
    const row = ignoreId
      ? await get(`SELECT id FROM ${table} WHERE slug = ? AND id != ?`, [candidate, ignoreId])
      : await get(`SELECT id FROM ${table} WHERE slug = ?`, [candidate]);
    if (!row) return candidate;
    candidate = `${slug}-${i++}`;
    if (i > 5000) return `${slug}-${Date.now()}`;
  }
}

/** Attach a 400 error to the response. */
function bad(res, message) {
  return res.status(400).json({ error: message });
}

/**
 * Wrap an async route handler so a rejected promise reaches the Express error
 * handler instead of becoming an unhandled rejection.
 *
 * Express 4 does NOT catch errors thrown from `async` handlers: the rejection
 * escapes the router, Node logs it and (by default in Node >= 15) kills the
 * process — one bad row or a transient DB error would take the whole site down.
 * Every async route below is wrapped in this so a failure becomes a clean 500.
 */
function wrap(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/**
 * A router whose async handlers are all wrapped so a rejected promise reaches
 * the Express error handler instead of crashing the process. Express 4 only
 * auto-catches SYNCHRONOUS throws; an async handler that rejects (a DB error, a
 * bad row) would otherwise become an unhandled rejection and kill the server.
 * Using this everywhere means one failing request is a 500, never an outage.
 */
function asyncRouter() {
  const router = express.Router();
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const original = router[method].bind(router);
    router[method] = (...args) => {
      const last = args.length - 1;
      const handler = args[last];
      // Wrap only plain handlers (a sub-router has 4-arg handle signatures and a
      // `stack`, and middleware with 4 params is an error handler — leave those).
      if (typeof handler === 'function' && handler.length <= 3 && !handler.stack) {
        args[last] = wrap(handler);
      }
      return original(...args);
    };
  }
  return router;
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
    country: str(body.country, 120),
    capital: str(body.capital, 120),
    currency: str(body.currency, 120),
    language: str(body.language, 160),
    best_time: str(body.best_time, 200),
    visa: str(body.visa, 200),
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

/** Normalise a booking payload (admin edit). */
function normaliseBooking(body) {
  const status = ['new', 'confirmed', 'cancelled', 'done'].includes(body.status) ? body.status : 'new';
  return {
    package_slug: str(body.package_slug, 160),
    package_title: str(body.package_title, 200),
    name: str(body.name, 150),
    email: str(body.email, 200),
    phone: str(body.phone, 40),
    travellers: Math.max(1, Math.min(50, Math.round(num(body.travellers, 1)))),
    travel_date: str(body.travel_date, 40),
    message: str(body.message, 4000),
    status
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
  const router = asyncRouter();

  router.get('/', async (_req, res) => {
    const rows = await all(`SELECT * FROM ${table} ORDER BY ${orderBy}`);
    res.json({ items: table === 'packages' ? rows.map(packageOut) : rows });
  });

  router.post('/', async (req, res) => {
    const data = normalise(req.body || {});
    const label = data.title || data.name;
    if (!label) return bad(res, 'A title or name is required');
    const cols = Object.keys(data);
    const values = cols.map((c) => data[c]);
    if (hasSlug) {
      cols.push('slug');
      values.push(await uniqueSlug(table, label));
    }
    const placeholders = cols.map(() => '?').join(', ');
    const info = await run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`, values);
    const row = await get(`SELECT * FROM ${table} WHERE id = ?`, [info.lastInsertRowid]);
    const item = table === 'packages' ? packageOut(row) : row;
    // `id` is repeated at the top level so generic API clients can read the new
    // identifier without knowing the `{ item }` envelope.
    res.status(201).json({ item, id: item.id });
  });

  router.put('/:id', async (req, res) => {
    const id = num(req.params.id, 0);
    const existing = await get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const data = normalise(req.body || {});
    const label = data.title || data.name;
    if (!label) return bad(res, 'A title or name is required');
    const cols = Object.keys(data);
    const values = cols.map((c) => data[c]);
    if (hasSlug) {
      cols.push('slug');
      values.push(await uniqueSlug(table, label, id));
    }
    values.push(id);
    await run(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, values);
    const row = await get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
    const item = table === 'packages' ? packageOut(row) : row;
    res.json({ item, id: item.id });
  });

  router.delete('/:id', async (req, res) => {
    const id = num(req.params.id, 0);
    const info = await run(`DELETE FROM ${table} WHERE id = ?`, [id]);
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
  const router = asyncRouter();

  router.get('/health', async (_req, res) => {
    // Never expose a value — only whether each production variable reached the
    // container, plus a short non-reversible fingerprint for DATABASE_URL.
    // Without this, a deployment that silently falls back to SQLite gives no way
    // to tell "variable missing" apart from "variable present but malformed".
    const rawUrl = process.env.DATABASE_URL || '';
    const envPresence = {};
    for (const key of ['DATABASE_URL', 'JWT_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD']) {
      envPresence[key] = (process.env[key] || '').length > 0;
    }
    // Diagnose a variable that was set under a slightly different KEY NAME (a
    // trailing space, different case) or stored under another name entirely.
    // Only names are reported — never a value.
    const dbKeyNames = Object.keys(process.env)
      .filter((k) => k.trim().toUpperCase() === 'DATABASE_URL');
    const keysHoldingPostgresUrl = Object.keys(process.env)
      .filter((k) => /^postgres(ql)?:\/\//i.test((process.env[k] || '').trim()));
    res.json({
      ok: true,
      service: 'himalayan-voyage',
      uptime: process.uptime(),
      // Lets anyone confirm from outside whether this instance is on persistent
      // PostgreSQL or the ephemeral SQLite fallback.
      db: driver.kind,
      dbPersistent: driver.kind === 'postgres',
      databaseUrl: {
        present: rawUrl.length > 0,
        isPostgres: /^postgres(ql)?:\/\//i.test(rawUrl.trim()),
        fingerprint: rawUrl
          ? require('crypto').createHash('sha256').update(rawUrl).digest('hex').slice(0, 8)
          : null,
        exactKeyPresent: Object.prototype.hasOwnProperty.call(process.env, 'DATABASE_URL'),
        matchingKeyNames: dbKeyNames,
        keysHoldingPostgresUrl,
        envSource: process.env.OPENOS_ENV_SOURCE || null
      },
      env: envPresence,
      // Booking notifications are optional; report whether they are wired up so
      // an operator can see at a glance (never reveals secret values).
      notifications: require('./notify').status()
    });
  });

  router.get('/site', async (_req, res) => res.json(SITE));

  router.get('/stats', async (_req, res) => {
    res.json({
      packages: (await get('SELECT COUNT(*) AS n FROM packages')).n,
      destinations: (await get('SELECT COUNT(*) AS n FROM destinations')).n,
      testimonials: (await get('SELECT COUNT(*) AS n FROM testimonials')).n,
      posts: (await get('SELECT COUNT(*) AS n FROM blog_posts WHERE published = 1')).n
    });
  });

  router.get('/destinations', async (req, res) => {
    const { kind } = req.query;
    const rows = kind
      ? await all('SELECT * FROM destinations WHERE kind = ? ORDER BY featured DESC, name ASC', [str(kind, 40)])
      : await all('SELECT * FROM destinations ORDER BY featured DESC, name ASC');
    res.json({ items: rows });
  });

  router.get('/destinations/:slug', async (req, res) => {
    const row = await get('SELECT * FROM destinations WHERE slug = ?', [str(req.params.slug, 120)]);
    if (!row) return res.status(404).json({ error: 'Destination not found' });
    res.json({ item: row });
  });

  router.get('/packages', async (req, res) => {
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
    const rows = await all(`SELECT * FROM packages ${where} ORDER BY featured DESC, id DESC`, params);
    res.json({ items: rows.map(packageOut) });
  });

  router.get('/packages/:slug', async (req, res) => {
    const row = await get('SELECT * FROM packages WHERE slug = ?', [str(req.params.slug, 160)]);
    if (!row) return res.status(404).json({ error: 'Package not found' });
    res.json({ item: packageOut(row) });
  });

  router.get('/testimonials', async (_req, res) => {
    res.json({ items: await all('SELECT * FROM testimonials ORDER BY id DESC') });
  });

  router.get('/posts', async (_req, res) => {
    res.json({ items: await all('SELECT id, title, slug, excerpt, author, cover, created_at FROM blog_posts WHERE published = 1 ORDER BY id DESC') });
  });

  router.get('/posts/:slug', async (req, res) => {
    const row = await get('SELECT * FROM blog_posts WHERE slug = ? AND published = 1', [str(req.params.slug, 200)]);
    if (!row) return res.status(404).json({ error: 'Post not found' });
    res.json({ item: row });
  });

  router.post('/contact', async (req, res) => {
    const body = req.body || {};
    const name = str(body.name, 150);
    const email = str(body.email, 200);
    const message = str(body.message, 5000);
    if (!name) return bad(res, 'Your name is required');
    if (!isEmail(email)) return bad(res, 'A valid email address is required');
    if (message.length < 5) return bad(res, 'Please write a short message');
    const info = await run(
      'INSERT INTO contacts (name, email, phone, subject, message) VALUES (?, ?, ?, ?, ?)',
      [name, email, str(body.phone, 40), str(body.subject, 200), message]
    );
    res.status(201).json({ ok: true, id: info.lastInsertRowid });
  });

  router.post('/bookings', async (req, res) => {
    const body = req.body || {};
    const name = str(body.name, 150);
    const email = str(body.email, 200);
    if (!name) return bad(res, 'Your name is required');
    if (!isEmail(email)) return bad(res, 'A valid email address is required');
    const travellers = Math.max(1, Math.min(50, Math.round(num(body.travellers, 1))));
    const slug = str(body.package_slug, 160);
    const pkg = slug ? await get('SELECT id, title, slug FROM packages WHERE slug = ?', [slug]) : null;
    const info = await run(
      `INSERT INTO bookings
        (package_id, package_slug, package_title, name, email, phone, travellers, travel_date, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [pkg ? pkg.id : null, slug, pkg ? pkg.title : str(body.package_title, 200),
        name, email, str(body.phone, 40), travellers, str(body.travel_date, 40), str(body.message, 4000)]
    );
    // Notify the admin (best-effort; never blocks or fails the booking).
    const notified = await notifyBooking(Object.assign({ id: info.lastInsertRowid }, {
      package_title: pkg ? pkg.title : str(body.package_title, 200),
      name, email, phone: str(body.phone, 40), travellers, travel_date: str(body.travel_date, 40),
      message: str(body.message, 4000)
    }));
    if (!notified.sent && notified.reason && notified.reason !== 'not-configured') {
      console.warn('[booking] notification not sent:', notified.reason);
    }
    res.status(201).json({ ok: true, id: info.lastInsertRowid });
  });

  router.post('/newsletter', async (req, res) => {
    const email = str((req.body || {}).email, 200);
    if (!isEmail(email)) return bad(res, 'A valid email address is required');
    try {
      await run('INSERT INTO subscribers (email) VALUES (?)', [email.toLowerCase()]);
    } catch (_err) {
      return res.json({ ok: true, alreadySubscribed: true });
    }
    res.status(201).json({ ok: true });
  });

  router.post('/auth/login', async (req, res) => {
    const body = req.body || {};
    const email = str(body.email, 200).toLowerCase();
    const password = String(body.password || '');
    if (!email || !password) return bad(res, 'Email and password are required');
    const user = await findUserByEmail(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = issueToken(user);
    // HttpOnly cookie for same-origin browser use; token also returned for API
    // clients. `Secure` is added in production (HTTPS); over plain-http local
    // development browsers would otherwise drop the cookie entirely.
    const secure = (process.env.NODE_ENV === 'production' || req.secure) ? ' Secure;' : '';
    res.setHeader('Set-Cookie',
      `${TOKEN_COOKIE}=${encodeURIComponent(token)}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=43200`);
    res.json({ ok: true, token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  });

  router.post('/auth/logout', async (_req, res) => {
    res.setHeader('Set-Cookie', `${TOKEN_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  router.get('/auth/me', requireAuth(true), async (req, res) => {
    const user = await get('SELECT id, email, name, role FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(401).json({ error: 'Account no longer exists' });
    res.json({ user });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Admin API router (all routes require a valid JWT)
// ---------------------------------------------------------------------------

function adminRouter() {
  const router = asyncRouter();
  router.use(requireAuth(true));

  router.get('/overview', async (_req, res) => {
    res.json({
      counts: {
        packages: (await get('SELECT COUNT(*) AS n FROM packages')).n,
        destinations: (await get('SELECT COUNT(*) AS n FROM destinations')).n,
        posts: (await get('SELECT COUNT(*) AS n FROM blog_posts')).n,
        testimonials: (await get('SELECT COUNT(*) AS n FROM testimonials')).n,
        contacts: (await get('SELECT COUNT(*) AS n FROM contacts')).n,
        unreadContacts: (await get('SELECT COUNT(*) AS n FROM contacts WHERE handled = 0')).n,
        subscribers: (await get('SELECT COUNT(*) AS n FROM subscribers')).n,
        bookings: (await get('SELECT COUNT(*) AS n FROM bookings')).n,
        newBookings: await get("SELECT COUNT(*) AS n FROM bookings WHERE status = 'new'").n
      },
      recentContacts: await all('SELECT id, name, email, subject, handled, created_at FROM contacts ORDER BY id DESC LIMIT 5')
    });
  });

  router.use('/packages', crudRouter({ table: 'packages', normalise: normalisePackage }));
  router.use('/destinations', crudRouter({ table: 'destinations', normalise: normaliseDestination }));
  router.use('/testimonials', crudRouter({ table: 'testimonials', normalise: normaliseTestimonial }));
  router.use('/posts', crudRouter({ table: 'blog_posts', normalise: normalisePost, orderBy: 'id DESC' }));

  router.use('/bookings', crudRouter({ table: 'bookings', normalise: normaliseBooking, hasSlug: false }));

  // Contacts are read-only from the admin API except for the handled flag.
  router.get('/contacts', async (_req, res) => {
    res.json({ items: await all('SELECT * FROM contacts ORDER BY id DESC') });
  });

  router.patch('/contacts/:id', async (req, res) => {
    const id = num(req.params.id, 0);
    const existing = await get('SELECT * FROM contacts WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const handled = (req.body || {}).handled ? 1 : 0;
    await run('UPDATE contacts SET handled = ? WHERE id = ?', [handled, id]);
    res.json({ item: await get('SELECT * FROM contacts WHERE id = ?', [id]), id });
  });

  router.delete('/contacts/:id', async (req, res) => {
    const id = num(req.params.id, 0);
    const info = await run('DELETE FROM contacts WHERE id = ?', [id]);
    if (!info.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, deleted: id });
  });

  router.get('/subscribers', async (_req, res) => {
    res.json({ items: await all('SELECT id, email, created_at FROM subscribers ORDER BY id DESC') });
  });

  return router;
}

module.exports = { publicRouter, adminRouter, SITE, PACKAGE_CATEGORIES };

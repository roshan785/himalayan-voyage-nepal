'use strict';

/**
 * Himalayan Voyage Nepal — application server.
 *
 * Serves the static front-end (public/) and the JSON API (src/routes.js).
 * Configuration is entirely environment-driven so the same build runs locally
 * and in production.
 */

const path = require('path');
const fs = require('fs');

// Load .env (if present) before anything reads process.env.
// Minimal parser: KEY=VALUE lines, `#` comments, no external dependency.
(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
})();

// Some hosting dashboards expose a variable as a MOUNTED SECRET FILE rather than
// an environment variable (Render -> "Secret Files" writes to /etc/secrets/).
// Such a value never reaches process.env, so the app would silently fall back to
// SQLite while the dashboard shows the variable as configured. Read the usual
// mount points as a fallback; only the chosen path is ever logged, never the
// value. `OPENOS_ENV_SOURCE` records where DATABASE_URL came from for /api/health.
(function loadMountedSecrets() {
  const candidates = {
    DATABASE_URL: ['/etc/secrets/DATABASE_URL', '/etc/secrets/database_url', '/run/secrets/DATABASE_URL'],
    JWT_SECRET: ['/etc/secrets/JWT_SECRET', '/etc/secrets/jwt_secret', '/run/secrets/JWT_SECRET'],
    ADMIN_PASSWORD: ['/etc/secrets/ADMIN_PASSWORD', '/etc/secrets/admin_password', '/run/secrets/ADMIN_PASSWORD']
  };
  for (const [key, paths] of Object.entries(candidates)) {
    if ((process.env[key] || '').length > 0) continue;
    for (const p of paths) {
      try {
        if (!fs.existsSync(p)) continue;
        const value = fs.readFileSync(p, 'utf8').trim();
        if (!value) continue;
        process.env[key] = value;
        if (key === 'DATABASE_URL') process.env.OPENOS_ENV_SOURCE = 'file:' + p;
        console.log(`[env] ${key} loaded from mounted secret file ${p}`);
        break;
      } catch (_e) { /* unreadable mount — try the next candidate */ }
    }
  }
  if (!process.env.OPENOS_ENV_SOURCE && (process.env.DATABASE_URL || '').length > 0) {
    process.env.OPENOS_ENV_SOURCE = 'env';
  }
})();

const express = require('express');
const { ensureAdmin } = require('./src/auth');
const { publicRouter, adminRouter } = require('./src/routes');

// Number(process.env.PORT) || 3400 would wrongly drop PORT=0 (ephemeral),
// so only fall back when the variable is missing or not a number.
const parsedPort = Number(process.env.PORT);
const PORT = Number.isInteger(parsedPort) && parsedPort >= 0 ? parsedPort : 3400;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Behind a hosting proxy (Render, nginx) the socket peer is the proxy, so
// req.ip would be the proxy's address for every visitor — which makes the rate
// limiter below a single global bucket AND logs the wrong client IP. Trust the
// first hop so req.ip is the real client. Enabled only for the immediate proxy,
// not a blanket `true`, to avoid trusting a spoofable X-Forwarded-For chain.
app.set('trust proxy', 1);

// Baseline security headers (no external dependency required).
// Force HTTPS and advertise HSTS so a browser that ever reached the site over
// http:// is told to use https:// from then on. Without HSTS a browser may keep
// trying http:// (or a broken secure upgrade) and show "this site doesn't
// support a secure connection". Localhost is exempt so local dev stays on http.
app.use((req, res, next) => {
  const host = String(req.headers.host || '');
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  if (!isLocal && proto !== 'https') {
    return res.redirect(308, 'https://' + host + req.originalUrl);
  }
  if (!isLocal) {
    // One year, all subdomains — the browser will only use HTTPS for this host.
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "img-src 'self' data:; " +
    "style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; " +
    "connect-src 'self'; " +
    "font-src 'self'; " +
    "object-src 'none'; " +
    "base-uri 'self'; " +
    // frame-src must allow openstreetmap (contact-page map) AND YouTube, which
    // the homepage "play" button embeds. Without the YouTube origins the video
    // modal opens but the player is silently blocked by CSP.
    "frame-src https://www.openstreetmap.org https://www.youtube.com https://www.youtube-nocookie.com; " +
    "frame-ancestors 'self'"
  );
  next();
});

// Simple in-memory rate limiter for the public write endpoints.
const writeHits = new Map();
const WRITE_LIMIT = 40;          // requests
const WRITE_WINDOW_MS = 60_000;  // per minute, per IP
// A stricter, separate bucket for login: 10 attempts/minute/IP slows credential
// stuffing without locking a legitimate admin out. Counted per IP, not global.
const loginHits = new Map();
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_MS = 60_000;
// Prune expired entries periodically. Without this the maps grow without bound
// (one entry per IP that ever wrote) — a slow memory leak on a long-lived
// instance. The sweep only removes entries whose window has already reset.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of writeHits) if (now > entry.reset) writeHits.delete(ip);
  for (const [ip, entry] of loginHits) if (now > entry.reset) loginHits.delete(ip);
}, WRITE_WINDOW_MS).unref();

app.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  // Login gets its own, tighter window.
  if (req.method === 'POST' && req.path === '/api/auth/login') {
    const entry = loginHits.get(ip) || { count: 0, reset: now + LOGIN_WINDOW_MS };
    if (now > entry.reset) { entry.count = 0; entry.reset = now + LOGIN_WINDOW_MS; }
    entry.count += 1;
    loginHits.set(ip, entry);
    if (entry.count > LOGIN_LIMIT) {
      return res.status(429).json({ error: 'Too many sign-in attempts, please wait a minute' });
    }
    return next();
  }
  const isWrite = req.method === 'POST' && /^\/api\/(contact|newsletter|bookings)/.test(req.path);
  if (!isWrite) return next();
  const entry = writeHits.get(ip) || { count: 0, reset: now + WRITE_WINDOW_MS };
  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + WRITE_WINDOW_MS;
  }
  entry.count += 1;
  writeHits.set(ip, entry);
  if (entry.count > WRITE_LIMIT) {
    return res.status(429).json({ error: 'Too many requests, please slow down' });
  }
  next();
});

app.use('/api', publicRouter());
app.use('/api/admin', adminRouter());

// Static front-end.
// HTML must never be cached (so a deploy is visible immediately); assets carry
// a content-hash ?v=, so they can be cached hard without going stale.
app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else if (filePath.endsWith('.css') || filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (/\.(jpg|jpeg|png|webp|gif|svg|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    }
  }
}));

// Unknown HTML page → a real 404 page (so broken links are visible instead of
// being silently masked by a catch-all). API routes get JSON 404s.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(404).json({ error: 'Not found' });
  }
  res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
});

// JSON error handler — never leak stack traces to clients.
app.use((err, _req, res, _next) => {
  console.error('[error]', err && err.message ? err.message : err);
  // Deliberate 4xx errors carry an actionable message for the admin UI (e.g.
  // "image is too large — use a URL"). Pass those through verbatim so the
  // visitor sees WHY it failed instead of a generic 500.
  const status = err.status || err.statusCode || 500;
  if (status >= 400 && status < 500 && err.expose !== false && err.message) {
    return res.status(status).json({ error: err.message });
  }
  res.status(status).json({ error: 'Internal server error' });
});

async function start() {
  // Prepare storage BEFORE accepting traffic: create the schema (idempotent on
  // both SQLite and PostgreSQL), then seed the built-in content, then create the
  // admin account. All three are async now that the DB layer supports Postgres.
  const { init, seedIfEmpty } = require('./src/db');
  const kind = await init();
  await seedIfEmpty();
  await ensureAdmin();
  const server = app.listen(PORT, HOST, () => {
    // Log the ACTUAL bound port: with PORT=0 the OS picks a free one, and the
    // tests (and any ephemeral-port deployment) need to read it back.
    const actual = server.address().port;
    console.log(`Himalayan Voyage Nepal listening on http://${HOST}:${actual} (db: ${kind})`);
  });
  return server;
}

if (require.main === module) {
  start().catch((err) => {
    console.error('[fatal] failed to start:', err.message);
    process.exit(1);
  });

  // Last-resort guards so one stray rejection cannot take the whole site down.
  // A handled request already returns 500 via the express error handler; these
  // catch anything that escapes (e.g. a background timer) and keep the process
  // serving instead of exiting on an uncaught error.
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason && reason.message ? reason.message : reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err && err.stack ? err.stack : err);
  });
}

module.exports = { app, start };

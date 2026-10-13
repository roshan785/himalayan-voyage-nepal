'use strict';

/**
 * Authentication helpers: password hashing, JWT issuing/verification and the
 * Express middleware that guards the admin API. Kept separate from the routes
 * so the logic is unit-testable without booting a server.
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { get, run } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '12h';
const TOKEN_COOKIE = 'hv_token';

if (!process.env.JWT_SECRET) {
  console.warn('[auth] JWT_SECRET not set \u2014 using an insecure development default.');
}

/** Hash a plaintext password with bcrypt (cost 10). */
function hashPassword(plain) {
  return bcrypt.hashSync(String(plain), 10);
}

/** Constant-time-ish comparison of a plaintext password against a hash. */
function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compareSync(String(plain), hash);
}

/** Sign a short-lived JWT for an authenticated user. */
function issueToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role || 'admin' },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/** Verify a JWT. Returns the decoded payload or null when invalid. */
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (_err) {
    return null;
  }
}

/** Extract a bearer token from the Authorization header or the auth cookie. */
function tokenFromRequest(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)hv_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Express middleware. When `required` is false a missing token is allowed and
 * `req.user` stays undefined; an invalid token is still rejected so callers do
 * not silently treat a bad token as an anonymous request.
 */
function requireAuth(required = true) {
  // `async` so a throwing handler is reported through next(err) instead of
  // becoming an unhandled rejection (Express 4 does not catch async errors).
  return async (req, res, next) => {
    const token = tokenFromRequest(req);
    if (!token) {
      if (required) return res.status(401).json({ error: 'Authentication required' });
      return next();
    }
    const payload = verifyToken(token);
    if (!payload) {
      if (required) return res.status(401).json({ error: 'Invalid or expired token' });
      return next();
    }
    req.user = { id: payload.sub, email: payload.email, role: payload.role };
    next();
  };
}

/** Look up a user by email and return null when absent. */
async function findUserByEmail(email) {
  return (await get('SELECT * FROM users WHERE email = ?', [String(email || '').toLowerCase().trim()])) || null;
}

/** Create a user if the email is not already taken. Returns the new row. */
async function createUser({ email, password, name = 'Admin', role = 'admin' }) {
  const normalised = String(email || '').toLowerCase().trim();
  if (!normalised || !password) throw new Error('email and password are required');
  const hash = hashPassword(password);
  await run('INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)',
    [normalised, hash, name, role]);
  return findUserByEmail(normalised);
}

/**
 * Ensure at least one admin exists. Credentials come from env so a fresh
 * deployment is usable without a manual DB step.
 */
async function ensureAdmin() {
  const count = Number((await get('SELECT COUNT(*) AS n FROM users')).n);
  if (count > 0) return null;
  const email = process.env.ADMIN_EMAIL || 'admin@himalayanvoyage.test';
  const password = process.env.ADMIN_PASSWORD || 'admin12345';
  const user = await createUser({ email, password, name: 'Administrator', role: 'admin' });
  console.log(`[auth] created default admin <${email}>`);
  return user;
}

module.exports = {
  hashPassword,
  verifyPassword,
  issueToken,
  verifyToken,
  requireAuth,
  tokenFromRequest,
  findUserByEmail,
  createUser,
  ensureAdmin,
  TOKEN_COOKIE
};

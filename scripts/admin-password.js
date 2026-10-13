'use strict';

/**
 * Set (or reset) the admin password.
 *
 *   npm run admin:pass -- <new-password> [email]
 *
 * If the admin does not exist it is created; if it already exists its password
 * hash is replaced. This is the recovery path when the Render dashboard value of
 * ADMIN_PASSWORD is unknown — `ensureAdmin()` only seeds the FIRST admin and
 * never touches an existing row, so it cannot reset a lost password.
 *
 * The password is read from argv (never logged) and only its bcrypt hash is
 * written to the database.
 */

const { hashPassword, findUserByEmail, createUser } = require('../src/auth');
const { run, get, DB_PATH } = require('../src/db');

const password = process.argv[2];
const email = (process.argv[3] || process.env.ADMIN_EMAIL || 'admin@himalayanvoyage.test').toLowerCase().trim();

if (!password || password.length < 6) {
  console.error('Usage: npm run admin:pass -- <new-password (min 6 chars)> [email]');
  process.exit(1);
}

const existing = findUserByEmail(email);
if (existing) {
  run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(password), existing.id]);
  console.log(`Admin password updated for <${email}> in ${DB_PATH}`);
} else {
  const user = createUser({ email, password, name: 'Administrator', role: 'admin' });
  console.log(`Admin created <${user.email}> in ${DB_PATH}`);
}

// Never print the password — only a confirmation and the current admin count.
const n = get('SELECT COUNT(*) AS n FROM users').n;
console.log(`  admins in database: ${n}`);

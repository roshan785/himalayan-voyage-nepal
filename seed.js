'use strict';

/**
 * Ensures the database exists, the seed content is present and an admin user
 * has been created. Safe to run multiple times (idempotent).
 *
 *   npm run seed
 */

const { ensureAdmin } = require('./src/auth');
const { get, DB_PATH } = require('./src/db');

const admin = ensureAdmin();

console.log('Database ready: ' + DB_PATH);
console.log('  packages     : ' + get('SELECT COUNT(*) AS n FROM packages').n);
console.log('  destinations : ' + get('SELECT COUNT(*) AS n FROM destinations').n);
console.log('  testimonials : ' + get('SELECT COUNT(*) AS n FROM testimonials').n);
console.log('  blog posts   : ' + get('SELECT COUNT(*) AS n FROM blog_posts').n);
if (admin) console.log('  admin        : created <' + admin.email + '>');
else console.log('  admin        : already exists');

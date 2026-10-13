'use strict';

/**
 * Ensures the database exists, the seed content is present and an admin user
 * has been created. Safe to run multiple times (idempotent).
 *
 *   npm run seed
 *
 * Works against whichever driver is active: SQLite locally (no DATABASE_URL) or
 * PostgreSQL when DATABASE_URL is set.
 */

const { ensureAdmin } = require('./src/auth');
const { get, DB_PATH, DATABASE_URL, IS_PG } = require('./src/db');

(async () => {
  const admin = await ensureAdmin();

  console.log('Database ready: ' + (IS_PG ? 'PostgreSQL (' + DATABASE_URL.replace(/:[^:@/]+@/, ':***@') + ')' : DB_PATH));
  console.log('  packages     : ' + (await get('SELECT COUNT(*) AS n FROM packages')).n);
  console.log('  destinations : ' + (await get('SELECT COUNT(*) AS n FROM destinations')).n);
  console.log('  testimonials : ' + (await get('SELECT COUNT(*) AS n FROM testimonials')).n);
  console.log('  blog posts   : ' + (await get('SELECT COUNT(*) AS n FROM blog_posts')).n);
  if (admin) console.log('  admin        : created <' + admin.email + '>');
  else console.log('  admin        : already exists');
})().catch((err) => {
  console.error('[fatal] seed failed:', err.message);
  process.exit(1);
});

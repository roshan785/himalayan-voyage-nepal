'use strict';

/**
 * Minimal .env loader, shared by the CLI scripts.
 *
 * server.js has its own inline loader because it must run before any other
 * require(); the standalone scripts (migration, persistence test, admin
 * password) need the same behaviour so that putting `DATABASE_URL` in `.env`
 * works everywhere instead of only when the server is the one starting up.
 *
 * Format: KEY=VALUE lines, `#` comments, optional single/double quotes.
 * Existing environment variables always win (so `DATABASE_URL=... npm run x`
 * overrides the file).
 */

const fs = require('fs');
const path = require('path');

function loadDotEnv(envPath) {
  const target = envPath || path.join(__dirname, '..', '.env');
  if (!fs.existsSync(target)) return { loaded: 0, path: target };
  const text = fs.readFileSync(target, 'utf8');
  let loaded = 0;
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
    if (!key) continue;
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
      loaded += 1;
    }
  }
  return { loaded, path: target };
}

module.exports = { loadDotEnv };

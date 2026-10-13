'use strict';

/**
 * Post-deploy verifier (used by CI and by `npm run deploy:verify`).
 *
 * Polls the running service until it is healthy AND reports PostgreSQL with
 * persistence, then asserts the key read endpoints answer 200. Exits 0 on
 * success, 1 on failure so a bad release fails the pipeline / alerts the team.
 *
 *   DEPLOY_URL=https://… node scripts/deploy-verify.js
 *
 * Uses the core https module (not global fetch), matching uptime-check.js, so it
 * behaves the same in restricted runtimes.
 */

const https = require('https');
const http = require('http');
const { URL: NodeURL } = require('url');

const BASE = (process.env.DEPLOY_URL || 'https://himalayan-voyage-nepal-0sem.onrender.com').replace(/\/$/, '');
const MAX_WAIT_MS = Number(process.env.DEPLOY_WAIT_MS) || 180000;
const POLL_MS = Number(process.env.DEPLOY_POLL_MS) || 10000;

function requestText(target, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const u = new NodeURL(target);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET', family: 4 },
      (res) => { let d = ''; res.setEncoding('utf8'); res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy() {
  const deadline = Date.now() + MAX_WAIT_MS;
  let last = 'no attempt';
  while (Date.now() < deadline) {
    try {
      const res = await requestText(BASE + '/api/health');
      const body = JSON.parse(res.body || '{}');
      if (res.status === 200 && body.ok === true && body.db === 'postgres' && body.dbPersistent === true) {
        return { ok: true, detail: `db=${body.db} persistent=${body.dbPersistent}` };
      }
      last = `status=${res.status} db=${body.db} persistent=${body.dbPersistent}`;
    } catch (err) {
      last = err.message;
    }
    await sleep(POLL_MS);
  }
  return { ok: false, detail: last };
}

async function main() {
  console.log(`[deploy-verify] ${BASE} — waiting for a healthy PostgreSQL instance…`);
  const health = await waitHealthy();
  if (!health.ok) {
    console.error(`[deploy-verify] \u274c not healthy: ${health.detail}`);
    process.exit(1);
  }
  console.log(`[deploy-verify] \u2705 healthy (${health.detail})`);

  const endpoints = ['/api/packages', '/api/destinations', '/api/site'];
  let failed = 0;
  for (const ep of endpoints) {
    try {
      const res = await requestText(BASE + ep);
      const good = res.status === 200;
      console.log(`  ${good ? '\u2705' : '\u274c'} ${ep} → HTTP ${res.status}`);
      if (!good) failed++;
    } catch (err) {
      console.log(`  \u274c ${ep} → ${err.message}`);
      failed++;
    }
  }
  if (failed) {
    console.error(`[deploy-verify] \u274c ${failed} endpoint(s) failed`);
    process.exit(1);
  }
  console.log('[deploy-verify] \u2705 deploy OK');
}

main();

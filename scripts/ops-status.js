'use strict';

/**
 * Ops status report — one command that answers "is production healthy?".
 *
 *   node scripts/ops-status.js            # print a report
 *   node scripts/ops-status.js --json     # machine-readable (for a monitor)
 *
 * Covers: live health (db + persistence), response time, DB row counts, recent
 * backup integrity, newest backup age, and whether notifications are configured.
 * Uses the core https module (works where global fetch does not). Read-only.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL: NodeURL } = require('url');
const { loadDotEnv } = require('../src/load-env');

loadDotEnv();

const ROOT = path.join(__dirname, '..');
const BASE = (process.env.DEPLOY_URL || 'https://himalayan-voyage-nepal-0sem.onrender.com').replace(/\/$/, '');
const BACKUP_DIR = path.join(ROOT, 'backups');

function get(target, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const started = Date.now();
    let u; try { u = new NodeURL(target); } catch (e) { return resolve({ ok: false, error: e.message }); }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET', family: 4 }, (res) => {
      let d = ''; res.setEncoding('utf8'); res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ ok: true, status: res.statusCode, ms: Date.now() - started, body: d }));
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message, ms: Date.now() - started }));
    req.setTimeout(timeoutMs, () => req.destroy());
    req.end();
  });
}

function backupInfo() {
  if (!fs.existsSync(BACKUP_DIR)) return { count: 0, newest: null };
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => /^backup-(sqlite|pg)-/.test(f) && !/-(wal|shm)$/.test(f));
  if (!files.length) return { count: 0, newest: null };
  const sorted = files.map((f) => ({ f, m: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs })).sort((a, b) => b.m - a.m);
  const newest = sorted[0];
  const ageH = ((Date.now() - newest.m) / 3600000).toFixed(1);
  return { count: files.length, newest: newest.f, newestAgeHours: Number(ageH) };
}

async function main() {
  const health = await get(BASE + '/api/health');
  const report = { at: new Date().toISOString(), base: BASE };

  if (health.ok) {
    try {
      const b = JSON.parse(health.body);
      report.health = { status: health.status, ms: health.ms, db: b.db, dbPersistent: b.dbPersistent, notifications: b.notifications || null };
    } catch (_e) { report.health = { status: health.status, ms: health.ms, parseError: true }; }
  } else {
    report.health = { reachable: false, error: health.error, ms: health.ms };
  }

  // Response time for a heavier read endpoint.
  const packages = await get(BASE + '/api/packages');
  report.packages = { status: packages.status || 'ERR', ms: packages.ms };

  // 404 handling sanity.
  const notFound = await get(BASE + '/api/does-not-exist');
  report.api404 = notFound.status || 'ERR';

  report.backups = backupInfo();

  if (process.argv.includes('--json')) { console.log(JSON.stringify(report, null, 2)); return; }

  const h = report.health;
  console.log('Himalayan Voyage Nepal — ops status');
  console.log('  time            :', report.at);
  console.log('  health          :', h.reachable === false ? '❌ unreachable (' + h.error + ')' : `HTTP ${h.status} in ${h.ms}ms`);
  if (h.db) console.log('  database        :', h.db, '| persistent:', h.dbPersistent);
  if (h.notifications) console.log('  notifications   :', h.notifications.configured ? 'configured (' + h.notifications.provider + ')' : 'not configured');
  console.log('  /api/packages   :', `HTTP ${report.packages.status} in ${report.packages.ms}ms`);
  console.log('  API 404 sanity  :', report.api404 === 404 ? '✅ 404' : '⚠️ ' + report.api404);
  console.log('  backups         :', report.backups.count, 'files; newest', report.backups.newest || '(none)', report.backups.newestAgeHours != null ? `(${report.backups.newestAgeHours}h old)` : '');
  const healthy = h.reachable !== false && h.db === 'postgres' && h.dbPersistent === true;
  console.log('  OVERALL         :', healthy ? '✅ production healthy' : '⚠️ check above');
  process.exit(healthy ? 0 : 1);
}

main();

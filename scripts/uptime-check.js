'use strict';

/**
 * Uptime check + alerting with NO paid service and NO extra dependency.
 *
 *   node scripts/uptime-check.js                 # check once, print result
 *   node scripts/uptime-check.js --watch         # check every 5 min until
 *                                                # stopped (for cron/systemd)
 *
 * Checks /api/health on the configured base URL (UPTIME_URL or the production
 * default), verifies db=postgres and dbPersistent=true, and — when a webhook
 * is configured (UPTIME_WEBHOOK / Telegram / Discord) — posts an alert on the
 * FIRST failure and a recovery notice when it comes back. State is kept in
 * ~/.openos/travel-nepal-uptime.json so it does not alert repeatedly.
 *
 * This is the low-cost path: it runs on the existing free Render service and a
 * local scheduler. No external account is required unless you add a webhook.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { URL: NodeURL } = require('url');

const URL = process.env.UPTIME_URL || 'https://himalayan-voyage-nepal-0sem.onrender.com/api/health';
const STATE = process.env.UPTIME_STATE || path.join(os.homedir(), '.openos', 'travel-nepal-uptime.json');
const INTERVAL_MS = Number(process.env.UPTIME_INTERVAL_MS) || 5 * 60 * 1000;

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_e) { return { ok: true, since: null }; }
}

function writeState(s) {
  try { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); } catch (_e) {}
}

/**
 * Minimal HTTP(S) request helper returning { status, body }.
 *
 * Uses the core http/https modules rather than global fetch: in this runtime
 * undici-based fetch could not establish any connection (UND_ERR_CONNECT_TIMEOUT)
 * while the raw TLS client worked, so the core modules are the reliable path.
 * Zero dependencies, and it honours the same timeout semantics.
 */
function requestText(target, { method = 'GET', body = null, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new NodeURL(target); } catch (e) { return reject(e); }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('request timed out')); });
    if (body) req.write(body);
    req.end();
  });
}

async function notify(text) {
  const hooks = [process.env.UPTIME_WEBHOOK, process.env.DISCORD_WEBHOOK, process.env.TELEGRAM_WEBHOOK]
    .filter(Boolean);
  for (const hook of hooks) {
    try {
      const body = hook.includes('discord')
        ? JSON.stringify({ content: text })
        : JSON.stringify({ text });
      await requestText(hook, { method: 'POST', body, timeoutMs: 10000 });
    } catch (_e) { /* best effort — never throw from the notifier */ }
  }
}

async function checkOnce() {
  const started = Date.now();
  let ok = false;
  let detail = '';
  try {
    const res = await requestText(URL, { timeoutMs: 30000 });
    const body = JSON.parse(res.body || '{}');
    ok = res.status === 200 && body.ok === true && body.db === 'postgres' && body.dbPersistent === true;
    detail = `HTTP ${res.status} db=${body.db} persistent=${body.dbPersistent}`;
  } catch (err) {
    detail = 'unreachable: ' + err.message;
  }
  const ms = Date.now() - started;
  const prev = readState();
  const now = new Date().toISOString();

  if (!ok && prev.ok !== false) {
    writeState({ ok: false, since: now });
    await notify(`\u26a0\ufe0f Himalayan Voyage Nepal DOWN (${detail}) at ${now}`);
    console.log(`[uptime] ${now} \u274c DOWN — ${detail} (${ms}ms)`);
  } else if (ok && prev.ok === false) {
    writeState({ ok: true, since: now, recoveredAt: now });
    await notify(`\u2705 Himalayan Voyage Nepal RECOVERED at ${now}`);
    console.log(`[uptime] ${now} \u2705 recovered`);
  } else {
    writeState({ ok, since: prev.since || now, lastCheck: now });
    console.log(`[uptime] ${now} ${ok ? '\u2705 UP' : '\u274c DOWN'} — ${detail} (${ms}ms)`);
  }
  return ok;
}

async function main() {
  if (process.argv.includes('--watch')) {
    console.log(`[uptime] watching ${URL} every ${INTERVAL_MS / 1000}s`);
    for (;;) {
      await checkOnce();
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }
  } else {
    const ok = await checkOnce();
    process.exit(ok ? 0 : 1);
  }
}

main();

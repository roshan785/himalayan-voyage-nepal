/**
 * Interaction test for packages.html — verifies the features that surround
 * pagination still behave, so the pagination change cannot have quietly
 * broken search / category filtering / sorting / the detail view.
 *
 * Uses real Chrome over CDP (no puppeteer dependency). Run:
 *   node tests/features-cdp.mjs [baseUrl]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:4611/packages.html';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const PORT = 9900 + (process.pid % 400);

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const failures = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!ok) failures.push(label);
}

const profile = mkdtempSync(path.join(tmpdir(), 'hv-feat-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--no-sandbox',
  '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1280,950',
  '--user-data-dir=' + profile, 'about:blank',
], { stdio: 'ignore' });

function cleanup() {
  try { chrome.kill('SIGKILL'); } catch { /* gone */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
}

let wsUrl = null;
for (let i = 0; i < 100 && !wsUrl; i += 1) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    if (r.ok) wsUrl = (await r.json()).webSocketDebuggerUrl;
  } catch { /* not up yet */ }
  if (!wsUrl) await sleep(200);
}
if (!wsUrl) {
  console.log('SKIP: headless Chrome unavailable');
  cleanup();
  process.exit(2);
}

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let msgId = 0;
const pending = new Map();
const jsErrors = [];
let sessionId = null;

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
    return;
  }
  if (sessionId && msg.sessionId === sessionId && msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    jsErrors.push((d.exception && d.exception.description) || d.text || 'unknown');
  }
});

function send(method, params = {}) {
  const id = ++msgId;
  const payload = { id, method, params };
  // The browser-level endpoint rejects a null sessionId; only attach it once a
  // target session exists.
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('CDP timeout: ' + method));
      }
    }, 45000);
  });
}

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const attached = await send('Target.attachToTarget', { targetId, flatten: true });
sessionId = attached.sessionId;
await send('Page.enable');
await send('Runtime.enable');

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, userGesture: true,
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error((d.exception && d.exception.description) || d.text || 'evaluate failed');
  }
  return res.result.value;
}

async function goto(url) {
  await send('Page.navigate', { url });
  for (let i = 0; i < 150; i += 1) {
    const s = await evaluate('document.readyState').catch(() => 'loading');
    if (s === 'complete') break;
    await sleep(200);
  }
  await settle();
}

// App.skeletonCards() paints placeholders that also carry class="card" but no
// link, so "cards > 0" is not proof the list arrived. Wait until the grid holds
// real cards AND the count line is rendered — i.e. the render is finished.
async function settle() {
  for (let i = 0; i < 200; i += 1) {
    const ready = await evaluate(`(() => {
      const real = ${REAL_CARDS};
      const txt = (document.getElementById('package-count') || {}).textContent || '';
      return real > 0 && /Showing/.test(txt);
    })()`).catch(() => false);
    if (ready) return true;
    await sleep(200);
  }
  return false;
}

// A real (non-skeleton) card = a .card that contains a detail link. Note the
// count is over CARDS: each card carries two slug links (the cover overlay
// .desti-cta and the .btn--primary), so counting anchors would double it.
const REAL_CARDS = `[...document.querySelectorAll('#package-grid .card')].filter((c) => c.querySelector('a[href*="slug="]')).length`;
const realCards = () => evaluate(REAL_CARDS);
const cards = realCards;
const countText = () => evaluate("(document.getElementById('package-count')||{}).textContent.trim()");

// Polls a JS expression until it is truthy. Replaces fixed sleeps so a slow
// server (Render cold start) cannot make the test measure a half-painted grid.
async function waitUntil(expr, label, tries = 200) {
  for (let i = 0; i < tries; i += 1) {
    if (await evaluate(expr).catch(() => false)) return true;
    await sleep(200);
  }
  throw new Error('timed out waiting for: ' + label);
}


// ── 1. Baseline listing ───────────────────────────────────────────────────
await goto(BASE);
check('listing renders cards', (await cards()) > 0, true);
check('page size is 3', await cards(), 3);

// ── 2. Search box filters and re-paginates ────────────────────────────────
const searched = await evaluate(`(() => {
  const s = document.getElementById('package-search');
  if (!s) return 'missing';
  s.value = 'pokhara';
  s.dispatchEvent(new Event('input', { bubbles: true }));
  return 'typed';
})()`);
check('search input exists', searched, 'typed');
// 280ms debounce + fetch + render: wait for the list to actually narrow.
await waitUntil(REAL_CARDS + " === 1", 'search narrowed to 1 result');
const searchCards = await cards();
const searchCount = await countText();
check('search narrows the list to matches', searchCards >= 1 && searchCards <= 3, true);
// The page pluralises correctly ("1 package" / "9 packages"); mirror it.
const pkgWord = (n) => (n === 1 ? 'package' : 'packages');
const showingText = (from, to, tot) => `Showing ${from}\u2013${to} of ${tot} ${pkgWord(tot)}`;

check('search count text reflects matches', searchCount, showingText(1, searchCards, searchCards));
const searchTitles = await evaluate(
  "[...document.querySelectorAll('#package-grid .card')].map((c) => c.textContent.toLowerCase()).join(' ').includes('pokhara')",
);
check('search result actually matches "pokhara"', searchTitles, true);

// Clearing the search restores the full list
await evaluate(`(() => {
  const s = document.getElementById('package-search');
  s.value = '';
  s.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await waitUntil(REAL_CARDS + " === 3", 'full list restored');
check('clearing search restores page 1 again', await cards(), 3);

// ── 3. Category tabs ──────────────────────────────────────────────────────
const tabInfo = await evaluate(`(() => {
  const tabs = [...document.querySelectorAll('#package-tabs .tab, #package-tabs button, #package-tabs [data-category]')];
  return { count: tabs.length, labels: tabs.map((t) => t.textContent.trim()) };
})()`);
check('category tabs are present', tabInfo.count > 0, true);

const clickedTab = await evaluate(`(() => {
  const tabs = [...document.querySelectorAll('#package-tabs .tab, #package-tabs button, #package-tabs [data-category]')];
  const t = tabs.find((x) => /trek/i.test(x.textContent));
  if (!t) return 'not found';
  t.click();
  return 'clicked';
})()`);
if (clickedTab === 'clicked') {
  await settle();
  const trekCards = await cards();
  check('trekking tab filters the grid', trekCards >= 1 && trekCards <= 3, true);
  // Back to all
  await evaluate(`(() => {
    const tabs = [...document.querySelectorAll('#package-tabs .tab, #package-tabs button, #package-tabs [data-category]')];
    const t = tabs.find((x) => /all/i.test(x.textContent));
    if (t) t.click();
    return true;
  })()`);
  await waitUntil(REAL_CARDS + " === 3", 'all tab restored');
  check('"All" tab restores page 1', await cards(), 3);
}

// ── 4. Sort control does not break pagination ─────────────────────────────
const sortInfo = await evaluate(`(() => {
  const s = document.getElementById('package-sort');
  return s ? { present: true, options: s.options.length } : { present: false, options: 0 };
})()`);
check('sort control is present with options', sortInfo.present && sortInfo.options > 1, true);
if (sortInfo.present) {
  await evaluate(`(() => {
    const s = document.getElementById('package-sort');
    s.selectedIndex = s.options.length - 1;
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitUntil(REAL_CARDS + " === 3", 'sort re-render');
  check('sorting keeps 3 cards on page 1', await cards(), 3);
}

// ── 5. Detail view still opens ────────────────────────────────────────────
const detail = await evaluate(`(async () => {
  const a = document.querySelector('#package-grid .card a.btn--primary');
  if (!a) return { ok: false, why: 'no link' };
  const href = a.getAttribute('href');
  return { ok: true, href };
})()`);
check('card exposes a detail link', detail.ok, true);
if (detail.ok) {
  await goto(new URL(detail.href, BASE).toString());
  const shown = await evaluate(`(() => {
    const box = document.getElementById('package-detail');
    if (!box) return { present: false };
    return {
      present: true,
      visible: !box.classList.contains('hidden'),
      hasHeading: !!box.querySelector('h1, h2'),
      hasContent: box.textContent.trim().length > 40,
    };
  })()`);
  check('detail view renders', shown.present, true);
  check('detail view is not hidden', shown.visible, true);
  check('detail view has a heading', shown.hasHeading, true);
  check('detail view has content', shown.hasContent, true);
  check('detail URL carries ?slug=', detail.href.includes('slug='), true);
}

check('no uncaught JavaScript errors', jsErrors, []);

cleanup();
ws.close();
console.log('');
if (failures.length) {
  console.log(`RESULT: FAIL — ${failures.length} check(s): ${failures.join(' | ')}`);
  process.exit(1);
}
console.log('RESULT: PASS — search, category tabs, sort and detail view all still work');
process.exit(0);

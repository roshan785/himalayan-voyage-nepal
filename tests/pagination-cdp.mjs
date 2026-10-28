/**
 * Pagination regression test for packages.html — real Chrome via CDP.
 *
 * The repo ships no headless-browser dependency (puppeteer-core is not a
 * production dep), so this driver speaks to Chrome's DevTools Protocol over
 * Node 22's built-in WebSocket. No npm install required.
 *
 * It asserts the customer-facing contract:
 *   - 3 packages per page on the 3-column grid (never an orphan row)
 *   - "Showing X–Y of Z" text is correct on every page
 *   - Prev disabled on page 1, Next disabled on the last page
 *   - Next/Prev walk page by page and never escape the range
 *   - every package is reachable exactly once (no drop, no duplicate)
 *
 * Usage: node tests/pagination-cdp.mjs [url] [perPage]
 * Exits 0 on success, 1 on any failure, 2 when Chrome/CDP is unavailable.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const URL_ARG = process.argv[2] || 'http://127.0.0.1:4611/packages.html';
const PER_PAGE = Number(process.argv[3] || 3);
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const PORT = 9500 + (process.pid % 400);

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const failures = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!ok) failures.push(label);
}

// ── Launch Chrome with remote debugging ───────────────────────────────────
const profile = mkdtempSync(path.join(tmpdir(), 'hv-cdp-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=' + PORT,
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--window-size=1280,950',
  '--user-data-dir=' + profile,
  'about:blank',
], { stdio: 'ignore' });

function cleanup() {
  try { chrome.kill('SIGKILL'); } catch { /* already gone */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
}

async function waitForDevtools() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  return null;
}

const wsUrl = await waitForDevtools();
if (!wsUrl) {
  console.log('SKIP: could not start headless Chrome (CDP unreachable)');
  cleanup();
  process.exit(2);
}

// ── Minimal CDP client ────────────────────────────────────────────────────
const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

let msgId = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
    return;
  }
  if (msg.method) events.push(msg);
});

function send(method, params = {}, sessionId) {
  const id = ++msgId;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, 45000);
  });
}

// Attach to a fresh target (tab) in the browser.
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);

// Collect uncaught page errors — a broken packages.js must fail the test.
const jsErrors = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.sessionId !== sessionId) return;
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    jsErrors.push((d.exception && d.exception.description) || d.text || 'unknown error');
  }
});

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  }, sessionId);
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error((d.exception && d.exception.description) || d.text || 'evaluate failed');
  }
  return res.result.value;
}

async function goto(url) {
  await send('Page.navigate', { url }, sessionId);
  for (let i = 0; i < 150; i += 1) {
    const state = await evaluate('document.readyState').catch(() => 'loading');
    if (state === 'complete') break;
    await sleep(200);
  }
  // App.skeletonCards() renders placeholders that also carry class="card",
  // so .card alone is not proof the list arrived. Wait for a real card (one
  // with a detail link), which is what a user actually sees.
  for (let i = 0; i < 150; i += 1) {
    const n = await evaluate("document.querySelectorAll('#package-grid .card a[href*=\"slug=\"]').length").catch(() => 0);
    if (n > 0) return;
    await sleep(200);
  }
  throw new Error('no real package card rendered: ' + url);
}

// ── Page probe (everything read from the live DOM) ─────────────────────────
const PROBE = `(() => {
  // Skeleton placeholders from App.skeletonCards() also use class="card" but
  // have no links, so measure only real cards (the ones with a detail link).
  const allCards = [...document.querySelectorAll('#package-grid .card')];
  const cards = allCards.filter((c) => c.querySelector('a[href*="slug="]'));
  const pager = document.getElementById('package-pager');
  const btn = (re) => [...document.querySelectorAll('.pager__btn')].find((b) => re.test(b.textContent));
  const prev = btn(/Prev/i), next = btn(/Next/i);
  const active = document.querySelector('.pager__btn.is-active');
  return {
    cardCount: cards.length,
    slugs: cards.map((c) => {
      const a = c.querySelector('a.btn--primary');
      if (!a) return '';
      const m = a.getAttribute('href').match(/slug=([^&]+)/);
      return m ? decodeURIComponent(m[1]) : '';
    }),
    rows: new Set(cards.map((c) => Math.round(c.getBoundingClientRect().top))).size,
    countText: (document.getElementById('package-count') || {}).textContent.trim(),
    pagerPresent: !!pager,
    pagerHidden: pager ? pager.hidden : null,
    pagerDisplay: pager ? getComputedStyle(pager).display : null,
    activePage: active ? active.textContent.trim() : null,
    prevDisabled: prev ? prev.disabled : null,
    nextDisabled: next ? next.disabled : null,
    buttonLabels: [...document.querySelectorAll('.pager__btn')].map((b) => b.textContent.trim()),
  };
})()`;

async function snapshot() {
  return evaluate(PROBE);
}

async function clickNext() {
  return evaluate(`(() => {
    const b = [...document.querySelectorAll('.pager__btn')].find((x) => /Next/i.test(x.textContent));
    if (!b || b.disabled) return false;
    b.click();
    return true;
  })()`);
}

async function clickPrev() {
  return evaluate(`(() => {
    const b = [...document.querySelectorAll('.pager__btn')].find((x) => /Prev/i.test(x.textContent));
    if (!b || b.disabled) return false;
    b.click();
    return true;
  })()`);
}

// ── Run ───────────────────────────────────────────────────────────────────
await goto(URL_ARG);
// goto() already waited for a real (non-skeleton) card.

// The page itself may be filtered (?category=…); expected counts must come from
// the same query the page uses. packages.js reads only `category` and `slug`
// from the URL — free-text search goes through the search box, not the query
// string — so mirrors exactly that.
const apiQuery = await evaluate(`(() => {
  const cat = new URLSearchParams(location.search).get('category');
  return cat && cat !== 'all' ? 'category=' + encodeURIComponent(cat) : '';
})()`);
const total = await evaluate(
  `fetch('/api/packages${apiQuery ? '?' + apiQuery : ''}').then((r) => r.json()).then((d) => (d.items || d).length)`,
);
const pages = Math.ceil(total / PER_PAGE);
console.log(`\nURL ${URL_ARG}`);
console.log(`total packages = ${total}, pages = ${pages}, per page = ${PER_PAGE}\n`);

// The page pluralises correctly ("1 package" / "9 packages"); mirror it.
const pkgWord = (n) => (n === 1 ? 'package' : 'packages');
const showingText = (from, to, tot) => `Showing ${from}\u2013${to} of ${tot} ${pkgWord(tot)}`;

const seen = [];

// Page 1
const p1 = await snapshot();
const firstPageCount = Math.min(PER_PAGE, total);
check('page 1 card count', p1.cardCount, firstPageCount);
check('page 1 shows a single row (no orphan)', p1.rows, 1);
check('page 1 count text', p1.countText, showingText(1, firstPageCount, total));
seen.push(...p1.slugs.filter(Boolean));

if (pages <= 1) {
  // Contract from renderPager(): with a single page of results there is
  // nothing to page through, so the control is emptied and hidden. That is
  // correct behaviour, not a regression.
  check('single page: pager is removed', p1.pagerHidden, true);
  check('single page: no page buttons rendered', p1.buttonLabels, []);
  check('single page: every package reachable', seen.length, total);
  check('no uncaught JavaScript errors', jsErrors, []);
  cleanup();
  ws.close();
  console.log('');
  if (failures.length) {
    console.log(`RESULT: FAIL — ${failures.length} check(s): ${failures.join(' | ')}`);
    process.exit(1);
  }
  console.log(`RESULT: PASS — ${total} packages, single page (pager correctly hidden), no JS errors`);
  process.exit(0);
}

check('page 1 active page', p1.activePage, '1');
check('page 1 Prev disabled', p1.prevDisabled, true);
check('page 1 Next enabled (more pages exist)', p1.nextDisabled, false);
check('pager is visible, not hidden', p1.pagerHidden, false);
check('pager is actually displayed', p1.pagerDisplay !== 'none', true);

// Walk forward with the real Next button
for (let i = 2; i <= pages; i += 1) {
  const clicked = await clickNext();
  check(`Next click to page ${i}`, clicked, true);
  await sleep(500);
  const pn = await snapshot();
  const onPage = Math.min(PER_PAGE, total - (i - 1) * PER_PAGE);
  const from = (i - 1) * PER_PAGE + 1;
  const to = from + onPage - 1;
  check(`page ${i} card count`, pn.cardCount, onPage);
  check(`page ${i} count text`, pn.countText, showingText(from, to, total));
  check(`page ${i} active page`, pn.activePage, String(i));
  check(`page ${i} Next disabled (last page)`, pn.nextDisabled, i === pages);
  check(`page ${i} Prev enabled`, pn.prevDisabled, false);
  seen.push(...pn.slugs.filter(Boolean));
}

// Next must not advance past the end
const pastEnd = await evaluate(`(() => {
  const b = [...document.querySelectorAll('.pager__btn')].find((x) => /Next/i.test(x.textContent));
  if (!b) return 'missing';
  return b.disabled ? 'disabled' : 'enabled';
})()`);
check('Next is disabled on the last page', pastEnd, 'disabled');

// Prev walks back
const back = await clickPrev();
check('Prev click works', back, true);
await sleep(500);
const pBack = await snapshot();
check('Prev goes back one page', pBack.activePage, String(pages - 1));

// Every package exactly once
check('no duplicate package across pages', seen.length, new Set(seen).size);
check('every package reachable exactly once', seen.length, total);

check('no uncaught JavaScript errors', jsErrors, []);

// ── Report ────────────────────────────────────────────────────────────────
cleanup();
ws.close();

console.log('');
if (failures.length) {
  console.log(`RESULT: FAIL — ${failures.length} check(s): ${failures.join(' | ')}`);
  process.exit(1);
}
console.log(`RESULT: PASS — ${total} packages over ${pages} pages, ${PER_PAGE} per page, no JS errors`);
process.exit(0);

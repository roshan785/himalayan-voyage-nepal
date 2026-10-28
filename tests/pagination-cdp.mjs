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

// ── Keyboard focus retention ──────────────────────────────────────────────
// renderPager() rebuilds pager.innerHTML on every page change, so the button
// the user just activated is destroyed. If focus is not restored,
// document.activeElement falls back to <body> and a keyboard user is stranded:
// they cannot press Enter again to reach the next page. Focus must survive the
// re-render and land on a LIVE (non-disabled) control inside the pager.
async function focusAndClick(role) {
  return evaluate(`(() => {
    const btns = () => [...document.querySelectorAll('#package-pager .pager__btn')];
    const target = btns().find((b) => /${role}/i.test(b.textContent));
    if (!target) return Promise.resolve({ missing: true });
    target.focus();
    const hadFocus = document.activeElement === target;
    target.click();
    return new Promise((resolve) => setTimeout(() => {
      const active = document.activeElement;
      resolve({
        hadFocus,
        // Where focus ended up. A dead body/null means the user lost their place.
        activeInPager: !!(active && active.closest && active.closest('#package-pager')),
        activeLabel: active ? (active.textContent || '').trim() : null,
        activeDisabled: !!(active && active.disabled),
      });
    }, 450));
  })()`);
}

const focusNext = await focusAndClick('Next');
check('Next button is focusable before click', focusNext.hadFocus, true);
check('focus stays inside the pager after clicking Next', focusNext.activeInPager, true);
check('focus never lands on a disabled control', focusNext.activeDisabled, false);

const focusPrev = await focusAndClick('Prev');
check('Prev button is focusable before click', focusPrev.hadFocus, true);
check('focus stays inside the pager after clicking Prev', focusPrev.activeInPager, true);
check('focus never lands on a disabled control (Prev)', focusPrev.activeDisabled, false);

// ── Keyboard walk: focus must follow the ROLE of the activated control ────
// Restoring focus to the page button is not enough. If a keyboard user lands
// on "Next", presses Enter, and focus jumps to the page-number button, the
// second Enter re-activates the same page and does nothing — they can advance
// exactly one page and then must Tab again. Focus must stay on Next so Enter
// keeps walking forward (and on Prev going back).
async function roleWalk(role, times) {
  return evaluate(`(async () => {
    const find = () => [...document.querySelectorAll('#package-pager .pager__btn')]
      .find((b) => /${role}/i.test(b.textContent));
    const steps = [];
    for (let i = 0; i < ${times}; i += 1) {
      const b = find();
      if (!b) { steps.push({ missing: true }); break; }
      if (b.disabled) { steps.push({ disabled: true, page: currentPage() }); break; }
      b.focus();
      const active = document.querySelector('#package-pager .pager__btn.is-active');
      const before = active ? active.textContent.trim() : null;
      b.click();
      await new Promise((r) => setTimeout(r, 400));
      const a = document.activeElement;
      // After the click, is the activated role still usable? On the last page
      // "Next" (and on page 1 "Prev") becomes legitimately disabled, so focus
      // MUST fall through to another live control instead of staying there.
      const roleAfter = find();
      steps.push({
        before,
        afterPage: currentPage(),
        roleStillEnabled: !!(roleAfter && !roleAfter.disabled),
        // The whole point: still on a /${role}/i control, so Enter works again.
        // NOTE: when focus falls back to <body>, body.textContent contains the
        // pager text ("Next →"), so a bare /role/ test would false-pass. The
        // assertions therefore also require inPager and activeTag === 'BUTTON'.
        onRole: !!(a && /${role}/i.test(a.textContent || '')),
        // <body> has no .disabled (undefined), so a bare !a.disabled would pass
        // vacuously. Require a real BUTTON that is genuinely enabled.
        onNonDisabled: !!(a && a.tagName === 'BUTTON' && !a.disabled),
        inPager: !!(a && a.closest && a.closest('#package-pager')),
        activeTag: a ? a.tagName : null,
        activeDisabled: a ? a.disabled === true : null,
      });
    }
    function currentPage() {
      const el = document.querySelector('#package-pager .pager__btn.is-active');
      return el ? el.textContent.trim() : null;
    }
    return steps;
  })()`);
}

// Walk from page 1 to the end and back, keyboard-style.
await evaluate(`(() => {
  const first = [...document.querySelectorAll('#package-pager .pager__btn')].find((b) => b.textContent.trim() === '1');
  if (first && !first.disabled) first.click();
  return true;
})()`);
await sleep(400);

const forward = await roleWalk('Next', pages - 1);
forward.forEach((s, i) => {
  check(`keyboard step ${i + 1}: Enter on Next advances a page`, s.afterPage, String(Math.min(i + 2, pages)));
  // Contract: focus must be on a REAL enabled BUTTON inside the pager. It sits
  // on the activated role while that role is still enabled; when the role
  // legitimately becomes disabled (last page / first page) it must fall
  // through to another live control — never to <body>.
  check(`keyboard step ${i + 1}: focus stays on an enabled pager control`,
    { inPager: s.inPager, tag: s.activeTag, enabled: s.activeDisabled === false },
    { inPager: true, tag: 'BUTTON', enabled: true });
  check(`keyboard step ${i + 1}: focus stays on the Next role while it is usable`,
    !s.roleStillEnabled || s.onRole, true);
});

const backward = await roleWalk('Prev', pages - 1);
backward.forEach((s, i) => {
  check(`keyboard back ${i + 1}: Enter on Prev goes back a page`, s.afterPage, String(Math.max(pages - i - 1, 1)));
  check(`keyboard back ${i + 1}: focus stays on an enabled pager control`,
    { inPager: s.inPager, tag: s.activeTag, enabled: s.activeDisabled === false },
    { inPager: true, tag: 'BUTTON', enabled: true });
  check(`keyboard back ${i + 1}: focus stays on the Prev role while it is usable`,
    !s.roleStillEnabled || s.onRole, true);
});

// ── Rapid double-tap (mobile user tapping Next twice quickly) ─────────────
// Each tap is a real page advance, so a fast double-tap must land exactly two
// pages further (clamped to the last page) — never on a half-rendered grid,
// never past the end, and never with a duplicated or short page.
await evaluate(`(() => { const f = [...document.querySelectorAll('#package-pager .pager__btn')].find((b) => b.textContent.trim() === '1'); if (f) f.click(); })()`);
await sleep(600);
const tapSeen = [];
for (let i = 0; i < pages; i += 1) {
  const from = await snapshot();
  tapSeen.push(...from.slugs.filter(Boolean));
  if (from.nextDisabled) break;
  // Two clicks 80ms apart, the second issued before the re-render settles.
  await evaluate(`(() => {
    const q = () => [...document.querySelectorAll('#package-pager .pager__btn')].find((b) => /Next/i.test(b.textContent));
    const a = q();
    if (a && !a.disabled) a.click();
    setTimeout(() => { const b = q(); if (b && !b.disabled) b.click(); }, 80);
  })()`);
  await sleep(700);
  const to = await snapshot();
  const expected = Math.min(Number(from.activePage) + 2, pages);
  check(`double-tap from page ${from.activePage} lands on page ${expected}`, to.activePage, String(expected));
  check(`double-tap landing page has ${PER_PAGE} cards`, to.cardCount, PER_PAGE);
  const startN = (expected - 1) * PER_PAGE + 1;
  const toN = Math.min(expected * PER_PAGE, Number(total));
  check(`double-tap count text is correct`, to.countText, `Showing ${startN}\u2013${toN} of ${total} packages`);
}
check('rapid double-tap never repeats a package', tapSeen.length, new Set(tapSeen).size);

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

/**
 * Pagination regression test for packages.html.
 * Asserts 3 cards per page, correct "Showing X–Y of Z" text, correct pager
 * state, and that every package is reachable across the pages (no drop, no
 * duplicate). Exits non-zero on any failure.
 * Usage: node tests/pagination.test.mjs [url]
 */
// puppeteer-core is an OPTIONAL test-only dependency: this repo does not ship a
// headless browser, so the suite skips cleanly instead of failing CI when it is
// not installed. Install it locally with `npm i -D puppeteer-core` to run.
let puppeteer;
try {
  puppeteer = (await import('puppeteer-core')).default;
} catch {
  console.log('SKIP: puppeteer-core is not installed (npm i -D puppeteer-core to enable this test)');
  process.exit(0);
}

const URL_ARG = process.argv[2] || 'http://127.0.0.1:4611/packages.html';
const CHROME = '/usr/bin/google-chrome';
const PER_PAGE = 3;

const failures = [];
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!ok) failures.push(label);
};

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function snapshot(page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('#package-grid .card')];
    return {
      cardCount: cards.length,
      slugs: cards.map((c) => {
        const a = c.querySelector('a.btn--primary');
        return a ? decodeURIComponent(a.getAttribute('href').split('slug=')[1] || '') : '';
      }),
      countText: ((document.getElementById('package-count') || {}).textContent || '').trim(),
      pagerHidden: (() => {
        const p = document.getElementById('package-pager');
        return p ? p.hidden : null;
      })(),
      pagerButtons: [...document.querySelectorAll('.pager__btn')].map((b) => b.textContent.trim()),
      activePage: (() => {
        const a = document.querySelector('.pager__btn.is-active');
        return a ? a.textContent.trim() : null;
      })(),
      prevDisabled: (() => {
        const b = [...document.querySelectorAll('.pager__btn')].find((x) => /Prev/i.test(x.textContent));
        return b ? b.disabled : null;
      })(),
      nextDisabled: (() => {
        const b = [...document.querySelectorAll('.pager__btn')].find((x) => /Next/i.test(x.textContent));
        return b ? b.disabled : null;
      })(),
      firstCardRowTop: (() => {
        const cards = [...document.querySelectorAll('#package-grid .card')];
        const tops = [...new Set(cards.map((c) => Math.round(c.getBoundingClientRect().top)))];
        return tops.length;
      })(),
    };
  });
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 950 });

const jsErrors = [];
page.on('pageerror', (e) => jsErrors.push('pageerror: ' + e.message));

await page.goto(URL_ARG, { waitUntil: 'networkidle2', timeout: 90000 });
await page.waitForFunction(() => document.querySelectorAll('#package-grid .card').length > 0, { timeout: 45000 });

const total = await page.evaluate(async () => {
  const r = await fetch('/api/packages');
  const d = await r.json();
  return (d.items || d).length;
});
console.log(`total packages from API = ${total}, expected pages = ${Math.ceil(total / PER_PAGE)}`);

const pages = Math.ceil(total / PER_PAGE);
const seen = [];

// ── Page 1 ────────────────────────────────────────────────────────────────
const p1 = await snapshot(page);
check('page 1 card count', p1.cardCount, PER_PAGE);
check('page 1 count text', p1.countText, `Showing 1\u20133 of ${total} packages`);
check('page 1 active page', p1.activePage, '1');
check('page 1 Prev disabled', p1.prevDisabled, true);
check('page 1 Next disabled', p1.nextDisabled, pages === 1);
check('page 1 pager visible', p1.pagerHidden, false);
check('page 1 cards on a single row (no orphan row)', p1.firstCardRowTop, 1);
check('page 1 pager button count', p1.pagerButtons.length, pages + 2);
seen.push(...p1.slugs);

// ── Walk forward with the real Next button ────────────────────────────────
for (let i = 2; i <= pages; i += 1) {
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.pager__btn')].find((x) => /Next/i.test(x.textContent));
    if (!b || b.disabled) return false;
    b.click();
    return true;
  });
  check(`Next click #${i - 1} succeeded`, clicked, true);
  await sleep(600);
  const pn = await snapshot(page);
  const expectedOnPage = Math.min(PER_PAGE, total - (i - 1) * PER_PAGE);
  const from = (i - 1) * PER_PAGE + 1;
  const to = (i - 1) * PER_PAGE + expectedOnPage;
  check(`page ${i} card count`, pn.cardCount, expectedOnPage);
  check(`page ${i} count text`, pn.countText, `Showing ${from}\u2013${to} of ${total} packages`);
  check(`page ${i} active page`, pn.activePage, String(i));
  check(`page ${i} Next disabled`, pn.nextDisabled, i === pages);
  check(`page ${i} cards on a single row (no orphan row)`, pn.firstCardRowTop, 1);
  seen.push(...pn.slugs);
}

// ── Next must not advance past the last page ──────────────────────────────
const pastEnd = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.pager__btn')].find((x) => /Next/i.test(x.textContent));
  if (!b) return 'missing';
  if (b.disabled) return 'disabled';
  b.click();
  return 'clicked';
});
check('Next is disabled on the last page', pastEnd, 'disabled');

// ── Prev walks back ───────────────────────────────────────────────────────
const prevClicked = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.pager__btn')].find((x) => /Prev/i.test(x.textContent));
  if (!b || b.disabled) return false;
  b.click();
  return true;
});
check('Prev click succeeded', prevClicked, true);
await sleep(600);
const pBack = await snapshot(page);
check('Prev returns to previous page', pBack.activePage, String(pages - 1));

// ── Every package reachable exactly once ──────────────────────────────────
check('no duplicate packages across pages', seen.length, new Set(seen).size);
check('every package reachable exactly once', seen.length, total);

check('no JavaScript errors on the page', jsErrors, []);

await browser.close();

if (failures.length) {
  console.log(`\nRESULT: ${failures.length} FAILED -> ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`\nRESULT: all checks passed (${total} packages over ${pages} pages, ${PER_PAGE} per page)`);

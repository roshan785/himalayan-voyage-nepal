# DEBUG_LOG

## 2026-10-28 — packages.html: pagination shows 4 per page on a 3-column grid

### (a) What was the bug?
`packages.html` splits the package listing into pages, but page 1 rendered **4**
cards on a grid that only holds 3 columns, so the fourth card dropped onto a
second row as an orphan. With 9 packages the split was `4 / 4 / 1`: the last page
held a **single lonely card**, and the counter read "Showing 1–4 of 9",
"Showing 5–8 of 9", "Showing 9–9 of 9". Customer complaint: pagination looks broken.

Measured on the deployed code before the fix (headless Chrome, 1280×950):

```
PAGE 1  cardCount=4  rows=2  count="Showing 1–4 of 9 packages"
PAGE 2  cardCount=4  rows=2  count="Showing 5–8 of 9 packages"
PAGE 3  cardCount=1  rows=1  count="Showing 9–9 of 9 packages"
```

### (b) Why did it happen?
`public/js/packages.js` hard-coded `const PER_PAGE = 4;` with a comment claiming
4 "keeps the 3-column grid on one clean row + a single card on the second row".
That comment was simply wrong: the listing grid in `public/packages.html` is
`.grid.grid--3` (`grid-template-columns: repeat(3, 1fr)` in `public/css/style.css`).
Page size and column count were two independent magic numbers that had to agree
and did not. Nothing in the code derived one from the other, and no test covered
it, so the mismatch shipped silently.

This was NOT a `renderPage()` / `goToPage()` logic bug — slicing, clamping,
pager rendering, Prev/Next disable states and the count text all already worked
correctly for whatever `PER_PAGE` said. The single value was wrong.

### (c) How was it fixed?
Smallest possible change — one constant, plus a comment stating the invariant:

```js
// public/js/packages.js
const PER_PAGE = 3;   // was 4
```

Plus a cache-bust in `public/packages.html`:

```html
<script src="js/packages.js?v=pg2a"></script>   <!-- was v=pg1a -->
```

The cache bump is part of the fix, not cosmetics: the deployed static assets are
served with `cache-control: public, max-age=31536000, immutable`, so returning
visitors would keep running the old cached `packages.js` forever without it.

No other logic, markup, CSS, API or feature was touched. Filter tabs, search,
sort, the `?slug=` detail view, the booking form and the pager component are
byte-identical.

### (d) How to stop it happening again?
- `tests/pagination.test.mjs` (new) drives the real page in headless Chrome:
  asserts exactly 3 cards per page, one visual row per page (no orphan),
  correct "Showing X–Y of Z" text, correct active page, Prev disabled on page 1,
  Next disabled on the last page, Next never advancing past the end, Prev
  walking back, and that all 9 packages are reachable **exactly once** with no
  duplicates. It skips cleanly (exit 0) when `puppeteer-core` is absent.
- Rule: page size must be derived from, or asserted against, the grid's column
  count — never a second independent magic number.
- Rule: any change to a file served `immutable` must bump its `?v=` in the HTML
  that loads it, or the fix never reaches returning visitors.

### Evidence
- RED (bug restored, `PER_PAGE = 4`): `RESULT: 8 FAILED` — page 1 card count,
  count text, orphan row, page 2 card count, count text, orphan row, page 3 card
  count, count text.
- GREEN (`PER_PAGE = 3`): `RESULT: all checks passed (9 packages over 3 pages,
  3 per page)` — 26/26 checks.
- `npm test` full suite: **100 passed, 0 failed** (no regression).
- Feature regression sweep on the same page — all unchanged and error-free:
  ```
  ALL      : 3 cards, "Showing 1–3 of 9 packages", page 1, pager visible
  trekking : 2 cards, "Showing 1–2 of 2 packages", pager hidden
  search   : 1 card,  "Showing 1–1 of 1 package",  pager hidden
  reset    : 3 cards, "Showing 1–3 of 9 packages", page 1
  sort     : 3 cards, "Showing 1–3 of 9 packages", page 1
  JS ERRORS: none
  ```
- Backup of the edited file: `public/js/packages.js.bak_pagination_<epoch>`
- Commands: `npm ci` → `PORT=4611 node server.js` →
  `node tests/pagination.test.mjs http://127.0.0.1:4611/packages.html` → `npm test`

/**
 * mobile-probe.js — PAGE-SIDE audit probe (runs inside headless Chrome).
 *
 * This file is intentionally a standalone browser script: it is injected into
 * the page via CDP `Runtime.evaluate`. Keeping it separate means the Node
 * driver (scripts/mobile-check.js) contains no DOM identifiers, so static
 * analysis classifies each file correctly instead of guessing.
 *
 * MEASUREMENT NOTES (both were bugs in an earlier version of this probe):
 *  - Use documentElement.clientWidth as the layout viewport. window.innerWidth
 *    EXPANDS to match overflowing content in Chrome mobile emulation, so
 *    comparing scrollWidth to innerWidth hides the very bug we look for.
 *  - getBoundingClientRect() returns geometry even when an ancestor clips it
 *    (e.g. the marquee strip). Elements with a clipping ancestor are NOT
 *    overflow offenders, so they are excluded.
 *  - Off-canvas UI (the parked nav drawer) sits outside the visible area; it
 *    must not be counted as a "tiny tap target".
 *
 * Relies only on browser globals and returns a plain object.
 */
(function () {
  'use strict';

  // Guard: this file is a BROWSER probe, but static tools and the self-heal
  // layer may execute it under Node. Bail out cleanly there instead of throwing
  // "window is not defined". In the browser this branch is never taken.
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return {};
  }

  var docEl = document.documentElement;
  var vw = docEl.clientWidth;
  var vh = docEl.clientHeight;

  // Can the user actually pan sideways? This is the definitive check — a
  // clipped-but-wide layout would report a large scrollWidth yet not scroll.
  var startX = window.scrollX;
  window.scrollTo(99999, startX ? window.scrollY : 0);
  var canScrollX = window.scrollX > startX + 1;
  window.scrollTo(startX, window.scrollY);

  function label(el) {
    return (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 45);
  }

  function classOf(el) {
    return (el.className && typeof el.className === 'string' ? el.className : '').slice(0, 70);
  }

  // An ancestor that clips or scrolls means the element cannot cause page-level
  // horizontal overflow. Walk up to (but not including) <html>: the root's own
  // overflow is what we are measuring.
  function hasClippingAncestor(el) {
    var p = el.parentElement;
    while (p && p !== docEl) {
      var s = getComputedStyle(p);
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible') return true;
      p = p.parentElement;
    }
    return false;
  }

  // Elements parked outside the visible viewport (off-canvas drawer) are not
  // real tap-target / readability problems.
  function inViewport(rect) {
    return rect.right > 1 && rect.left < vw - 1 && rect.bottom > 1 && rect.top < vh - 1;
  }

  // --- 1. Elements sticking out past the right edge ---
  var offenders = [];
  var all = document.querySelectorAll('body *');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    var style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    if (hasClippingAncestor(el)) continue;
    var overflowRight = Math.round(rect.right - vw);
    if (overflowRight > 2) {
      offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: classOf(el),
        right: Math.round(rect.right),
        over: overflowRight,
        pos: style.position,
        text: label(el)
      });
    }
  }
  offenders.sort(function (a, b) { return b.over - a.over; });

  // Keep only the worst instance of each kind so the report stays readable.
  var seen = {};
  var uniqueOffenders = [];
  for (var j = 0; j < offenders.length; j++) {
    var key = offenders[j].tag + '|' + offenders[j].cls;
    if (!Object.prototype.hasOwnProperty.call(seen, key)) {
      seen[key] = true;
      uniqueOffenders.push(offenders[j]);
    }
  }

  // --- 2. Tap targets too small to hit with a thumb (< 36px tall) ---
  var tinyTargets = [];
  var clickable = document.querySelectorAll('a, button, input:not([type=hidden]), select, [role=button]');
  for (var k = 0; k < clickable.length; k++) {
    var c = clickable[k];
    var cr = c.getBoundingClientRect();
    if (cr.width === 0 || cr.height === 0) continue;
    var cs = getComputedStyle(c);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (!inViewport(cr)) continue;
    if (cr.height < 36 || cr.width < 22) {
      tinyTargets.push({
        tag: c.tagName.toLowerCase(),
        text: (c.textContent || c.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 30),
        w: Math.round(cr.width),
        h: Math.round(cr.height)
      });
    }
  }

  // --- 3. Text smaller than 12px is hard to read on a phone ---
  var tinyText = 0;
  var tinyTextSample = '';
  var textEls = document.querySelectorAll('p, li, span, a, td, th, small, div');
  for (var t = 0; t < textEls.length; t++) {
    var te = textEls[t];
    if (!te.textContent || !te.textContent.trim()) continue;
    if (te.children.length > 0 && te.textContent.trim().length > 60) continue;
    var tr = te.getBoundingClientRect();
    if (!inViewport(tr)) continue;
    var fs = parseFloat(getComputedStyle(te).fontSize);
    if (fs && fs < 12) {
      tinyText++;
      if (!tinyTextSample) tinyTextSample = te.textContent.trim().slice(0, 35) + ' @' + fs + 'px';
    }
  }

  // --- 4. Is the mobile navigation present and openable? ---
  var nav = document.querySelector('.nav');
  var toggle = document.querySelector('.nav-toggle');
  var navOpenable = !!(nav && toggle);

  // Actually toggle the drawer and confirm it slides INTO the viewport, then
  // restore it. This proves the overflow containment did not break the menu —
  // a page can have zero overflow and still ship a dead hamburger.
  // Transitions are disabled while measuring so getBoundingClientRect() reports
  // the drawer's END position instead of a mid-animation frame.
  var navOpens = null;
  if (navOpenable) {
    var wasOpen = nav.classList.contains('is-open');
    var prevTransition = nav.style.transition;
    nav.style.transition = 'none';
    if (!wasOpen) toggle.click();
    var openRect = nav.getBoundingClientRect();
    navOpens = {
      opened: nav.classList.contains('is-open'),
      withinViewport: openRect.left >= -1 && openRect.right <= vw + 1,
      right: Math.round(openRect.right)
    };
    if (!wasOpen) toggle.click(); // restore the original closed state
    nav.style.transition = prevTransition;
    void nav.offsetHeight;
  }

  // --- 5. Images that fail to fit their own box ---
  var overflowingImgs = [];
  var imgs = document.querySelectorAll('img');
  for (var m = 0; m < imgs.length; m++) {
    var img = imgs[m];
    if (img.naturalWidth && img.scrollWidth > img.clientWidth + 2) {
      overflowingImgs.push({
        src: (img.getAttribute('src') || '').slice(-40),
        sw: img.scrollWidth,
        cw: img.clientWidth
      });
    }
  }

  return {
    vw: vw,
    innerWidth: window.innerWidth,
    docW: docEl.scrollWidth,
    bodyW: document.body ? document.body.scrollWidth : 0,
    overflowPx: Math.max(0, docEl.scrollWidth - vw),
    canScrollX: canScrollX,
    // Diagnostics: confirms the media query + containment actually applied, so a
    // "still overflowing" report can be trusted instead of guessed at.
    htmlOverflowX: getComputedStyle(docEl).overflowX,
    bodyOverflowX: document.body ? getComputedStyle(document.body).overflowX : null,
    mqMobile: window.matchMedia('(max-width: 980px)').matches,
    offenders: uniqueOffenders.slice(0, 8),
    offenderCount: offenders.length,
    tinyTargets: tinyTargets.slice(0, 8),
    tinyTargetCount: tinyTargets.length,
    tinyText: tinyText,
    tinyTextSample: tinyTextSample,
    navOpenable: navOpenable,
    navOpens: navOpens,
    hasToggleVisible: !!(toggle && getComputedStyle(toggle).display !== 'none'),
    overflowingImgs: overflowingImgs.slice(0, 5),
    docHeight: docEl.scrollHeight,
    title: document.title
  };
})();

'use strict';

/**
 * Adds a content-based cache-busting query string to every local asset
 * reference (css/style.css, js/*.js) in public/*.html.
 *
 * Why: without a version, a browser serves a stale cached stylesheet after a
 * deploy and the page looks broken/unstyled until the user hard-refreshes.
 * The version is derived from the file's SHA-256, so it changes automatically
 * whenever the file changes — but stays stable when it does not.
 *
 *   node scripts/bust-cache.js
 *
 * Idempotent: re-running replaces the existing ?v=... on each asset.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');

const PUBLIC = path.join(__dirname, '..', 'public');

/** Short content hash of a file, or null if it does not exist. */
function versionOf(relPath) {
  const abs = path.join(PUBLIC, relPath);
  if (!fs.existsSync(abs)) return null;
  const hash = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  return hash.slice(0, 8);
}

function main() {
  const htmlFiles = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));
  const cache = new Map(); // relPath -> version (avoid re-hashing)
  let filesChanged = 0;
  let refsUpdated = 0;

  const version = (rel) => {
    if (!cache.has(rel)) cache.set(rel, versionOf(rel));
    return cache.get(rel);
  };

  for (const file of htmlFiles) {
    const abs = path.join(PUBLIC, file);
    const before = fs.readFileSync(abs, 'utf8');
    let html = before;
    let updatedInFile = 0;

    // css/style.css  and  js/*.js
    html = html.replace(/(href|src)="((?:css|js)\/[^"?]+\.(?:css|js))(\?v=[^"]*)?"/g, (match, attr, rel) => {
      const v = version(rel);
      if (!v) return match; // leave unknown references untouched
      updatedInFile++;
      return `${attr}="${rel}?v=${v}"`;
    });

    if (html !== before) {
      fs.writeFileSync(abs, html);
      filesChanged++;
      refsUpdated += updatedInFile;
    }
  }

  console.log(`Cache-busting: ${refsUpdated} asset references updated across ${filesChanged} HTML files.`);
  console.log('  style.css -> v' + version('css/style.css'));
}

main();

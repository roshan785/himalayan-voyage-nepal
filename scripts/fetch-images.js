'use strict';

/**
 * Downloads freely-licensed destination photos from Wikimedia Commons and
 * records their attribution.
 *
 * Why Wikimedia Commons: every file there carries an explicit licence
 * (CC BY / CC BY-SA / Public Domain) and an author. We keep a credits.json next
 * to the images and render the attribution on the site, which is what the
 * licences require. Nothing is copied without credit.
 *
 *   node scripts/fetch-images.js
 *
 * Safe to re-run: already-downloaded files are skipped unless --force is given.
 */

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'public', 'images');
const CREDITS_FILE = path.join(OUT_DIR, 'credits.json');
const FORCE = process.argv.includes('--force');
const API = 'https://commons.wikimedia.org/w/api.php';

// slug -> search query. The slug is also the output filename.
const TARGETS = [
  // Destinations
  ['pokhara', 'Phewa Lake Pokhara Nepal'],
  ['rara-lake', 'Rara Lake Nepal'],
  ['mustang', 'Upper Mustang Nepal landscape'],
  ['ghandruk', 'Ghandruk village Annapurna Nepal'],
  ['chitwan', 'Chitwan National Park rhinoceros'],
  ['dhorpatan', 'Dhorpatan Nepal valley'],
  ['london', 'London Tower Bridge cityscape'],
  ['tokyo', 'Tokyo skyline Japan'],
  ['bangkok', 'Bangkok temple Thailand'],
  ['paris', 'Paris Eiffel Tower'],
  ['barcelona', 'Barcelona Sagrada Familia Spain'],
  ['rome', 'Rome Colosseum Italy'],
  // Package covers
  ['annapurna-base-camp', 'Annapurna Base Camp trek Nepal'],
  ['kathmandu-heritage', 'Boudhanath stupa Kathmandu Nepal'],
  ['muktinath-yatra', 'Muktinath temple Nepal'],
  ['thailand-holiday', 'Grand Palace Bangkok Thailand'],
  ['london-heritage', 'Stonehenge England'],
  ['bali-escape', 'Bali rice terrace Indonesia'],
  // Hero / misc
  ['hero-himalaya', 'Himalaya mountains Nepal panorama'],
  ['everest', 'Mount Everest Nepal'],
  ['kathmandu-durbar', 'Kathmandu Durbar Square Nepal'],
  ['phewa-sunset', 'Phewa Lake sunset Nepal'],
  // Additional gallery images
  ['boudhanath', 'Boudhanath stupa Kathmandu'],
  ['pashupatinath', 'Pashupatinath temple Kathmandu'],
  ['patan-durbar', 'Patan Durbar Square Nepal'],
  ['bhaktapur', 'Bhaktapur Durbar Square Nepal'],
  ['sarangkot', 'Sarangkot sunrise Pokhara'],
  ['paragliding', 'Paragliding Pokhara Nepal'],
  ['annapurna-panorama', 'Annapurna mountain range panorama'],
  ['langtang', 'Langtang valley Nepal mountains'],
  ['sagarmatha', 'Sagarmatha national park Nepal'],
  ['lumbini', 'Lumbini Nepal temple'],
  ['nagarkot', 'Nagarkot viewpoint Nepal'],
  ['bandipur', 'Bandipur Nepal old town'],
  ['ilam', 'Ilam tea garden Nepal'],
  ['pokhara-lakeside', 'Phewa lake Pokhara boats'],
  ['yak', 'Yak Nepal mountains'],
  ['prayer-flags', 'Prayer flags Nepal mountains'],
  ['nepal-flag', 'Flag of Nepal'],
  ['dubai', 'Dubai skyline UAE'],
  ['singapore', 'Singapore marina skyline'],
  ['kualalumpur', 'Kuala Lumpur Petronas towers'],
  ['sydney', 'Sydney Opera House Australia'],
  ['newyork', 'New York City skyline'],
  ['switzerland', 'Switzerland alps village'],
  ['himalayan-trek', 'Trekkers Himalaya Nepal trail'],
  ['cultural-dance', 'Nepal cultural dance traditional'],
  ['momo-food', 'Nepali food momo dumplings'],
  ['everest-base-camp', 'Everest Base Camp trek'],
  // Visa destination images
  ['canada', 'Toronto skyline Canada'],
  ['china', 'Beijing Great Wall China'],
  ['turkey', 'Istanbul mosque Turkey'],
  ['hongkong', 'Hong Kong skyline Victoria Harbour']
];

function stripHtml(text) {
  return String(text || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET with a couple of retries and a back-off — Commons rate-limits (429). */
async function getJson(url, tries = 4) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'HimalayanVoyage/1.0 (demo site builder)' } });
      if (res.status === 429 || res.status === 503) {
        throw new Error('HTTP ' + res.status);
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await sleep(1500 * (i + 1));
    }
  }
  throw lastErr;
}

async function search(query) {
  const url = `${API}?action=query&generator=search` +
    `&gsrsearch=${encodeURIComponent(query)}` +
    '&gsrnamespace=6&gsrlimit=8&prop=imageinfo' +
    '&iiprop=url|extmetadata|size&iiurlwidth=1200&format=json&origin=*';
  const json = await getJson(url);
  const pages = json.query && json.query.pages ? Object.values(json.query.pages) : [];
  return pages.map((p) => {
    const ii = p.imageinfo && p.imageinfo[0];
    if (!ii) return null;
    const meta = ii.extmetadata || {};
    return {
      title: p.title,
      thumb: ii.thumburl || ii.url,
      source: ii.descriptionurl || ('https://commons.wikimedia.org/wiki/' + encodeURIComponent(p.title)),
      license: stripHtml(meta.LicenseShortName && meta.LicenseShortName.value) || 'See source',
      artist: stripHtml(meta.Artist && meta.Artist.value) || 'Unknown',
      width: ii.width,
      height: ii.height
    };
  }).filter(Boolean);
}

/**
 * Sniff the real image format from the file signature. Wikimedia serves some
 * thumbnails (SVG sources, flags) as PNG, so a `.jpg` fixed extension would be
 * wrong. Returns 'jpg', 'png', 'gif' or 'webp'.
 */
function sniffType(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.length > 3 && buf.slice(0, 3).toString('ascii') === 'GIF') return 'gif';
  if (buf.length > 12 && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return 'jpg';
}

async function download(url, destBase) {
  const res = await fetch(url, { headers: { 'User-Agent': 'HimalayanVoyage/1.0 (demo site builder)' } });
  if (!res.ok) throw new Error('download HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new Error('too small (' + buf.length + ' bytes) — not an image');
  // Save with the extension that matches the real bytes.
  const ext = sniffType(buf);
  const dest = destBase.replace(/\.(jpg|png|gif|webp)$/i, '.' + ext);
  fs.writeFileSync(dest, buf);
  return { bytes: buf.length, ext };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const credits = fs.existsSync(CREDITS_FILE)
    ? JSON.parse(fs.readFileSync(CREDITS_FILE, 'utf8'))
    : {};

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  /** A slug counts as present if ANY image extension exists for it. */
  function existingFile(slug) {
    for (const ext of ['jpg', 'png', 'webp', 'gif']) {
      const p = path.join(OUT_DIR, slug + '.' + ext);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  for (const [slug, query] of TARGETS) {
    const dest = path.join(OUT_DIR, slug + '.jpg');
    const found = existingFile(slug);
    const hasFile = !!found;
    const hasCredit = !!credits[slug] && !!credits[slug].file && fs.existsSync(path.join(OUT_DIR, '..', credits[slug].file));

    // Already downloaded AND credited AND the credited file exists → done.
    if (hasFile && hasCredit && !FORCE) {
      console.log('• skip  ' + slug + ' (present + credited)');
      skipped++;
      continue;
    }

    try {
      // Fetch metadata whenever we need to download, or to backfill a missing credit.
      const results = await search(query);
      if (!results.length) {
        console.log('✗ none  ' + slug + ' — no results for "' + query + '"');
        failed++;
        continue;
      }
      // Prefer a large landscape image if one is available.
      const land = results.find((r) => r.width && r.height && r.width >= r.height);
      const pick = land || results[0];

      if (hasFile && !FORCE) {
        // Backfill the credit using the file that is actually on disk.
        const rel = path.relative(path.join(OUT_DIR, '..'), found).split(path.sep).join('/');
        credits[slug] = {
          query, file: rel, title: pick.title,
          artist: pick.artist, license: pick.license, source: pick.source
        };
        console.log('• cred  ' + slug + ' — credit backfilled (' + pick.license + ')');
        skipped++;
      } else {
        const out = await download(pick.thumb, dest);
        const rel = path.relative(path.join(OUT_DIR, '..'), dest.replace(/\.jpg$/, '.' + out.ext)).split(path.sep).join('/');
        credits[slug] = {
          query, file: rel, title: pick.title,
          artist: pick.artist, license: pick.license, source: pick.source
        };
        console.log('✓ got   ' + slug + ' — ' + pick.title + ' [' + pick.license + '] ' +
          Math.round(out.bytes / 1024) + 'KB (' + out.ext + ')');
        downloaded++;
      }
      await sleep(900); // be polite to the API between lookups
    } catch (err) {
      console.log('✗ fail  ' + slug + ' — ' + err.message);
      failed++;
    }
  }

  fs.writeFileSync(CREDITS_FILE, JSON.stringify(credits, null, 2));
  console.log(`\n${downloaded} downloaded, ${skipped} skipped, ${failed} failed.`);

  // Report (and count) any credited entry whose file is missing on disk.
  let verified = 0;
  const broken = [];
  for (const [slug, c] of Object.entries(credits)) {
    if (c.file && fs.existsSync(path.join(OUT_DIR, '..', c.file))) verified++;
    else broken.push(slug);
  }
  console.log(`Credits: ${Object.keys(credits).length} total, ${verified} verified on disk` +
    (broken.length ? `, ${broken.length} broken: ${broken.join(', ')}` : ''));
  console.log('Written to ' + path.relative(path.join(__dirname, '..'), CREDITS_FILE));
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});

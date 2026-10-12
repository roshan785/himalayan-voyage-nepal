#!/usr/bin/env node
/**
 * mobile-check.js — REAL mobile-render audit for Himalayan Voyage Nepal.
 *
 * WHY: `curl` returns 200 even when nothing renders. A desktop headless render
 * passes even when the page overflows horizontally on a phone. This script talks
 * to headless Chrome over CDP, emulates real phone viewports, and measures:
 *   - horizontal overflow (document.scrollWidth > innerWidth)  → "not full size"
 *   - elements wider than the viewport (the actual culprits)
 *   - tiny tap targets (< 40px) on links/buttons
 *   - text too small to read (< 12px)
 *   - whether the mobile nav toggle exists and opens the drawer
 *
 * Usage:
 *   node scripts/mobile-check.js [baseUrl] [--shot]
 *   node scripts/mobile-check.js http://127.0.0.1:3400 --shot
 */

'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WS_MODULE = require.resolve('ws');

const BASE = (process.argv.find((a) => a.startsWith('http')) || 'http://127.0.0.1:3400').replace(/\/+$/, '');
const WANT_SHOT = process.argv.includes('--shot');
// Do NOT hardcode the debug port: a previous crashed run can leave a headless
// Chrome bound to it, and this script would then talk to the STALE browser —
// measuring old cached CSS and reporting phantom layout failures. Pick a free
// port per run instead.
const PORT = 9300 + Math.floor(Math.random() * 600);
const OUT_DIR = path.join(__dirname, '..', 'mobile-audit');

// Real device viewports (CSS px), with touch enabled + mobile UA emulation.
const DEVICES = [
  { name: 'Android 360', width: 360, height: 800, dpr: 3 },
  { name: 'iPhone SE', width: 375, height: 667, dpr: 2 },
  { name: 'iPhone 14', width: 390, height: 844, dpr: 3 },
  { name: 'Pixel 7', width: 412, height: 915, dpr: 2.6 },
  { name: 'Galaxy S8', width: 360, height: 740, dpr: 3 },
  { name: 'Small 320', width: 320, height: 568, dpr: 2 },
  { name: 'iPad Mini', width: 768, height: 1024, dpr: 2 },
];

const PAGES = ['/', '/about.html', '/packages.html', '/destinations.html', '/visa.html', '/visa-usa.html', '/contact.html', '/gallery.html', '/blogs.html', '/faq.html', '/team.html', '/ceo.html', '/services.html', '/documents.html'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

async function waitForChrome(retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      return await getJSON(`http://127.0.0.1:${PORT}/json/version`);
    } catch {
      await sleep(250);
    }
  }
  throw new Error('headless Chrome did not expose CDP');
}

/** Minimal CDP client over a single ws connection. */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.sessionId = null;
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}, useSession = true) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (useSession && this.sessionId) payload.sessionId = this.sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }
}

async function openWs(url) {
  const { WebSocket } = require(WS_MODULE);
  const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  return ws;
}

/**
 * The audit expression lives in scripts/mobile-probe.js so this driver stays a
 * pure Node module (no DOM identifiers → no browser/node misclassification by
 * static analysis). We read it once and ship the source to the page.
 */
const PROBE_PATH = path.join(__dirname, 'mobile-probe.js');
const AUDIT_EXPR = fs.readFileSync(PROBE_PATH, 'utf8');

async function auditDevice(cdp, device, url) {
  // NOTE: every call after `Target.attachToTarget` must carry the sessionId,
  // otherwise the browser-level endpoint answers "wasn't found" for page domains.
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: device.width,
    height: device.height,
    deviceScaleFactor: device.dpr,
    mobile: true,
    screenWidth: device.width,
    screenHeight: device.height,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  await cdp.send('Page.navigate', { url });
  // Wait for load + a beat for JS-rendered cards to appear.
  await new Promise((resolve) => {
    let done = false;
    const handler = (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.method === 'Page.loadEventFired' && !done) {
          done = true;
          cdp.ws.off('message', handler);
          resolve();
        }
      } catch {
        /* ignore */
      }
    };
    cdp.ws.on('message', handler);
    setTimeout(() => {
      if (!done) {
        done = true;
        cdp.ws.off('message', handler);
        resolve();
      }
    }, 12000);
  });
  await sleep(900); // let fetch()-driven sections render

  const { result } = await cdp.send('Runtime.evaluate', {
    // The probe is a self-invoking IIFE; CDP returns a script's completion
    // value, which for `(function(){ return {...}; })();` is that object.
    expression: AUDIT_EXPR,
    returnByValue: true,
    awaitPromise: false,
  });

  let shot = null;
  if (WANT_SHOT) {
    try {
      const cap = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.mkdirSync(OUT_DIR, { recursive: true });
      const slug = url.replace(BASE, '').replace(/[/?]/g, '_') || '_home';
      const file = path.join(OUT_DIR, `${device.name.replace(/\s+/g, '-')}${slug}.png`);
      fs.writeFileSync(file, Buffer.from(cap.data, 'base64'));
      shot = file;
    } catch (e) {
      shot = `screenshot failed: ${e.message}`;
    }
  }

  return { ...result.value, shot };
}

async function main() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobcheck-'));
  const chrome = spawn(
    'google-chrome',
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--disable-dev-shm-usage',
      // Never reuse a cached stylesheet — a stale cache would make this audit
      // report layout failures that no longer exist (or miss real ones).
      '--disable-application-cache',
      '--disable-http-cache',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDir}`,
      'about:blank',
    ],
    // Own process group so cleanup can reap every helper/renderer child.
    { stdio: 'ignore', detached: true }
  );

  let exitCode = 0;
  try {
    const version = await waitForChrome();
    process.stdout.write(`Chrome ${version.Browser} (cdp :${PORT})\n`);

    const ws = await openWs(version.webSocketDebuggerUrl);
    const cdp = new CDP(ws);

    // The browser-level endpoint (webSocketDebuggerUrl) has no Page/Runtime
    // domains. Attach to a page target and drive everything through its sessionId.
    const created = await cdp.send('Target.createTarget', { url: 'about:blank' }, false);
    const { sessionId } = await cdp.send(
      'Target.attachToTarget',
      { targetId: created.targetId, flatten: true },
      false
    );
    cdp.sessionId = sessionId;

    // Give the renderer a moment to wire the session domains up.
    await sleep(300);

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const results = [];
    for (const page of PAGES) {
      for (const device of DEVICES) {
        const url = BASE + page;
        process.stdout.write(`  … ${device.name} ${page}\n`);
        const r = await auditDevice(cdp, device, url);
        results.push({ page, device: device.name, ...r });
      }
    }

    ws.close();

    // ---- report ----
    console.log('\n══════════ MOBILE RENDER AUDIT ══════════');
    console.log(`Base: ${BASE}   devices: ${DEVICES.length}   pages: ${PAGES.length}\n`);

    let problems = 0;
    for (const r of results) {
      const navBroken = r.navOpens && (!r.navOpens.opened || !r.navOpens.withinViewport);
      const bad = r.overflowPx > 2 || r.tinyTargetCount > 0 || r.tinyText > 0 || navBroken;
      if (bad) problems++;
      const mark = bad ? '⚠️ ' : '✅';
      const navState = navBroken ? 'BROKEN' : r.navOpenable ? 'ok' : 'MISSING';
      console.log(`${mark} ${r.device.padEnd(10)} ${r.page.padEnd(18)} vw=${r.vw} docW=${r.docW} overflow=${r.overflowPx}px  tinyTap=${r.tinyTargetCount}  tinyText=${r.tinyText}  nav=${navState}  [ovfX=${r.htmlOverflowX} mq=${r.mqMobile}]`);
      if (navBroken) {
        console.log(`      ↳ drawer did not open into the viewport: ${JSON.stringify(r.navOpens)}`);
      }

      if (r.overflowPx > 2) {
        for (const o of r.offenders) {
          console.log(`      ↳ overflow ${o.over}px  <${o.tag} class="${o.cls}">  "${o.text}"`);
        }
      }
      if (r.tinyTargetCount > 0) {
        console.log(`      ↳ small tap targets: ${r.tinyTargets.map((t) => `${t.tag}(${t.w}x${t.h})`).join(', ')}`);
      }
      if (r.tinyText > 0) {
        console.log(`      ↳ small text x${r.tinyText} e.g. ${r.tinyTextSample}`);
      }
      if (r.shot && typeof r.shot === 'string' && !r.shot.includes('failed')) {
        console.log(`      ↳ shot: ${r.shot}`);
      }
    }

    console.log(`\nChecks: ${results.length}   with problems: ${problems}`);
    if (problems === 0) {
      console.log('RESULT: ✅ no mobile layout problems detected');
    } else {
      console.log('RESULT: ⚠️ mobile layout problems found (see lines above)');
      exitCode = 0; // audit is informational; never fail the pipeline
    }
  } catch (e) {
    console.error('mobile-check failed:', e.message);
    exitCode = 1;
  } finally {
    // Kill the whole process group: Chrome spawns helpers that survive a plain
    // kill of the parent and would otherwise keep the debug port bound.
    try {
      if (chrome.pid) process.kill(-chrome.pid, 'SIGKILL');
    } catch {
      try {
        chrome.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(userDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  process.exit(exitCode);
}

main();

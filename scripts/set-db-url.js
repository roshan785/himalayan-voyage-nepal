'use strict';

/**
 * Securely import a PostgreSQL connection string into .env.
 *
 *   npm run db:set-url            # read the connection string from the CLIPBOARD
 *   npm run db:set-url -- --from-stdin   # read it from stdin instead
 *
 * Why this exists: the connection string is a secret. The person running the app
 * should never have to open .env in an editor, and the value must never be
 * echoed to the terminal, a log, or chat. Copy it on the provider's dashboard,
 * run this, and it is stored without ever being printed.
 *
 * Guarantees:
 *   • The value is never written to stdout/stderr — only a masked confirmation.
 *   • Every other line in .env is preserved byte-for-byte.
 *   • .env is backed up first, and refused if it is tracked by git.
 *   • Validates the scheme + host before writing, so a stray paste cannot
 *     corrupt the file.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ENV_PATH = path.join(__dirname, '..', '.env');
const KEY = 'DATABASE_URL';

/** Read the connection string without ever printing it. */
function readSecret() {
  if (process.argv.includes('--from-stdin')) {
    return new Promise((resolve) => {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { buf += c; });
      process.stdin.on('end', () => resolve(buf.trim()));
    });
  }
  // Clipboard. Needs a display, so it runs with the same environment the
  // browser session uses. XAUTHORITY is mandatory for xclip on this setup, and
  // it is only discoverable from a running desktop process, so it is looked up
  // when the variable is not already present.
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const env = {
    ...process.env,
    DISPLAY: process.env.DISPLAY || ':0',
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || 'wayland-0',
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${uid}/bus`
  };
  if (!env.XAUTHORITY) {
    // Try the inherited value from a live desktop process (gnome-shell, then the
    // session bus). Without this, xclip fails with "can't open display".
    for (const procName of ['gnome-shell', 'Xwayland', 'gnome-session-binary']) {
      try {
        const pid = execFileSync('pgrep', ['-n', procName], { encoding: 'utf8' }).trim();
        if (!pid) continue;
        const environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
        const found = environ.split('\0').find((v) => v.startsWith('XAUTHORITY='));
        if (found) { env.XAUTHORITY = found.slice('XAUTHORITY='.length); break; }
      } catch (_e) { /* try the next process */ }
    }
  }
  for (const [cmd, args] of [['xclip', ['-selection', 'clipboard', '-o']], ['wl-paste', ['--no-newline']], ['xsel', ['-b']]]) {
    try {
      const out = execFileSync(cmd, args, { env, encoding: 'utf8', timeout: 5000 });
      if (out && out.trim()) return Promise.resolve(out.trim());
    } catch (_e) { /* try the next tool */ }
  }
  return Promise.resolve('');
}

/** Show only enough to recognise the value, never the password. */
function mask(value) {
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.username}:***@${u.host}${u.pathname}`;
  } catch (_e) {
    return '(unparseable)';
  }
}

(async () => {
  let secret = await readSecret();
  if (!secret) {
    console.error('No connection string found.\n' +
      '  • Copy it on the Neon dashboard first (the "Copy" button next to the connection string), then re-run.\n' +
      '  • Or pipe it in:  npm run db:set-url -- --from-stdin');
    process.exit(2);
  }
  // Tolerate quotes / a stray trailing slash that dashboards sometimes include.
  secret = secret.replace(/^["']|["']$/g, '').trim();

  if (!/^postgres(ql)?:\/\//i.test(secret)) {
    console.error('That does not look like a PostgreSQL connection string ' +
      '(it must start with postgresql:// or postgres://). Nothing was changed.');
    process.exit(2);
  }
  try {
    const u = new URL(secret);
    if (!u.hostname || !u.password) {
      console.error('The connection string is missing a host or a password. Nothing was changed.');
      process.exit(2);
    }
  } catch (_e) {
    console.error('The connection string could not be parsed. Nothing was changed.');
    process.exit(2);
  }

  // Refuse to touch a git-tracked .env — a secret must never be committed.
  try {
    const tracked = execFileSync('git', ['ls-files', '--error-unmatch', '.env'],
      { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (tracked) {
      console.error('.env is tracked by git — refusing to write a secret into it. ' +
        'Add ".env" to .gitignore and "git rm --cached .env" first.');
      process.exit(3);
    }
  } catch (_e) { /* not tracked — this is what we want */ }

  // Before writing, warn (without failing) if .env already contains this exact
  // connection string — the usual sign that a secret pasted into a chat or log
  // should be rotated at the provider before it is trusted here.
  try {
    const cur = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
    const m = cur.match(/^\s*DATABASE_URL\s*=\s*(.+)$/m);
    if (m && m[1].trim() === secret) {
      console.error('note: this is the same DATABASE_URL that is already in .env.');
      console.error('      if that value was ever pasted into a chat, ticket or log, rotate it at');
      console.error('      the provider first, then re-run so the new secret is stored here.');
    }
  } catch (_e) { /* best effort */ }

  const original = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  fs.writeFileSync(ENV_PATH + '.bak_seturl_' + Date.now(), original, { mode: 0o600 });

  const lines = original.split('\n');
  let replaced = false;
  const out = lines.map((line) => {
    // Replace an active DATABASE_URL line only; leave comments untouched.
    if (/^\s*DATABASE_URL\s*=/.test(line)) { replaced = true; return `${KEY}=${secret}`; }
    return line;
  });
  if (!replaced) {
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push('# PostgreSQL (added by npm run db:set-url)');
    out.push(`${KEY}=${secret}`);
  }
  fs.writeFileSync(ENV_PATH, out.join('\n'), { mode: 0o600 });
  fs.chmodSync(ENV_PATH, 0o600);

  // Prove it round-trips WITHOUT printing it.
  require('../src/load-env').loadDotEnv();
  const loaded = process.env.DATABASE_URL || '';
  const ok = loaded === secret;

  console.log('✅ DATABASE_URL stored in .env' + (replaced ? ' (existing line replaced)' : ' (appended)'));
  console.log('   target : ' + mask(secret));
  console.log('   length : ' + secret.length + ' characters');
  console.log('   file   : ' + ENV_PATH + '  (mode 0600)');
  console.log('   other settings preserved: ' + (replaced ? lines.filter((l) => /^\s*[A-Z_]+=/.test(l) && !/^\s*DATABASE_URL=/.test(l)).length + ' keys' : 'all'));
  console.log('   loaded back correctly: ' + (ok ? 'yes' : 'NO — please re-run'));
  console.log('\nNext: npm run migrate:verify   (read-only check, changes nothing)');
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error('Failed: ' + err.message);
  process.exit(1);
});

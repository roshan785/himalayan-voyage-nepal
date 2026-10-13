'use strict';

/**
 * Database backup (read-only against the source).
 *
 *   node scripts/backup-db.js            # writes a timestamped backup
 *   node scripts/backup-db.js --list     # show existing backups
 *
 * SQLite : uses sqlite3's `.backup` (online, WAL-safe, non-blocking). Falls back
 *          to a plain file copy of .db + -wal + -shm when the CLI is absent.
 * Postgres: runs pg_dump when available; otherwise prints the exact command.
 * Backups land in ./backups/ with mode 600. Nothing is ever deleted.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadDotEnv } = require('../src/load-env');

loadDotEnv();

const ROOT = path.join(__dirname, '..');
const BACKUP_DIR = path.join(ROOT, 'backups');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function list() {
  if (!fs.existsSync(BACKUP_DIR)) return console.log('(no backups directory yet)');
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => /^backup-/.test(f));
  if (!files.length) return console.log('(no backups yet)');
  for (const f of files.sort()) {
    const s = fs.statSync(path.join(BACKUP_DIR, f));
    console.log(`  ${f}  ${(s.size / 1024).toFixed(1)} KB  ${s.mtime.toISOString()}`);
  }
}

const isPostgres = () => /^postgres(ql)?:\/\//i.test((process.env.DATABASE_URL || '').trim());

function backupSqlite() {
  const src = process.env.DB_PATH || path.join(ROOT, 'data', 'travel.db');
  if (!fs.existsSync(src)) throw new Error('SQLite database not found: ' + src);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dest = path.join(BACKUP_DIR, `backup-sqlite-${stamp}.db`);
  try {
    // `.backup` performs a consistent online copy even while the app is writing.
    execFileSync('sqlite3', ['file:' + src + '?mode=ro', `.backup '${dest}'`], { stdio: 'pipe' });
  } catch (_e) {
    // Fallback: copy the db plus its WAL/SHM so the snapshot stays consistent.
    fs.copyFileSync(src, dest);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(src + suffix)) fs.copyFileSync(src + suffix, dest + suffix);
    }
  }
  fs.chmodSync(dest, 0o600);
  return dest;
}

function backupPostgres() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dest = path.join(BACKUP_DIR, `backup-pg-${stamp}.sql`);
  let url;
  try {
    url = new URL(process.env.DATABASE_URL);
  } catch (_e) {
    console.log('  DATABASE_URL is not a valid URL — cannot back up.');
    return null;
  }
  // Pass credentials via the environment, never on argv: a failed pg_dump
  // prints its command line, which would leak the password into logs.
  const env = {
    ...process.env,
    PGPASSWORD: decodeURIComponent(url.password || ''),
    PGSSLMODE: 'require'
  };
  const args = [
    '--no-owner', '--no-privileges',
    '-h', url.hostname,
    '-p', url.port || '5432',
    '-U', decodeURIComponent(url.username || ''),
    '-d', url.pathname.replace(/^\//, '')
  ];
  try {
    const out = execFileSync('pg_dump', args, {
      encoding: 'buffer', maxBuffer: 512 * 1024 * 1024, env
    });
    fs.writeFileSync(dest, out, { mode: 0o600 });
    return dest;
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('  pg_dump not installed. Run this (connection string is NOT printed):');
      console.log('    pg_dump "$DATABASE_URL" > backups/backup-pg-' + stamp + '.sql');
      console.log('  Or use the Neon dashboard Branches/Restore for point-in-time backups.');
      return null;
    }
    // Redact anything that looks like a connection string before printing.
    const raw = ((err.stdout || '') + (err.stderr || '')).toString();
    const safe = raw.replace(/postgres(ql)?:\/\/[^\s"']+/gi, 'postgresql://<redacted>');
    console.log('  pg_dump failed: ' + (safe.split('\n').filter(Boolean)[0] || err.message));
    console.log('  Fallback: use the Neon dashboard (Branches -> Restore) or set PGPASSWORD and run pg_dump manually.');
    return null;
  }
}

function main() {
  if (process.argv.includes('--list')) return list();
  console.log(`[backup] target: ${isPostgres() ? 'postgres' : 'sqlite'}`);
  const dest = isPostgres() ? backupPostgres() : backupSqlite();
  if (!dest) return console.log('[backup] no file written (see instructions above)');
  const size = fs.statSync(dest).size;
  console.log(`[backup] ✅ wrote ${path.relative(ROOT, dest)} (${(size / 1024).toFixed(1)} KB, mode 600)`);
}

main();

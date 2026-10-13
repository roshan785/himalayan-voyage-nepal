'use strict';

/**
 * Scheduled backup with retention + integrity verification + isolated restore
 * proof. Wraps the existing backup-db.js so there is ONE backup implementation.
 *
 *   node scripts/backup-schedule.js                 # back up + verify + prune
 *   node scripts/backup-schedule.js --list          # list backups + integrity
 *   node scripts/backup-schedule.js --restore-test   # restore newest into temp
 *
 *   BACKUP_KEEP=14        how many recent backups to retain (default 14)
 *   BACKUP_DIR=backups    where backups live
 *
 * Safety: reads the SOURCE database only. Prune deletes OLD backup files only,
 * never the newest BACKUP_KEEP, and never any live database. A restore-test
 * loads the newest dump into a throwaway SQLite file in /tmp and counts rows to
 * prove the backup is actually usable — then removes it.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { loadDotEnv } = require('../src/load-env');

loadDotEnv();

const ROOT = path.join(__dirname, '..');
const DIR = path.isAbsolute(process.env.BACKUP_DIR || '') ? process.env.BACKUP_DIR : path.join(ROOT, process.env.BACKUP_DIR || 'backups');
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 14);

function backupsNewestFirst() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR)
    .filter((f) => /^backup-(sqlite|pg)-/.test(f) && !f.endsWith('-wal') && !f.endsWith('-shm'))
    .map((f) => ({ name: f, full: path.join(DIR, f), mtime: fs.statSync(path.join(DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

function integrity(file) {
  try {
    if (file.endsWith('.db')) {
      return execFileSync('sqlite3', ['file:' + file + '?mode=ro', 'PRAGMA integrity_check;'], { encoding: 'utf8' }).trim();
    }
    // .sql dump: a cheap structural check (has a plausible pg dump header).
    const head = fs.readFileSync(file, 'utf8').slice(0, 400);
    return /PostgreSQL database dump/i.test(head) ? 'ok (pg dump)' : 'unknown-format';
  } catch (err) {
    return 'error: ' + err.message.split('\n')[0];
  }
}

function runBackup() {
  console.log('[backup-schedule] running backup-db.js …');
  // Reuse the existing script; its output already states where the file landed.
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'backup-db.js')], { stdio: 'inherit' });
}

function prune() {
  const all = backupsNewestFirst();
  const old = all.slice(KEEP);
  if (!old.length) { console.log(`[backup-schedule] retention: ${all.length}/${KEEP} kept, nothing to prune`); return; }
  for (const f of old) {
    try { fs.unlinkSync(f.full); console.log(`[backup-schedule] pruned ${f.name}`); } catch (e) { console.error(`  prune failed ${f.name}: ${e.message}`); }
  }
  console.log(`[backup-schedule] retention done — kept newest ${Math.min(all.length, KEEP)}`);
}

function listWithIntegrity() {
  const all = backupsNewestFirst();
  if (!all.length) return console.log('(no backups yet)');
  for (const f of all) {
    const size = (fs.statSync(f.full).size / 1024).toFixed(1);
    console.log(`  ${f.name}  ${size} KB  integrity=${integrity(f.full)}`);
  }
}

/**
 * Isolated restore proof: copy the newest SQLite backup into a fresh temp file
 * and count its rows. Proves the backup is loadable WITHOUT touching any live DB.
 */
function restoreTest() {
  const newest = backupsNewestFirst().find((f) => f.name.endsWith('.db'));
  if (!newest) return console.log('(no sqlite backup to restore-test)');
  const tmp = path.join(os.tmpdir(), 'restore-test-' + Date.now() + '.db');
  fs.copyFileSync(newest.full, tmp);
  try {
    const ic = execFileSync('sqlite3', ['file:' + tmp + '?mode=ro', 'PRAGMA integrity_check;'], { encoding: 'utf8' }).trim();
    const tables = ['users', 'packages', 'destinations', 'bookings', 'testimonials', 'blog_posts', 'contacts', 'subscribers'];
    const counts = {};
    for (const t of tables) {
      try { counts[t] = execFileSync('sqlite3', ['file:' + tmp + '?mode=ro', `SELECT COUNT(*) FROM ${t};`], { encoding: 'utf8' }).trim(); } catch (_e) { counts[t] = 'n/a'; }
    }
    console.log(`[backup-schedule] restore-test ${newest.name}: integrity=${ic}`);
    console.log('  rows:', JSON.stringify(counts));
    console.log(ic === 'ok' ? '  \u2705 backup is restorable' : '  \u274c integrity problem');
    return ic === 'ok';
  } finally {
    try { fs.unlinkSync(tmp); } catch (_e) {}
  }
}

function main() {
  if (process.argv.includes('--list')) return listWithIntegrity();
  if (process.argv.includes('--restore-test')) return void restoreTest();
  runBackup();
  console.log('[backup-schedule] verifying newest backup …');
  const ok = restoreTest();
  prune();
  process.exit(ok === false ? 1 : 0);
}

main();

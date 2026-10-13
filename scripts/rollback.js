'use strict';

/**
 * Safe rollback helper for the Render + Neon production setup.
 *
 *   node scripts/rollback.js --list            # recent commits that can be rolled back to
 *   node scripts/rollback.js --to <sha>        # revert HEAD back to <sha> (--no-commit by default)
 *   node scripts/rollback.js --health          # show the live health snapshot before deciding
 *
 * What it does NOT do (deliberately):
 *   • It never force-pushes and never rewrites history.
 *   • It never touches the database — a code rollback is separate from data.
 *   • It never runs automatically without you passing --to and --apply.
 *
 * Default is DRY-RUN: it prints the exact commands it WOULD run. Add --apply to
 * create the revert commit. Render then redeploys the reverted commit on its own
 * (autoDeploy), and `scripts/deploy-verify.js` proves the result.
 */

const { execFileSync } = require('child_process');
const https = require('https');
const { URL: NodeURL } = require('url');

const BASE = (process.env.DEPLOY_URL || 'https://himalayan-voyage-nepal-0sem.onrender.com').replace(/\/$/, '');

const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

function printHealth() {
  return new Promise((resolve) => {
    const u = new NodeURL(BASE + '/api/health');
    const req = https.request({ hostname: u.hostname, port: 443, path: u.pathname, method: 'GET' }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => {
        try { const b = JSON.parse(d); console.log(`  live: HTTP ${res.status} db=${b.db} persistent=${b.dbPersistent}`); }
        catch (_e) { console.log(`  live: HTTP ${res.status} (unparseable body)`); }
        resolve();
      });
    });
    req.on('error', (e) => { console.log('  live: unreachable —', e.message); resolve(); });
    req.setTimeout(20000, () => req.destroy());
    req.end();
  });
}

async function main() {
  const args = process.argv.slice(2);
  const toIdx = args.indexOf('--to');
  const apply = args.includes('--apply');

  if (args.includes('--health') || args.length === 0) {
    console.log('[rollback] current live health:');
    await printHealth();
    console.log('\n[rollback] recent commits (newest first):');
    console.log(git(['log', '--oneline', '-10']).split('\n').map((l) => '  ' + l).join('\n'));
    console.log('\nUsage: node scripts/rollback.js --to <sha>  [--apply]');
    return;
  }

  if (toIdx === -1 || !args[toIdx + 1]) {
    console.error('[rollback] give a target: --to <sha>  (see --list output above)');
    process.exit(2);
  }

  const target = args[toIdx + 1];
  const range = `${target}..HEAD`;
  const commits = git(['log', '--oneline', range]).split('\n').filter(Boolean);
  if (!commits.length) { console.log('[rollback] nothing to revert — target is already HEAD'); return; }

  console.log(`[rollback] would revert ${commits.length} commit(s) back to ${target}:`);
  commits.forEach((c) => console.log('  ' + c));
  const revertArgs = ['revert', '--no-edit', '--no-commit', range];
  console.log(`\n  git ${revertArgs.join(' ')}`);
  console.log('  git commit -m "revert: roll back to ' + target + '"');
  console.log('  git push origin ' + git(['branch', '--show-current']));

  if (!apply) {
    console.log('\n[rollback] DRY-RUN. Re-run with --apply to perform the revert commit.');
    return;
  }
  execFileSync('git', revertArgs, { stdio: 'inherit' });
  execFileSync('git', ['commit', '-m', `revert: roll back to ${target}`], { stdio: 'inherit' });
  console.log('[rollback] revert commit created. Push with: git push origin ' + git(['branch', '--show-current']));
  console.log('[rollback] then verify: node scripts/deploy-verify.js');
}

main();

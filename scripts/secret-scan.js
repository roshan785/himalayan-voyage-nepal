'use strict';

/**
 * Secret-leak scanner (CI gate + local pre-commit).
 *
 *   node scripts/secret-scan.js            # scan the working tree
 *   node scripts/secret-scan.js --staged   # scan only files staged in git
 *
 * Detects real credentials committed by accident: provider API keys, private
 * keys, JWTs, and connection strings that carry an inline password. Placeholders
 * (example/test/change-me/your-key) and env-var references are ignored so the
 * suite does not produce false failures.
 *
 * Exit code 0 = clean, 1 = at least one finding. Never prints a full secret —
 * only a masked prefix so the finding can be located without leaking it.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.woff', '.woff2', '.pdf', '.db', '.dump', '.sqlite']);

// Each pattern: { id, re, severity }. Patterns target REAL credentials only.
const PATTERNS = [
  { id: 'private-key', severity: 'high', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: 'aws-access-key', severity: 'high', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'google-api-key', severity: 'high', re: /\bAIza[0-9A-Za-z\-_]{35}\b/ },
  { id: 'stripe-secret', severity: 'high', re: /\bsk_(live|test)_[0-9A-Za-z]{20,}\b/ },
  { id: 'github-token', severity: 'high', re: /\bgh[pousr]_[0-9A-Za-z]{30,}\b/ },
  { id: 'slack-token', severity: 'high', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { id: 'jwt', severity: 'medium', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { id: 'resend-key', severity: 'high', re: /\bre_[0-9A-Za-z_]{20,}\b/ },
  { id: 'sendgrid-key', severity: 'high', re: /\bSG\.[0-9A-Za-z_-]{20,}\.[0-9A-Za-z_-]{20,}\b/ },
  // A connection string with a non-placeholder password inline.
  { id: 'db-url-password', severity: 'high', re: /postgres(?:ql)?:\/\/[^\s:'"/]+:(?!<|PASSWORD|password|xxx|example|changeme|user)[^\s@'"/]{6,}@/ }
];

// Anything on a line matching these is treated as an intentional placeholder.
const ALLOW = /(example|placeholder|change[_-]?me|your[_-]?|dummy|sample|redacted|xxxx|\$\{|process\.env|env\.|\.example)/i;

function listFiles(stagedOnly) {
  if (stagedOnly) {
    const out = execSync('git diff --cached --name-only --diff-filter=ACM', { encoding: 'utf8' });
    return out.split('\n').filter(Boolean);
  }
  const tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
  // Skip vendored / generated trees even if a file was force-added.
  const skipDirs = /^(node_modules|\.git|data|backups|dist|coverage)\//;
  return tracked.filter((f) => !skipDirs.test(f));
}

function walk(root) {
  const found = [];
  for (const entry of listFiles(process.argv.includes('--staged'))) {
    if (SKIP_EXT.has(path.extname(entry))) continue;
    const full = path.join(root, entry);
    if (!fs.existsSync(full)) continue;
    let text;
    try { text = fs.readFileSync(full, 'utf8'); } catch (_e) { continue; }
    if (text.length > 2 * 1024 * 1024) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (ALLOW.test(line)) continue;
      for (const p of PATTERNS) {
        const m = line.match(p.re);
        if (m) {
          found.push({ file: entry, line: i + 1, id: p.id, severity: p.severity, preview: m[0].slice(0, 8) + '…' });
          break;
        }
      }
    }
  }
  return found;
}

function main() {
  const root = process.cwd();
  const staged = process.argv.includes('--staged');
  const findings = walk(root);
  if (!findings.length) {
    console.log(`[secret-scan] \u2705 clean (${staged ? 'staged' : 'tracked'} files, ${PATTERNS.length} patterns)`);
    process.exit(0);
  }
  console.error(`[secret-scan] \u274c ${findings.length} potential secret(s):`);
  for (const f of findings) {
    console.error(`  ${f.severity.toUpperCase()} ${f.file}:${f.line}  [${f.id}]  ${f.preview}`);
  }
  console.error('\nRemove the secret, rotate it, and load it from the environment instead.');
  process.exit(1);
}

main();

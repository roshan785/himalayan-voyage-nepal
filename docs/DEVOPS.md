# DevOps Runbook — Himalayan Voyage Nepal

Production setup: **Render** (web service `srv-db74ijad0e5s73b1kvug`) + **Neon** PostgreSQL.
Public URL: `https://himalayan-voyage-nepal-0sem.onrender.com`.
Repo: `github.com/roshan785/himalayan-voyage-nepal` (branch `master`).

> The service is a Render **Blueprint** service with `autoDeploy: true`, so a push
> to `master` deploys automatically. GitHub Actions gates that push (see below);
> Render ships whatever ends up on `master`.

---

## 1. CI/CD (`.github/workflows/ci.yml`)

Runs on every push and PR to `master`/`main`, plus manual dispatch.

| Job | What it enforces |
|-----|------------------|
| `build-test` | `npm ci` → ESLint → `node --check` every module → `npm audit --audit-level=high` → **secret scan** → `npm test` |
| `deploy-guard` | After tests pass on `master`, waits for the live service and fails if it is not healthy on PostgreSQL |

**A red CI run must be fixed before merging** — otherwise Render will still deploy
(it is not wired to Actions), but the failure is visible on the commit.

Run the same gates locally:

```bash
npm run ci            # lint + secret-scan + tests
npm run secret-scan   # scan the tracked tree for leaked credentials
```

### Adding a required status check (DONE)
Branch protection **is applied** on `master`:
`required_status_checks = ["Tests, lint & audit"]`, force-push and deletion blocked,
`enforce_admins = false` (so the owner can still push hotfixes — set it to true if
you want even admins gated). Verify anytime:

```bash
gh api repos/roshan785/himalayan-voyage-nepal/branches/master/protection
```

### Render ↔ CI binding (BLOCKER — needs dashboard)
Render's blueprint has `autoDeploy: true`, which **deploys on push regardless of
CI** — it is not wired to GitHub Actions. Binding it requires a Render dashboard
change (Web service → Settings → *Auto-Deploy: After CI Checks Pass*) or a Render
API key, **neither of which is available here**. Until that is done, a red CI run
is visible on the PR/commit but does not by itself block the deploy. Mitigation in
place: `deploy-guard` verifies the live service after every push and fails the
workflow if the released commit is unhealthy.

---

## 2. Health, uptime & alerts

| Script | Purpose |
|--------|---------|
| `npm run ops` | One-shot report: health, DB + persistence, response time, 404 sanity, newest backup age |
| `npm run uptime` | Single health check; exit 0 = healthy, 1 = down |
| `npm run uptime:watch` | Loop every 5 min (for a host with a scheduler) |
| `npm run deploy:verify` | Poll the live URL until healthy; used by CI and after rollback |

`uptime-check.js`, `deploy-verify.js` and `ops-status.js` use the **core `https`
module** with **`family: 4`** — this runtime's IPv6 route to the CDN black-holes
(connect timeout) while IPv4 answers in ~300 ms, so without forcing IPv4 every
check waits for the IPv6 timeout and reports a false DOWN. They are
dependency-free. All three retry transient failures before declaring DOWN.

### Cloud monitoring (works when your laptop is OFF)

`.github/workflows/monitor.yml` runs **on GitHub every 15 minutes** and does not
depend on this machine:

- **Site health** — `uptime-check.js` (requires `db=postgres` + `persistent=true`).
- **Database connectivity** — an independent `/api/stats` query.
- **Endpoint + 404 sanity** — `/api/packages`, `/api/destinations`, `/api/site` (200) and a 404 check.

Any failure fails the workflow and **GitHub emails the repo owner automatically**.
Add repo secrets `UPTIME_WEBHOOK` / `DISCORD_WEBHOOK` for richer alerts. A
cloud-side *backup* check is included but **skipped** until a `DATABASE_URL`
secret is provided (backups run locally/host-side; see §3).

### Alerting (optional)
Set **one** of these env vars to receive a message on the first failure and on
recovery:

```
UPTIME_WEBHOOK=https://…            # generic JSON {text}
DISCORD_WEBHOOK=https://discord.com/api/webhooks/…
TELEGRAM_WEBHOOK=https://…          # any webhook that accepts {text}
```

Without a webhook the scripts still log, and GitHub still reports workflow
failures by email — alerts to a chat app are simply not delivered.
**No paid service is configured by default.**

### Scheduled jobs (this machine)
Registered in the OpenOS scheduler; they run **only while OpenOS is running here**
(the laptop being off stops them — that is exactly why the GitHub `monitor.yml`
exists as the always-on layer):

| Cron | Name | Action |
|------|------|--------|
| `0 3 * * *` | `travel-nepal-daily-backup` | backup + verify + prune |
| `*/10 * * * *` | `travel-nepal-uptime-10min` | health check → `/tmp/travel-uptime.log` |
| `0 */6 * * *` | `travel-nepal-ops-status-6h` | ops report → `/tmp/travel-ops.log` |

For a persistent server-side backup schedule use a systemd timer (§7).

---

## 3. Backups, retention & restore verification

```bash
npm run backup                 # one backup (SQLite .backup or pg_dump)
npm run backup:schedule        # backup + integrity + ISOLATED restore-test + prune
npm run backup:restore-test    # prove the newest SQLite backup is restorable
node scripts/backup-schedule.js --list   # list backups + integrity per file
```

- **Retention:** `BACKUP_KEEP` (default **14**). Prune deletes only old backup
  files, never the newest N, never a live database.
- **Integrity:** `PRAGMA integrity_check` for SQLite dumps; structural check for
  pg dumps.
- **Restore proof:** the newest SQLite backup is copied to `/tmp`, opened
  read-only, its row counts printed, then deleted — proving usability without
  touching production.
- **Credentials:** `pg_dump` receives its password via the environment, never
  `argv`, and connection strings are redacted from any error output.

Backups live in `backups/` (git-ignored, mode 600).

---

## 4. Dependency & secret scanning

```bash
npm audit --omit=dev --audit-level=high   # CI gate
npm run secret-scan                        # provider keys, private keys, JWTs, inline DB passwords
npm run secret-scan:staged                 # same, staged files only (pre-commit)
```

`secret-scan.js` ignores placeholders (`example`, `change-me`, `process.env`…)
to avoid false failures. If it fires: **remove, rotate, and load from env**.

---

## 5. Deploy failure detection & rollback

`deploy-verify.js` is the truth for "did the deploy work" — it does not trust
HTTP 200 alone; it requires `db=postgres` **and** `dbPersistent=true`.

Rollback is **revert-based** (never force-push, never rewrites history):

```bash
node scripts/rollback.js --health          # show live health + recent commits
node scripts/rollback.js --to <sha>         # DRY-RUN: prints the exact commands
node scripts/rollback.js --to <sha> --apply # create the revert commit
git push origin master                      # Render redeploys automatically
npm run deploy:verify                       # prove the rollback is healthy
```

Rollback is **code only**. It never touches the database. If a release also
changed data, restore from a backup separately (§3) and only after confirming
which rows are affected.

---

## 6. Booking notifications (optional)

`src/notify.js` sends an email per new booking when configured; otherwise it is
a **graceful no-op** (`{sent:false, reason:"not-configured"}`) and bookings still
succeed. No npm package is installed — SMTP is spoken over `net`/`tls`, and HTTP
APIs are called with `https`.

Configure **one** provider (see `.env.example`):

```
# HTTP API        (easiest on free hosts)
RESEND_API_KEY=…      # or SENDGRID_API_KEY=…
# SMTP
SMTP_HOST=…  SMTP_PORT=587  SMTP_USER=…  SMTP_PASS=…
# Required either way
NOTIFY_FROM=…  NOTIFY_TO=…
```

Set these on **Render → Environment** (never in the repo). Status is visible at
`GET /api/health` → `notifications:{configured,provider,…}` (never a value).

---

## 7. systemd timers (recommended on your own host)

```ini
# /etc/systemd/system/hv-backup.service
[Service]
Type=oneshot
WorkingDirectory=/path/to/travel-nepal
Environment=BACKUP_KEEP=14
ExecStart=/usr/bin/node scripts/backup-schedule.js
```
```ini
# /etc/systemd/system/hv-backup.timer
[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
[Install]
WantedBy=timers.target
```
`systemctl enable --now hv-backup.timer`. Same pattern for `uptime-check.js`
every 10 min.

---

## 8. Recovery instructions (incident playbook)

1. **Site down** → `npm run ops` and check `justdown`. If `/api/health` is
   unreachable, check Render → Logs; a crash loop shows the stack. Confirm env
   vars (Render → Environment) are still set — a missing `DATABASE_URL` silently
   falls back to SQLite.
2. **Wrong database (sqlite instead of postgres)** → `/api/health` `db:sqlite`.
   Set `DATABASE_URL` on Render and redeploy; verify with `npm run deploy:verify`.
3. **Bad deploy** → `node scripts/rollback.js --to <last-good-sha> --apply`,
   push, then `npm run deploy:verify`.
4. **Data loss / bad data** → do NOT delete anything. Restore a backup:
   `npm run backup:restore-test` (verifies the newest), then, having decided the
   target, restore into a **new** database first and compare before switching.
5. **Leaked secret** → rotate it at the provider, update Render env, redeploy.
   `npm run secret-scan` to confirm the tree is clean.

---

## 9. Costs & limits

| Item | Cost | Notes |
|------|------|-------|
| Render web service | Free | Sleeps after inactivity; cold start 5–50s |
| Neon PostgreSQL | Free tier | Storage/compute limits per Neon plan |
| GitHub Actions | Free (public repo) | ~2k min/month free even when private |
| Backups / scripts | $0 | Run locally or on your host |
| Alerting webhooks | $0 | Discord/Telegram/generic webhook |
| SMTP email | $0–low | Free tiers exist; not configured here |

No paid service was subscribed. No external credential was invented or faked.

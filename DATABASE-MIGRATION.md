# Database persistence — migration & operations guide

The app now supports **two storage drivers** and picks one automatically:

| `DATABASE_URL` | Driver | Persistence |
|---|---|---|
| not set | SQLite (`node:sqlite`, file `data/travel.db`) | **ephemeral on free hosts** — wiped on redeploy/spin-down |
| set | PostgreSQL (`pg`) | **persistent** — survives redeploys |

Nothing else in the codebase changes between the two. Verify which one a running
instance is using:

    curl -s https://<your-app>/api/health
    # {"ok":true,...,"db":"sqlite","dbPersistent":false}
    # {"ok":true,...,"db":"postgres","dbPersistent":true}

---

## 1. Create a free PostgreSQL database

Render's own free Postgres **expires 30 days after creation**, so it is not a
persistence solution. Use a managed provider whose free tier does not expire,
then copy its connection string.

| Provider | Free tier | Expires? |
|---|---|---|
| Neon | yes | no |
| Supabase | yes | no (pauses after long inactivity; resumes on connect) |
| Render Postgres | yes | **yes - 30 days** |

> Confirm the current limits on the provider's pricing page before relying on it.
> The app needs well under 1 GB.

The connection string looks like:

    postgresql://USER:PASSWORD@HOST/DBNAME?sslmode=require

---

## 2. Import the existing data (preserves ids + password hashes)

Run this **from the machine that still has the SQLite file** (e.g. your laptop,
before it is lost):

    cd apps/travel-nepal
    DATABASE_URL='postgresql://USER:PASSWORD@HOST/DBNAME?sslmode=require' npm run migrate:pg

What the script guarantees:

- **IDs are inserted explicitly**, so any id-based reference keeps working.
- **setval() resets every SERIAL sequence** - without this the next INSERT
  reuses id 1 and fails with a duplicate key (the classic migration bug).
- **One transaction per table** - a failure rolls back, target left untouched.
- **Password hashes are copied byte-for-byte** (bcrypt strings); no plaintext.
- Idempotent: re-running skips tables whose counts already match (`--force`
  re-imports anyway).

Expected output ends with:

    ✅ password hash preserved (bcrypt string identical, not printed)
    RESULT: ✅ migration verified - ids, data and password hashes match.

## 3. Verify without writing anything

    DATABASE_URL='...' npm run migrate:verify

Prints per-table SQLite vs PostgreSQL counts and `<table> MATCH|MISMATCH`.

## 4. Point the deployed app at PostgreSQL

Add the environment variable on the host and redeploy:

- **Render:** Dashboard -> your service -> *Environment* -> add `DATABASE_URL` ->
  Save (it redeploys). Then check `/api/health` shows `"dbPersistent": true`.

Nothing else is required - no code change, no `render.yaml` edit.

## 5. Roll back

Delete the `DATABASE_URL` environment variable and redeploy. The app falls back
to SQLite immediately. Keep the `backups/` files until you are satisfied.

---

## Local development

Unchanged and dependency-free:

    npm start        # SQLite, no configuration
    npm run seed     # creates schema + admin if missing
    npm test         # 49 tests (run on whichever driver DATABASE_URL selects)

Test the PostgreSQL path locally:

    DATABASE_URL='postgresql://user@127.0.0.1:5432/hvtest?sslmode=disable' npm test

## Proving persistence (restart test)

    npm run test:persist                                     # SQLite
    DATABASE_URL='...' ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run test:persist

It starts the server, writes a booking and edits a package, **kills the
process**, boots a second one against the same storage, and re-reads the rows.

## Backups

    sqlite3 data/travel.db ".backup 'backups/travel-$(date +%s).db'"
    pg_dump "$DATABASE_URL" > "backups/pg-$(date +%s).sql"

`backups/` is git-ignored. Take one before any migration.

## Admin password recovery

    npm run admin:pass -- 'NewPasswordHere' admin@example.com

Works against whichever driver is active.

---

## Safety guarantees (verified)

The import replaces a target table, so it refuses to run when that could destroy
data you did not come from. Behaviour proven locally with four scenarios:

| Scenario | Result |
|---|---|
| Fresh (empty) target | imports all tables ✅ |
| Re-run with identical counts | skips every table (no TRUNCATE) ✅ |
| **Target has MORE rows than source** | **REFUSES** — "looks like a live database" ✅ |
| `--force` on a non-empty target | still refuses unless `I_UNDERSTAND_THIS_REPLACES_DATA=1` ✅ |

`npm run migrate:verify` is completely read-only — it never writes, and was
checked against a modified target to confirm the rows were untouched.

## Pre-flight checklist

1. Take a backup whose integrity you have verified:
   ```bash
   sqlite3 data/travel.db ".backup 'backups/source-$(date +%s).db'"
   sqlite3 backups/source-*.db "PRAGMA integrity_check;"
   ```
2. Confirm the SOURCE is the file you think it is: `data/travel.db` (or the
   path in `DB_PATH`). Row counts: users/destinations/packages/testimonials/
   blog_posts/contacts/subscribers/bookings.
3. Run `npm run migrate:verify` first — it reports MATCH/MISMATCH for every
   table without writing anything.
4. Only then run `npm run migrate:pg`.

---

## Neon production cutover (completed 2026-10-13)

Target: Neon PostgreSQL 18.6, pooled connection, database `neondb`.
Stored in `.env` as `DATABASE_URL` (mode 600, gitignored, never committed).

Verified byte-for-byte against the source `data/travel.db`
(sha256 `a856e71fc7d56949…`, `PRAGMA integrity_check` = ok):

| table | rows | | table | rows |
|---|---|---|---|---|
| users | 1 | | blog_posts | 3 |
| destinations | 12 | | contacts | 0 |
| packages | 8 | | subscribers | 0 |
| testimonials | 3 | | bookings | 2 |

Password hashes, package `price`/`image` and both booking records match the
source exactly; sequences were reset to `max(id)` so new inserts cannot collide.

### Connecting the deployed app

The running app picks up PostgreSQL automatically when `DATABASE_URL` is set —
no code change is needed. `GET /api/health` reports `db: "postgres"` and
`dbPersistent: true` in that case.

### Rotating a leaked secret

If a connection string or password has ever been pasted into a chat, ticket or
log, rotate it at the provider and store the new value with:

```bash
npm run db:set-url        # reads the new string from the clipboard
```

Then re-verify with `npm run migrate:verify` (read-only) and confirm
`/api/health` still reports `db: "postgres"`.

### Admin recovery

`ensureAdmin()` only seeds the FIRST admin, so it can never reset an existing
password. Use the CLI instead — it reads the password from argv, writes only the
bcrypt hash, and prints nothing sensitive:

```bash
npm run admin:pass -- '<new-password>' admin@himalayanvoyage.test
```

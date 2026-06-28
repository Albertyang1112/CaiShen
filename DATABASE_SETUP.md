# CaiShen — Database & Local/Hosted Workflow

How CaiShen's database works, how to develop locally with **fake data** without touching
production, and how to ship schema changes safely to hosted Supabase.

---

## TL;DR recommendation

CaiShen is a **backend-mediated** app: the React frontend talks only to the Express API,
which talks to Postgres via the `pg` driver. It uses **custom JWT auth** (not Supabase Auth)
and **Cloudflare R2** for files (not Supabase Storage). The frontend never touches the DB
directly, so **Supabase Auth and RLS don't apply** to the current design.

**Recommended setup → "Option B": Postgres-anywhere via `DATABASE_URL`.** Because the app
speaks only standard Postgres (raw `pg` — no Supabase SDK/Auth/Storage/RLS), every tier is the
same connection; only the URL changes:

| | Build / dev | Heavy testing | Production (later) |
|---|---|---|---|
| Database | **hosted Supabase free** | **local Postgres** | **AWS RDS / Aurora** |
| App connects via | `pg` + `DATABASE_URL` | `pg` + `DATABASE_URL` | `pg` + `DATABASE_URL` |
| Schema | `initSchema()` on boot | `initSchema()` on boot | `initSchema()` on boot |
| Data | your real build data | **fake seed** (`npm run db:seed`) | real user data |
| Files (R2 bucket) | `caishen-dev` | `caishen-dev` | `caishen-prod` |
| Auth | custom JWT | custom JWT | custom JWT |

Moving build → test → prod is a one-line `DATABASE_URL` swap (+ `pg_dump`/`pg_restore` to carry
data, + `initSchema()` rebuilds tables). **The seamless AWS RDS/Aurora move is built in**
precisely because we did NOT adopt Supabase Auth/Storage/RLS — those are Supabase-proprietary
and would lock you in (RDS has no Auth/Storage/PostgREST). Staying backend-mediated + raw `pg`
keeps the database a swappable commodity.

**Why not the full Supabase CLI local stack (Option A)?** It requires **Docker** (not
installed here), and the only piece your app would use from it is the **Postgres** — which
you already run locally. Supabase Studio/Auth/Storage/RLS aren't wired into the app. So
Option B gives you Supabase-in-prod + a safe local DB with **zero new heavy dependencies**.

**When to graduate to Option A (local Supabase CLI):** only if you decide to adopt
Supabase **Auth**, **Storage**, or **RLS** (i.e. let the browser talk to Supabase directly).
That's a real migration of `auth.js` and `r2.js` — see "Future: going Supabase-native" below.

> **This is also your Neon fix.** Hosted Supabase Postgres is a drop-in replacement for the
> dead Neon: point production's `DATABASE_URL` at the Supabase connection string and `pg`
> connects exactly the same way (`initSchema` rebuilds the tables on first boot).

---

## How environments are wired

`server/index.js` loads env in this order (later wins):

1. `.env`        — committed-shape defaults; on the server this holds **production** values.
2. `.env.local`  — gitignored **dev overrides**; this is where your **local** `DATABASE_URL` lives.

So you do **not** need `.env.development` / `.env.production` files — the app doesn't read
them. The two-file override model already separates dev from prod. `.env.example` documents
every variable.

### The safety guard (so dev/testing can never hit production)

`core/db.js` logs the active DB on startup (no secrets) and protects an **explicit** production
host — so hosted Supabase stays a valid build DB while your real prod (RDS/Aurora) is guarded:

- Set **`PROD_DB_HOST`** to your production DB host (e.g. `xxx.rds.amazonaws.com`).
- Any process with **`NODE_ENV != production`** pointed at that host → **refuses to start**.
- **`NODE_ENV = production` + a local host** → loud warning.
- Always logs: `[DB] env=development → remote db @ db.<ref>.supabase.co`.
- Until you set `PROD_DB_HOST` there is no prod to guard, so build/test just run and log.

Escape hatch for an intentional exception: `DB_ALLOW_UNSAFE=1`.

---

## Local development (Option B — recommended, what you have today)

You already run a local Postgres. Put its URL in **`.env.local`**:

```bash
# .env.local  (gitignored)
NODE_ENV=development
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/caishen
R2_BUCKET=caishen-dev          # a SEPARATE bucket so local uploads never touch prod files
```

Then:

```bash
npm install
npm run db:seed     # create fake user + accounts + txns + receipt + mortgage (LOCAL only)
npm start           # or: npm run dev   (nodemon)
```

`initSchema()` runs on boot and creates any missing tables, so a fresh local DB is ready
with no manual migration step. **Login:** `dev / dev1234`.

`npm run db:seed` refuses to run unless `DATABASE_URL` is local, and is idempotent
(deterministic `dev_*` ids), so re-run it anytime. To wipe and reseed, drop/recreate the
local database, then `npm run db:seed`.

### Optional: the local Supabase CLI stack (Option A)

Only worth it if you want Supabase Studio or plan to adopt Supabase Auth/Storage/RLS.
Requires **Docker Desktop** + the **Supabase CLI**:

```bash
# one-time
winget install Supabase.CLI        # or: scoop install supabase
supabase init                      # generates supabase/config.toml
supabase start                     # boots local Postgres (:54322) + Studio + emulators (needs Docker)
# then point the backend at it:
#   .env.local → DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
supabase stop
supabase db reset                  # wipe + re-apply migrations/seed
```

The backend connects to that local Postgres exactly like any other (`pg` + `DATABASE_URL`).

---

## Deploying / hosted database (Supabase now → RDS/Aurora later)

Same connection mechanism for any hosted Postgres — only the URL changes.

**Hosted Supabase (today's build / deploy DB):**
1. Create a Supabase project (or use your existing one).
2. **Project Settings → Database → Connection string → "URI"** — use the **session pooler**
   URI for a long-lived Node server.
3. Set it as `DATABASE_URL` where the app runs. For mycaishen.ai (a droplet under PM2 — see
   `deploy.sh`), edit `/var/www/caishen/.env`:
   ```bash
   DATABASE_URL=postgresql://postgres:[PASSWORD]@db.[ref].supabase.co:5432/postgres
   R2_BUCKET=caishen-prod
   ```
   then `pm2 restart caishen`. `initSchema()` builds the tables on first boot.

**Later — AWS RDS / Aurora PostgreSQL (real production):**
1. Create the instance; set `DATABASE_URL=postgresql://USER:[PW]@xxxx.rds.amazonaws.com:5432/caishen`.
2. Set `NODE_ENV=production` and `PROD_DB_HOST=xxxx.rds.amazonaws.com` (turns on the dev→prod guard).
3. Carry data over once: `pg_dump -Fc "$SUPABASE_URL" > dump.pgc && pg_restore -d "$RDS_URL" dump.pgc`.
4. `pm2 restart caishen`. Nothing else changes — no code, no driver, no auth/storage rework.

SSL is automatic: `core/db.js` enables SSL for any non-local host.

---

## Schema & migration workflow

**`initSchema()` (in `core/db.js` → `core/db-*-schema.js`) is the source of truth.** It's a
forward-only, **idempotent** set of `CREATE/ALTER … IF NOT EXISTS` statements that runs on
every boot, so local and hosted schemas converge automatically when you deploy the code.

This is deliberately **not** layered with Supabase's SQL-migration system — running two
schema authorities would let them drift. To change the schema:

1. Edit the relevant `server/core/db-*-schema.js` (add a `CREATE TABLE IF NOT EXISTS` /
   `ALTER TABLE … ADD COLUMN IF NOT EXISTS`).
2. Restart locally → `initSchema()` applies it. Test with seed data.
3. Commit the schema-file change.
4. Deploy → `initSchema()` applies it to hosted Supabase on boot.

Rules: changes must be **additive** (new tables/columns/indexes). Never rename/drop in place;
add-new + backfill + stop-reading-old instead, so a rolling deploy never breaks.

> Want a versioned SQL paper trail too? You can snapshot the live schema with the Supabase
> CLI (`supabase db dump --schema public -f supabase/migrations/<ts>_baseline.sql`) for
> review/history — but keep `initSchema()` as the thing that actually applies schema, to
> avoid a competing system.

---

## File storage (Cloudflare R2)

Files (statement/receipt/mortgage PDFs, receipt images, 1098s) live in **R2**; the
`documents` table holds metadata + the object key (`core/r2.js`, `core/documents.js`).
Downloads use short-lived signed URLs — files are never public.

- **Dev vs prod isolation:** use a **separate R2 bucket per environment** — `R2_BUCKET=caishen-dev`
  in `.env.local`, `caishen-prod` in production. Local uploads then never touch prod files.
- If `R2_*` is unset in dev, file features that need bytes are simply disabled (the metadata
  rows still work), so you can develop most of the app without R2 configured.
- **CSVs are legacy/export artifacts only** — never the source of truth. The audit CSVs are
  already gated behind `DEBUG_AUDIT_CSV`; the real data lives in `transactions` /
  `source_transactions`.

---

## Security: keys & (future) RLS

- **Service role / DB password is backend-only.** `DATABASE_URL`, `R2_SECRET_ACCESS_KEY`,
  `JWT_SECRET`, `FIELD_ENCRYPTION_KEY` live only in the server `.env` — never shipped to the
  client. The React app receives **no** Supabase keys because it never talks to Supabase.
- **RLS is currently N/A.** Row-level security protects *direct* client→database access. CaiShen's
  browser only calls the Express API, which enforces per-user scoping in code (every query is
  `WHERE user_id = $1` from the JWT). So there is no anon-key surface to lock down today.
- **If you later expose Supabase directly to the browser** (Supabase Auth + anon key), you
  MUST add RLS `USING (auth.uid() = user_id)` policies on every per-user table
  (`accounts`, `transactions`, `receipts`, `mortgage_*`, …) before doing so. Until then,
  the backend-as-gatekeeper model is the security boundary.

### Never copy prod → local without sanitizing

Local seed data is **synthetic only** (`npm run db:seed`). Do not dump real production rows
into local: real account numbers, balances, and PII must not land in a dev DB or seed file.
If you ever must reproduce a prod issue locally, export a **sanitized** subset (mask names,
emails, `mask`/last-4, amounts) first.

---

## Command cheat-sheet

```bash
# Local dev
npm run db:seed        # seed fake data into the LOCAL db (guarded; idempotent)
npm run db:status      # print the active DATABASE_URL (password masked) + env
npm start              # run the server (uses .env.local override → local Postgres)
npm test               # jest suite

# Production (on the droplet)
grep DATABASE_URL /var/www/caishen/.env     # see what prod points at
nano /var/www/caishen/.env                  # set DATABASE_URL → hosted Supabase
pm2 restart caishen                         # reboot → initSchema builds tables
pm2 logs caishen --lines 30                 # confirm "[DB] env=production → ..." + "server running"

# Optional Supabase CLI local stack (Option A — needs Docker)
supabase init && supabase start
supabase stop
supabase db reset
```

---

## Future: going Supabase-native (only if you want it)

Adopting Supabase Auth/Storage/RLS is a real migration, not a config flip:

1. **Auth:** replace `core/auth.js` (JWT + bcrypt + 2FA/device-trust) with Supabase Auth;
   re-issue sessions; migrate the `users` table to `auth.users`. Significant.
2. **Storage:** swap `core/r2.js` for Supabase Storage buckets + policies (or keep R2 — it's
   cheaper egress and already works).
3. **RLS:** add `USING (auth.uid() = user_id)` policies on every per-user table, and move
   some reads to the client via the anon key.

Recommendation: **stay backend-mediated for now** (custom auth + R2 + Supabase Postgres).
It's secure, it's working, and it gets you off Neon today with the least risk.

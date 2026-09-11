# STANDIN API — scalable backend for the humans-on-demand marketplace

Stateless Express API. Zero-dependency demo by default, Postgres/Redis/Stripe
scale path without changing routes.

```
browser (index.html + api-bridge.js)
   │  REST + SSE
   ▼
Express API (stateless — scale replicas freely)
   ├── JSON file store (demo, 1 replica) ──► Postgres (multi-replica) via DATABASE_URL
   ├── in-process events/queue ─────────────► Redis pub/sub + BullMQ via REDIS_URL
   ├── local /uploads ──────────────────────► S3 presigned URLs via S3_BUCKET
   └── demo billing ────────────────────────► Stripe PaymentIntents + webhook
```

## Quickstart (2 minutes, no Docker)

```bash
cd backend
cp .env.example .env   # optional; works with zero config
npm install
npm test               # full escrow lifecycle test, must be green
npm run dev            # → http://localhost:3001
```

Then open `../index.html` — if the API is up, job posts and the live feed
sync through it (graceful fallback to local demo data when offline).

Health: `GET /health` → `{ ok, store: "json"|"postgres" }`
Docs: `GET /api/docs` (human) and `GET /api/openapi.json` (machine).

## Core flows

| Flow | Calls |
|---|---|
| Ask | `POST /auth/register` → `POST /jobs` (server prices it, escrow `hold`) |
| Earn | `POST /doers/profile` → `POST /doers/verify` → `POST /jobs/:id/claim` |
| Deliver | `POST /jobs/:id/deliver {videoUrl}` → asker `POST /jobs/:id/approve` → `release` 80% + `fee` 20% |
| Refund | `POST /jobs/:id/cancel` (open only) → `refund` |
| Live | `GET /jobs/feed?cursor=&limit=` + `GET /stream` (SSE) |
| Monetize | `POST /billing/plus/checkout` → plan `plus`; `POST /business/keys` for B2B |
| Moderate | Every post is scanned (NSFW/contact/meetup/violence/links → 422 with a reason; shouty/bait → flagged for owner review) |

## Payouts (how doers get paid)

1. Asker pays → escrow `hold`. Approval releases 80% to the doer's **balance** (ledger), 20% fee to you.
2. Doer connects a bank: `POST /api/v1/doers/connect` — Stripe Connect Express onboarding in production (KYC included), instant demo connection locally. Status at `GET /api/v1/doers/connect/status`.
3. Cash-out: `POST /api/v1/payouts/request` pays the full available balance ($5 floor). With Stripe live it executes a real `Transfer` to the connected account; otherwise it records a `queued` IOU with identical math.
4. Friday batch: `node scripts/payouts.js` reports who is owed; add `--execute` to move money. Schedule weekly via cron. Double-pay is impossible: the debit rechecks the balance under a row lock (Postgres) before inserting.
5. Owners watch everything at `GET /api/v1/admin/payouts` and the ledger.

Going live with real money: set `STRIPE_SECRET`, enable Connect in the Stripe dashboard, run payouts in Stripe **test mode** first (clockwork: test transfers, test onboarding), and keep the $5 floor so fees never eat a payout.

Money rules enforced server-side:
- Client never sets prices — category menu + rush flag only.
- State machine `open → claimed → delivered → paid`, `open → refunded`, with compare-and-set transitions (409 on races).
- Every money move appends to an immutable ledger (`hold/release/refund/fee`).
- `Idempotency-Key` header on `POST /jobs` and checkout — replays never double-charge.

## Scale path

- **Postgres**: `psql $DATABASE_URL -f migrations/001_init.sql -f migrations/002_roles.sql -f migrations/003_reports.sql -f migrations/004_payouts.sql`. `npm i pg`, set `DATABASE_URL`. Includes feed cursor index, per-asker `clientId` dedupe, `FOR UPDATE` transitions + payout debit locking.
- **Redis**: set `REDIS_URL` — swap `src/lib/events.js` fan-out to pub/sub and `src/lib/queue.js` to BullMQ (interfaces already isolated to those two files).
- **Files**: set `S3_BUCKET` — swap `misc.js` presign to S3 presigned POSTs (response shape unchanged).
- **Stripe**: set `STRIPE_SECRET` (+ webhook secret) — checkout creates real PaymentIntents; plan flips on in `/billing/webhook`. Test with `stripe listen --forward-to localhost:3001/api/v1/billing/webhook`.
- **Deploy**: `docker compose up --build` (api + postgres + redis). Replicas are stateless — put them behind any load balancer with sticky SSE.

## Owner console + moderation

- `admin.html` (linked in the site footer) is locked to admins: stats (GMV, fees, open/paid, users, doers), all jobs with refund/reopen moderation, user search with promote/demote, and the full money trail. Auto-refreshes every 20s.
- Become an owner: register on the site, then `npm run make-admin -- you@email.com`. Or set `ADMIN_EMAILS=you@email.com` to auto-promote on first visit. API under `/api/v1/admin/*` (see `/api/docs`).
- Passwords: set at registration (8+ characters). Change anytime in the console's Owner account card, or `POST /api/v1/auth/password` with the current password — there is no separate admin password, and no passwords are ever stored in readable form (bcrypt hashes only).

## Deploy to Vercel

The repo root is deployment-ready: static pages served by Vercel, `/api/*` routed to `api/index.js` (same Express app), internals under `/backend/*` return 404.

1. Provision Postgres (Neon, Vercel Postgres, or Supabase — serverless needs the **pooled/transaction-mode** connection string) and apply all migrations in order:
   `for f in 001_init 002_roles 003_reports 004_payouts 006_job_details 007_rls_lockdown; do psql $DATABASE_URL -f migrations/$f.sql; done`
   (or locally: `npm run migrate:pg` — applies schema + moves JSON data; `005_app_role` separately with your own password)
2. `vercel` from the repo root (root `package.json` workspaces install `backend/` deps).
3. Env vars in the Vercel dashboard: `DATABASE_URL`, `JWT_SECRET` (long random), `ADMIN_EMAILS=you@email.com`.
4. Open `https://your-app.vercel.app/admin.html`, log in — you're auto-promoted. Prefer explicit: `DATABASE_URL=... npm run make-admin -- you@email.com`.
5. Notes: the JSON store is refused on Vercel (ephemeral FS — boot errors clearly without `DATABASE_URL`); uploads need `S3_BUCKET` in production (local `/uploads` don't persist serverless).

## Security protocol

Threat model, input-handling rules, and probes live in `SECURITY.md`:

```bash
npm run pentest  # sqli battery, auth matrix, alg-confusion, headers, limits
npm run stress   # throughput + p95 + exactly-once claim race
```

## Security notes

- bcrypt passwords, short-lived JWTs, rate limits on auth + writes, helmet headers, zod validation on every input, API keys stored hashed (shown once).
- Demo login in the static frontend is name-only; the API itself requires email + password — the bridge auto-provisions a device account and documents the upgrade.
- `qs` is pinned past the GHSA-x5fp / GHSA-4mjr advisories via an `overrides` entry (`npm audit` clean); keep it on dependency updates.
- Styling is compiled locally (`npm run css` → `../styles.css`, `npm run css:watch` while designing) — pages carry no Tailwind CDN dependency, and motion/images degrade gracefully when third-party CDNs are blocked.

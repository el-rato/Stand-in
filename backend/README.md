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

Money rules enforced server-side:
- Client never sets prices — category menu + rush flag only.
- State machine `open → claimed → delivered → paid`, `open → refunded`, with compare-and-set transitions (409 on races).
- Every money move appends to an immutable ledger (`hold/release/refund/fee`).
- `Idempotency-Key` header on `POST /jobs` and checkout — replays never double-charge.

## Scale path

- **Postgres**: `psql $DATABASE_URL -f migrations/001_init.sql`, `npm i pg`, set `DATABASE_URL`. Includes feed cursor index, per-asker `clientId` dedupe, `FOR UPDATE` transitions.
- **Redis**: set `REDIS_URL` — swap `src/lib/events.js` fan-out to pub/sub and `src/lib/queue.js` to BullMQ (interfaces already isolated to those two files).
- **Files**: set `S3_BUCKET` — swap `misc.js` presign to S3 presigned POSTs (response shape unchanged).
- **Stripe**: set `STRIPE_SECRET` (+ webhook secret) — checkout creates real PaymentIntents; plan flips on in `/billing/webhook`. Test with `stripe listen --forward-to localhost:3001/api/v1/billing/webhook`.
- **Deploy**: `docker compose up --build` (api + postgres + redis). Replicas are stateless — put them behind any load balancer with sticky SSE.

## Security notes

- bcrypt passwords, short-lived JWTs, rate limits on auth + writes, helmet headers, zod validation on every input, API keys stored hashed (shown once).
- Demo login in the static frontend is name-only; the API itself requires email + password — the bridge auto-provisions a device account and documents the upgrade.

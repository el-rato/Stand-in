# STANDIN — pay a human anywhere $3 to do it on camera

A complete, scalable marketplace product: marketing site, asker dashboard,
doer dashboard, and a stateless API with escrow — one deployable unit.

## Run the whole product (1 command)

```bash
cd backend
npm install
npm run seed   # demo users (ana@seed.io, ben@seed.io / password123) + live orders
npm run dev    # → http://localhost:3001 serves site + API together
```

Open `http://localhost:3001` — the site talks to the API on the same origin.
Opening the HTML files directly (`file://`) also works: every page falls back
to device-local demo state when the backend is unreachable.

## Pages

| Page | Who | What |
|---|---|---|
| `index.html` | Everyone | Marketing, live job feed, price builder, real account auth, checkout, My Jobs |
| `orders.html` | Askers (login-gated) | Order pipeline, escrow totals, approve/cancel/reorder, cross-device sync |
| `doer.html` | Verified doers only | Open order pool, claim → deliver (URL or real file upload) → payout, earnings |
| `admin.html` | Owners only | GMV/fees/users stats, job moderation, roles, money trail |
| `api-bridge.js` | Shared | Backend client with graceful offline fallback (no build step) |
| `styles.css` | Shared | Compiled Tailwind (built via `npm run css` in `backend/`) — no CSS CDN needed |

Demo loop on one machine: post a job on the site → claim it in Doer HQ →
deliver → approve from Orders (or My Jobs) → earnings update everywhere.

## Host on Vercel + watch it

1. Postgres (Neon/Vercel Postgres): apply migrations `001`–`004`, `006`, `007` in order (`005` separately with your own password) — or run `npm run migrate:pg` from `backend/` to do schema + data in one shot.
2. `vercel` from this folder. Set env: `DATABASE_URL`, `JWT_SECRET`, `ADMIN_EMAILS=you@email.com`.
3. Register on the live site, then open `/admin.html` — you're auto-promoted. Lock it down explicitly with `npm run make-admin`.
4. Full steps + caveats (ephemeral FS, uploads need S3) in `backend/README.md`.

## API (`backend/` — details in `backend/README.md`)

- Auth (bcrypt + JWT), jobs state machine (`open → claimed → delivered → paid`, `open → refunded`), immutable escrow ledger, server-side pricing, idempotency keys
- Doer verification, Standin+ billing (demo now, Stripe path ready), B2B API keys, upload presigning, SSE live stream, cursor-paginated feed
- `npm test` — 11 end-to-end escrow tests, must stay green
- Scale path: `DATABASE_URL` → Postgres (migration included, `FOR UPDATE` transitions), `REDIS_URL` → pub/sub + queue, `docker compose up --build`

## Trust model (demo)

Browser pages keep device-local state as an offline-first cache; the backend
is authoritative for price, transitions, and money whenever reachable. The
device account is auto-verified against the backend only after the human
passes the product verification gate. Production hardening checklist:
per-doer vendor KYC webhook, Stripe transfers for payouts, S3 media + safety
scans, refresh-token rotation, audit log shipping.

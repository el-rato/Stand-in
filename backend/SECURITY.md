# STANDIN security protocol

Threat model: public marketplace API handling money-adjacent state (escrow
ledger, payouts). Attackers are anonymous internet users; doers/askers are
untrusted input sources. Admins are trusted but authenticated.

## Standing controls

| Layer | Control | Where |
|---|---|---|
| Injection | Parameterized queries only — no user input is ever string-interpolated into SQL (both stores) | `src/store/*` |
| Injection | Status filters are enum-allowlisted; unknown values 400 | `routes/jobs.js`, `routes/admin.js` |
| Injection | zod schemas on every mutating input (lengths, emails, URLs, enums) | all routes |
| Abuse content | NSFW/contact/meetup/violence/link posts rejected 422; shouty/bait flagged for review (server-side, client pre-scan is UX only) | `lib/moderate.js` |
| Injection | Cursor length caps; 256kb bodies; 2048-char URL cap | routes, `middleware/waf.js` |
| Auth | bcrypt (cost 10), JWT HS256 with pinned `algorithms`, 7d TTL | `middleware/auth.js` |
| Auth | Dummy-hash compare on unknown emails (no user-enumeration timing) | `routes/auth.js` |
| Auth | Roles in DB; admin routes 403 otherwise; no self-demote | `middleware/auth.js`, `routes/admin.js` |
| Auth | Boot refuses weak/missing `JWT_SECRET` in production | `lib/guards.js` |
| Abuse | 20/min auth, 120/min writes + admin; idempotency keys on money POSTs | `src/app.js` |
| WAF | In-app firewall: scanner paths 404'd silently, hostile query patterns 403'd + logged (outer wall: Vercel Firewall/Cloudflare in prod) | `middleware/waf.js` |
| Browser | Explicit CSP (inline scripts allowed by design; CDNs allowlisted), nosniff, frame-ancestors, HSTS in production, no `x-powered-by` | `src/app.js` |
| TLS | Automatic certificates on Vercel; local dev stays loopback-http (never expose dev publicly — use a tunnel) | deploy docs below |
| Money | Server-side pricing, CAS state machine, append-only ledger | `lib/pricing.js`, `routes/jobs.js` |
| Money | Atomic payout debits (recheck-under-lock, $5 floor, no double-pay) | `lib/payouts.js`, stores |
| Output | API is JSON-only (XSS payloads stay inert data); pages HTML-escape all rendered strings | `api-bridge.js`, page `esc()` |
| Errors | `{error:{code,message}}` envelopes; 500s never leak stacks to clients | `middleware/errors.js` |
| Backups | `npm run backup` (JSON, 14-day rotation) + daily `pg_dump` GitHub workflow + provider PITR + one-click admin export | `scripts/backup.js`, `.github/workflows/daily-backup.yml` |
| Deps | `npm audit` clean; `qs` pinned past GHSA advisories via `overrides` | `package.json` |
| DB access | App-only least-privilege role (`SELECT/INSERT/UPDATE`, no DDL/DELETE); RLS on with app-only policy | `migrations/005_app_role.sql`, `007_rls_lockdown.sql` |

## A note on Row Level Security (Supabase)

RLS only *enforces* anything when **untrusted clients talk to the database
directly** (Supabase's Data API). In this product they never do: browsers
talk to Express, which enforces JWT auth + roles. So RLS is not our lock —
it is our alarm system plus a safety net:

- `007_rls_lockdown.sql` enables RLS on every table with a single
  `app_full_access` policy for the app role. Anonymous/anyone else matches
  no policy, which in Postgres means **deny** — so if a table ever gets
  exposed via the Data API or a grant by accident, outsiders still see zero
  rows instead of everything.
- The migration role (table owner) bypasses RLS, so the running app is
  unaffected. The `standin_app` role keeps working through its policy.
- Re-check anytime: `npm run check:rls` (all tables should read RESTRICTED).

## Input-handling rules (contributors)

1. Validate at the edge with zod before touching the store.
2. Never build SQL from strings — placeholders + allowlists only.
3. Never trust client prices, roles, or statuses — recompute server-side.
4. Never return `passHash`, raw API keys, or stack traces.
5. Frontend renders with `esc()`; `innerHTML` with unescaped data is a bug.

## Run the probes

```bash
npm run pentest  # ~30 checks: sqli battery, auth matrix, alg-confusion,
                 #   headers, body limits, malformed JSON, rate-limit proof
npm run stress   # feed/post throughput + p50/p95 + exactly-once claim race
npm test         # 15 functional tests incl. transitions + admin + password
```

`RATE_LIMIT_DISABLED=1` exists so load scripts measure the app, not the
limiter. It is test-only: grep CI for it and fail the build if ever set in
prod env.

## Pre-deploy checklist

- [ ] `JWT_SECRET` ≥ 32 random chars (boot refuses weak ones in prod); `ADMIN_EMAILS` set; `DATABASE_URL` + both migrations applied
- [ ] TLS: Vercel provisions the certificate automatically — verify `https://` + HSTS header live; never expose local `npm run dev` publicly
- [ ] Outer WAF on (Vercel Firewall or Cloudflare) in front of the in-app `wafLite`
- [ ] Backups flowing: daily workflow green (artifact present), provider PITR enabled, one manual admin export downloaded
- [ ] `STRIPE_WEBHOOK_SECRET` set if `STRIPE_SECRET` is (else webhooks 400)
- [ ] `S3_BUCKET` set (serverless uploads don't persist)
- [ ] `npm audit` clean, `npm run pentest` + `npm test` green against a staging DB
- [ ] Logs ship somewhere (morgan output); alert on 5xx rate + failed-login bursts

## Disclosure

Found something? Email the repo owner with steps to reproduce against
`npm run pentest` style output. Do not test against the production deploy
without written permission.

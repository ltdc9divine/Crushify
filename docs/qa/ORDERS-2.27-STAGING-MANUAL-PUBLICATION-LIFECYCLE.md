# ORDERS-2.27 — Staging Manual Publication Lifecycle

**Verdict: PARTIAL.** The Preview-only manual lifecycle route and expiry/retention safeguards are implemented and pass local synthetic tests. Preview operator-secret configuration and deployed Preview behavior remain unverified; no remote lifecycle operation was performed.

> **ORDERS-2.28 authorization clarification:** The original implementation and test evidence below used `CRON_SECRET`. It has been superseded: the Preview route now requires the dedicated `STAGING_LIFECYCLE_SECRET`; `CRON_SECRET` alone is not accepted. The remote Preview variable remains unverified.

## Objective and scope

- Add a manually invoked publication lifecycle endpoint for Vercel Preview only.
- Preserve the existing Production Cron schedule and lifecycle behavior.
- Keep Preview customer authentication disabled.
- Do not create or settle payments, fulfill orders, modify Production configuration, run migrations, or access remote providers.

## Initial and final Git refs

- Initial/final branch: `main`
- Initial/final `HEAD`: `84acc4c19a143805830495671e076bbc395db3e3`
- Initial worktree: no staged files; 24 modified tracked files and 6 untracked files. Initial `git diff --check` passed.
- Final worktree: no staged files; 27 modified tracked files and 7 untracked files. Final `git diff --check` passed.
- No commit, push, merge, or deployment was performed.

### Baseline worktree inventory

Pre-existing modified tracked paths:

`.env.example`, `README.md`, `docs/API_SPECIFICATION.md`, `docs/DATABASE_SCHEMA.md`, `docs/HOSTING_MIGRATION.md`, `docs/PAYMENT_FLOW.md`, `docs/SECURITY_PLAN.md`, `docs/SEPAY_SETUP.md`, `docs/VERCEL_STAGING.md`, `scripts/staging-config.ts`, `scripts/staging-turso.ts`, `src/auth.ts`, `src/payments.ts`, `src/platform/vercel.ts`, `src/publications.ts`, `src/storage/cloudinary-policy.ts`, `tests/database-contract.test.ts`, `tests/payment-contract.mjs`, `tests/payments.test.ts`, `tests/pre-staging-security.test.ts`, `tests/staging-config.test.ts`, `tests/storage.test.ts`, `tests/vercel.test.ts`, and `tests/worker.test.ts`.

Pre-existing untracked paths:

`docs/qa/ORDERS-2.23-TURSO-STAGING-DATABASE-ISOLATION.md`, `docs/qa/ORDERS-2.24-CLOUDINARY-STAGING-ISOLATION.md`, `docs/qa/ORDERS-2.25A-PREVIEW-AUTH-GATE-REMEDIATION.md`, `docs/qa/ORDERS-2.26-PREVIEW-MOCK-PAYMENT-ISOLATION.md`, `src/payments/policy.ts`, and `tests/auth-environment.test.ts`.

### Final worktree inventory

Modified tracked paths:

`.env.example`, `README.md`, `docs/API_SPECIFICATION.md`, `docs/DATABASE_SCHEMA.md`, `docs/HOSTING_MIGRATION.md`, `docs/PAYMENT_FLOW.md`, `docs/PUBLICATION_AND_DELIVERY.md`, `docs/SECURITY_PLAN.md`, `docs/SEPAY_SETUP.md`, `docs/VERCEL_STAGING.md`, `scripts/staging-config.ts`, `scripts/staging-turso.ts`, `src/auth.ts`, `src/payments.ts`, `src/platform/vercel.ts`, `src/publications.ts`, `src/storage/cloudinary-policy.ts`, `tests/database-contract.test.ts`, `tests/payment-contract.mjs`, `tests/payments.test.ts`, `tests/pre-staging-security.test.ts`, `tests/publications.test.ts`, `tests/scheduler.test.ts`, `tests/staging-config.test.ts`, `tests/storage.test.ts`, `tests/vercel.test.ts`, and `tests/worker.test.ts`.

Untracked paths:

`docs/qa/ORDERS-2.23-TURSO-STAGING-DATABASE-ISOLATION.md`, `docs/qa/ORDERS-2.24-CLOUDINARY-STAGING-ISOLATION.md`, `docs/qa/ORDERS-2.25A-PREVIEW-AUTH-GATE-REMEDIATION.md`, `docs/qa/ORDERS-2.26-PREVIEW-MOCK-PAYMENT-ISOLATION.md`, `docs/qa/ORDERS-2.27-STAGING-MANUAL-PUBLICATION-LIFECYCLE.md`, `src/payments/policy.ts`, and `tests/auth-environment.test.ts`.

## Operator authorization and route inventory

- `POST /api/ops/staging/publication-lifecycle` is the dedicated manual Preview trigger. It requires `VERCEL_ENV=preview` paired with `ENVIRONMENT=staging`, and a bearer `STAGING_LIFECYCLE_SECRET` of exactly 64 hexadecimal characters. It uses the existing constant-time comparison helper and never falls back to `CRON_SECRET`.
- The handler checks runtime scope before authorization and checks authorization before storage initialization or database connection. It rejects request bodies and query parameters; callers cannot select an environment, operation, or batch size.
- The route validates the current deployment origin, staging-only Turso credentials, and mock storage before connecting. It runs only `runScheduledPublicationLifecycle` with a fixed limit of 10 and returns only the lifecycle summary.
- `GET /api/cron/publication-lifecycle` is now Production-only. Its Production bearer check, lifecycle operation, and daily `vercel.json` schedule are unchanged. Preview has no scheduled Cron.
- Production, local Vercel development, and unknown/mismatched scopes receive 404 from the manual route before any DB/storage initialization. The legacy Worker rejects staging before DB access; it does not expose this Vercel operator route.
- The Preview secret must be independently generated and configured only in Vercel's Preview scope. Its current presence and deployed behavior were not checked. If missing or invalid, the route fails closed.

## Environment isolation matrix

| Runtime | Lifecycle entry point | Result |
|---|---|---|
| Vercel Production | Existing authenticated Cron GET | Preserved; Production only |
| Vercel Preview/staging | Authenticated manual POST | Allowed only with exact trusted Preview/staging classification and valid bearer secret |
| Local development | None | Manual route rejected; local synthetic lifecycle tests remain available |
| Legacy Worker staging | None | Rejected before database access |
| Unknown or ambiguous | None | Rejected before database access |

Preview continues to use its dedicated Turso staging credentials and mock storage. It never falls back to Production database credentials or origin. Preview customer authentication remains disabled. No payment or fulfillment route was changed.

## Lifecycle behavior and protections

- Publications expire at `expires_at <= now`; active finite storage entitlements transition to `EXPIRED`, and a configured retention deadline is recorded. Lifetime entitlements remain excluded.
- Public reads return HTTP 410 for expired publications, while non-expired publications continue to serve.
- Retention cleanup remains bounded and retryable. Pending/paid/fulfilling orders and active or still-retained publications defer destructive cleanup. A new check also defers cleanup when a source asset is referenced by another active/retained publication, including cross-design references.
- Shared-asset deferral leaves the source asset and derivative objects intact and reports the item as retryable.
- Lifecycle code does not create publications, mutate payment records, invoke payment-provider APIs, or send customer email. Tests verify an awaiting-payment order remains unpaid and gains no publication.
- The existing Production Cron synthetic test still covers expiry, retention cleanup, media deletion failure/retry, and repeat execution. Production schedule configuration was not changed.

## Tests and evidence

Focused lifecycle tests:

- `node --experimental-strip-types --test tests/scheduler.test.ts tests/publications.test.ts tests/worker.test.ts`
- **29 passed, 0 failed** across the focused files.

Quality gates:

- `npm run typecheck` — passed.
- `npm test` — **140 passed, 0 failed; 27 suites**.
- `npm run test:integration` — passed. The inspected harness starts Wrangler in local mode, uses loopback HTTP and temporary local D1 state, and cleans up its temporary data. No remote endpoint is invoked.
- `git diff --check` — passed.

Specific regression evidence:

- Unauthorized/invalid requests, caller-supplied body/query options, Production/local/unknown scope attempts, and Preview production-credential conflicts do not connect to the database. Unauthorized requests also do not initialize storage.
- An injected database trigger forces the expiry batch to fail: the route returns 503 and publication state remains unchanged. Removing the trigger allows retry to expire the record; another run is idempotent.
- Two simultaneous lease acquisitions produce exactly one lease owner.
- Expired public URL returns 410; a future publication remains readable.
- A source asset referenced by a different active publication is retained; source and derivative objects remain present.
- Order and payment rows are unchanged across manual lifecycle runs; an awaiting-payment order remains `AWAITING_PAYMENT`, no publication is created for it, and outbound-fetch/email spies remain at zero.
- Existing ORDERS-2.26 tests still verify Preview mock confirmation and fulfillment are unavailable, and staging fulfillment/recovery fail before database access.
- The Worker test supplies a synthetic operator token but still receives `STAGING_RUNTIME_DISABLED` with zero database access.

## Files changed for ORDERS-2.27

- `src/platform/vercel.ts` — separate Preview-only operator endpoint; existing Cron restricted to Production.
- `src/publications.ts` — defer retention cleanup for source assets referenced by active/retained publications.
- `tests/scheduler.test.ts` — authentication, scope, parameter rejection, storage/DB side-effect guards, and concurrent lease test.
- `tests/publications.test.ts` — manual route expiry/retry/idempotency, unpaid-order and payment-state preservation, public URL behavior, no external side effects, and shared-asset regression.
- `tests/worker.test.ts` — verify the staging Worker cannot use the Vercel-only route.
- `docs/VERCEL_STAGING.md` and `docs/PUBLICATION_AND_DELIVERY.md` — route, secret, scope, lifecycle, and remote-verification documentation.
- `docs/qa/ORDERS-2.27-STAGING-MANUAL-PUBLICATION-LIFECYCLE.md` — this report.

## Remaining risks and remote verification

- No remote Preview configuration or database identity was inspected during this task. An authorized owner must verify the dedicated Preview database and independently generate/configure `STAGING_LIFECYCLE_SECRET` in the Preview scope before using the endpoint.
- No deployed Vercel route, Preview secret, scheduled Production invocation, or real retention operation was verified. The manual route is locally tested only.
- ORDERS-2.26 remains PARTIAL: Preview mock settlement is unavailable and Production checkout/webhooks are disabled in the inspected baseline. This task did not attempt to resolve either payment limitation.
- No remote lifecycle operation, migration, payment, webhook, email, provider call, Vercel configuration change, commit, push, merge, or deployment occurred.

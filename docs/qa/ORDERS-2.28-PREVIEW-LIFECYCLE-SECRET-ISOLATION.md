# ORDERS-2.28 — Preview Lifecycle Secret Isolation

**Verdict: PARTIAL** — The local authorization contract and quality gates pass. The Preview environment's secret configuration and deployed endpoint remain unverified.

## Objective and scope

The Preview-only `POST /api/ops/staging/publication-lifecycle` endpoint now requires the dedicated `STAGING_LIFECYCLE_SECRET`. It does not fall back to Production's `CRON_SECRET`. Production Cron behavior, payment behavior, and lifecycle operations were not otherwise changed in this task.

## Git baseline and final state

| State | Branch | HEAD | Staged | Modified tracked files | Untracked files |
|---|---|---|---:|---:|---:|
| Initial | `main` | `84acc4c19a143805830495671e076bbc395db3e3` | 0 | 27 | 7 |
| Final | `main` | `84acc4c19a143805830495671e076bbc395db3e3` | 0 | 27 | 8 |

The initial tracked modifications were:

- `.env.example`, `README.md`
- `docs/API_SPECIFICATION.md`, `docs/DATABASE_SCHEMA.md`, `docs/HOSTING_MIGRATION.md`, `docs/PAYMENT_FLOW.md`, `docs/PUBLICATION_AND_DELIVERY.md`, `docs/SECURITY_PLAN.md`, `docs/SEPAY_SETUP.md`, `docs/VERCEL_STAGING.md`
- `scripts/staging-config.ts`, `scripts/staging-turso.ts`
- `src/auth.ts`, `src/payments.ts`, `src/platform/vercel.ts`, `src/publications.ts`, `src/storage/cloudinary-policy.ts`
- `tests/database-contract.test.ts`, `tests/payment-contract.mjs`, `tests/payments.test.ts`, `tests/pre-staging-security.test.ts`, `tests/publications.test.ts`, `tests/scheduler.test.ts`, `tests/staging-config.test.ts`, `tests/storage.test.ts`, `tests/vercel.test.ts`, `tests/worker.test.ts`

The initial untracked files were:

- `docs/qa/ORDERS-2.23-TURSO-STAGING-DATABASE-ISOLATION.md`
- `docs/qa/ORDERS-2.24-CLOUDINARY-STAGING-ISOLATION.md`
- `docs/qa/ORDERS-2.25A-PREVIEW-AUTH-GATE-REMEDIATION.md`
- `docs/qa/ORDERS-2.26-PREVIEW-MOCK-PAYMENT-ISOLATION.md`
- `docs/qa/ORDERS-2.27-STAGING-MANUAL-PUBLICATION-LIFECYCLE.md`
- `src/payments/policy.ts`
- `tests/auth-environment.test.ts`

The only additional untracked file at final state is this report. All pre-existing worktree changes were preserved. `HEAD` did not change.

## Files changed for ORDERS-2.28

- `src/platform/vercel.ts`
- `tests/scheduler.test.ts`
- `tests/publications.test.ts`
- `tests/worker.test.ts`
- `docs/VERCEL_STAGING.md`
- `docs/PUBLICATION_AND_DELIVERY.md`
- `docs/qa/ORDERS-2.27-STAGING-MANUAL-PUBLICATION-LIFECYCLE.md` — clarifies that its original shared-secret description was superseded
- `docs/qa/ORDERS-2.28-PREVIEW-LIFECYCLE-SECRET-ISOLATION.md` — this report

## Authorization design and environment matrix

The route still requires trusted runtime classification to be exactly Vercel Preview paired with staging. Its bearer token must be exactly 64 hexadecimal characters, and the configured and supplied values are checked with the existing constant-time comparison helper. Missing, empty, malformed, and incorrect credentials all receive the same generic unauthorized response.

| Runtime/request | Result | Database/storage access |
|---|---|---|
| Preview + staging + valid `STAGING_LIFECYCLE_SECRET` + POST without body/query | Allowed; existing lifecycle operation only | Only after authorization and configuration validation |
| Preview + staging + only `CRON_SECRET` | Rejected | None |
| Preview + staging + missing, empty, malformed, or wrong dedicated secret | Rejected | None |
| Production, local, Worker staging, or unknown runtime | Rejected by scope gate | None |
| GET or other unsupported method | Method rejected | None |
| Valid bearer with a body or query parameters | Request rejected | None |
| Body/query value attempting to provide authorization without a bearer token | Unauthorized | None |

The route accepts no caller-selected operation, batch size, or environment. Existing fixed lifecycle limits and behavior remain in place. The Production Cron route continues to use `CRON_SECRET` and its existing Production-only checks.

## Test evidence

All tests use synthetic credentials and local/mocked dependencies.

| Command | Result |
|---|---|
| `node --experimental-strip-types --test tests/scheduler.test.ts tests/publications.test.ts tests/worker.test.ts tests/vercel.test.ts` | 41 tests, 8 suites; 41 passed, 0 failed |
| `npm run typecheck` | Passed |
| `npm test` | 140 tests, 27 suites; 140 passed, 0 failed |
| `npm run test:integration` | Passed: local D1 API/payment contracts, legacy regression, constraints, and batch rollback |
| `git diff --check` | Passed at initial and final checks |

The authorization tests assert that invalid credentials, CRON-only authorization, wrong scopes, unsupported methods, and parameterized requests do not initialize database or storage dependencies. They also cover successful Preview authorization and rejection of the Production Cron path from Preview. The publication lifecycle tests retain synthetic Production Cron coverage and verify the Preview run leaves payment state untouched.

The integration runner was inspected before execution: it starts Wrangler in local mode, binds its test API and email sink to loopback, uses a temporary local persistence directory, and removes that directory afterward. No remote payment, mail, or database endpoint was used.

## Production compatibility

The Production Cron endpoint still validates `CRON_SECRET` through the pre-existing `secureSecretMatch` helper and still rejects non-Production runtime classifications. Focused lifecycle, authorization, and Vercel adapter tests passed, including authenticated Production Cron lifecycle execution. No Production payment, webhook, or fulfillment code was changed for this task.

## Remote configuration and remaining verification

An authorized owner must independently generate a 32-byte random value, encode it as 64 hexadecimal characters, and configure it as `STAGING_LIFECYCLE_SECRET` in the Vercel Preview environment only. It must not be copied from or reused as `CRON_SECRET`.

The remote variable's presence, distinctness, Preview deployment configuration, and deployed endpoint behavior were not inspected or verified. Do not use the endpoint until the owner verifies that Preview is isolated to its staging database and the dedicated secret is configured in the Preview scope.

## Safety confirmation

No remote services, Production resources, environment variables, or secrets were inspected. No migrations, real/external payment requests or links, external webhooks, deployments, commits, pushes, or merges were performed.

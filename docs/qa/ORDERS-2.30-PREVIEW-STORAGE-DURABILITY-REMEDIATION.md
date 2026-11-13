# ORDERS-2.30 — Preview Storage Durability & Fail-Closed Remediation

**Verdict: PARTIAL.** Vercel Preview no longer constructs ephemeral mock storage or reports media operations as successful. Operations requiring durable media fail closed. A separate durable staging provider is not approved or configured, and no remote configuration was inspected.

## 1. Initial Git baseline

Recorded before code changes:

- Branch: `main`
- HEAD: `84acc4c19a143805830495671e076bbc395db3e3`
- Staged paths: none
- Modified tracked paths: 27
- Untracked paths: 9
- Initial `git diff --check`: passed

The pre-existing modified tracked paths were:

`.env.example`, `README.md`, `docs/API_SPECIFICATION.md`, `docs/DATABASE_SCHEMA.md`, `docs/HOSTING_MIGRATION.md`, `docs/PAYMENT_FLOW.md`, `docs/PUBLICATION_AND_DELIVERY.md`, `docs/SECURITY_PLAN.md`, `docs/SEPAY_SETUP.md`, `docs/VERCEL_STAGING.md`, `scripts/staging-config.ts`, `scripts/staging-turso.ts`, `src/auth.ts`, `src/payments.ts`, `src/platform/vercel.ts`, `src/publications.ts`, `src/storage/cloudinary-policy.ts`, `tests/database-contract.test.ts`, `tests/payment-contract.mjs`, `tests/payments.test.ts`, `tests/pre-staging-security.test.ts`, `tests/publications.test.ts`, `tests/scheduler.test.ts`, `tests/staging-config.test.ts`, `tests/storage.test.ts`, and `tests/worker.test.ts`.

The pre-existing untracked paths were:

`docs/qa/ORDERS-2.23-TURSO-STAGING-DATABASE-ISOLATION.md`, `docs/qa/ORDERS-2.24-CLOUDINARY-STAGING-ISOLATION.md`, `docs/qa/ORDERS-2.25A-PREVIEW-AUTH-GATE-REMEDIATION.md`, `docs/qa/ORDERS-2.26-PREVIEW-MOCK-PAYMENT-ISOLATION.md`, `docs/qa/ORDERS-2.27-STAGING-MANUAL-PUBLICATION-LIFECYCLE.md`, `docs/qa/ORDERS-2.28-PREVIEW-LIFECYCLE-SECRET-ISOLATION.md`, `docs/qa/ORDERS-2.29-VERCEL-PREVIEW-ENVIRONMENT-CONFIGURATION-AUDIT.md`, `src/payments/policy.ts`, and `tests/auth-environment.test.ts`.

## 2. Files changed

Existing tracked files changed for this task:

- `src/platform/vercel.ts`
- `tests/vercel.test.ts`
- `tests/scheduler.test.ts`
- `tests/publications.test.ts`
- `tests/pre-staging-security.test.ts`
- `docs/VERCEL_STAGING.md`
- `docs/PUBLICATION_AND_DELIVERY.md`
- `docs/API_SPECIFICATION.md`
- `docs/HOSTING_MIGRATION.md`

Created:

- `docs/qa/ORDERS-2.30-PREVIEW-STORAGE-DURABILITY-REMEDIATION.md`

No storage provider, dependency, migration, or environment example was added.

## 3. Storage lifecycle analysis and remediation

Previously, Vercel Preview selected `MemoryStorageAdapter` when `STORAGE_PROVIDER=mock`. That adapter is process-local and cannot guarantee media availability across serverless instances or restarts.

The Vercel adapter now returns no storage provider for the staging/Preview runtime. It does not instantiate the mock adapter even if `STORAGE_PROVIDER=mock` is present, and it has no Preview fallback to Production Cloudinary or Worker R2. Existing shared handlers receive no `STORAGE` capability:

- Upload URL/content operations return `503 STORAGE_UNAVAILABLE`; no asset or upload-session metadata is written. The API adapter may establish its configured database connection, but these paths execute no database statements.
- Public media retrieval returns `404 NOT_FOUND` when storage is unavailable; it does not report a successful asset response.
- The authorized Preview lifecycle route returns `503 STORAGE_UNAVAILABLE` before opening the database connection, so it performs no expiry, cleanup, or other lifecycle mutation.
- The existing asset cleanup protections remain unchanged. Cleanup continues to defer deletion when source assets are referenced by active or retained publications.

Local/test mock storage remains available. Production Cloudinary selection and Production Cron authorization/behavior were not changed. The generic Worker storage factory and its explicit R2 binding behavior were not changed.

## 4. Environment isolation matrix

| Runtime | Storage behavior after this change |
|---|---|
| Vercel Preview (`VERCEL_ENV=preview`, `ENVIRONMENT=staging`) | No storage adapter. Durable-media operations fail closed; no Production credentials or mock-storage fallback. |
| Explicit local Vercel development | Existing `STORAGE_PROVIDER=mock` behavior remains available under its local-test gate. |
| Vercel Production | Existing explicit Production Cloudinary configuration and selection remain unchanged. |
| Legacy Worker | Existing explicit R2 binding behavior remains unchanged; staging Worker requests continue to be rejected by the existing environment gate. |

Preview media storage is **unavailable** until a separate durable staging provider is approved and configured. Remote storage configuration has not been verified.

## 5. Verification

All commands ran locally with synthetic fixtures:

- `node --experimental-strip-types --test tests/vercel.test.ts tests/scheduler.test.ts tests/publications.test.ts tests/storage.test.ts` — **31 passed, 0 failed**.
- `npm run typecheck` — **passed**.
- `npm test` — **140 passed, 0 failed**.
- `npm run test:integration` — **passed**. The integration harness was inspected first: it uses a loopback Wrangler server, local D1 persistence in a temporary directory, synthetic payment fixtures, and a local email sink; no remote service is configured by the test.
- `git diff --check` — **passed**.

Coverage includes Preview mock-adapter non-construction, upload rejection without database statements or fake asset records, public media not-found behavior, lifecycle rejection before database connection, local mock availability, Production Cloudinary selection, and retention/shared-asset cleanup protections. Existing payment and Production Cron tests also passed.

## 6. Production and remote-service boundaries

- Production storage selection and Production Cron authorization/behavior are unchanged.
- No remote services, Cloudflare resources, Production resources, environment variables, or secrets were accessed or modified.
- No remote migration, deployment, commit, push, or merge was performed.
- No existing publication or customer data was changed; integration data was synthetic and local.
- Vercel Preview storage configuration and any remote provider identity remain unverified.

## 7. Final Git state

- Branch: `main`
- HEAD: `84acc4c19a143805830495671e076bbc395db3e3` (unchanged)
- Staged paths: none
- Modified tracked paths: 27 (all were already modified at baseline)
- Untracked paths: 10 (the 9 pre-existing paths plus this report)
- Final `git diff --check`: passed


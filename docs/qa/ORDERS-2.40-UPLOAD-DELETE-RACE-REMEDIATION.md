# ORDERS-2.40 — Upload/Delete Race Remediation

**Verdict: PARTIAL — the database-level race is prevented by local tests; remote provider behavior and late storage-operation cleanup are not verified.**

## Summary

The ORDERS-2.39 finding was a time-of-check/time-of-use gap between upload initiation and design deletion. An upload could pass a `DRAFT` lookup, then insert or finalize asset metadata after deletion had scanned the design. Upload completion also did not require the design to remain a draft.

The remediation persists upload lifecycle state and a bounded lease, makes upload writes conditional on the design still being `DRAFT`, and fences archival on active leases and undeleted assets. Deletion cancels pending or expired sessions, refuses to proceed while an unexpired upload lease exists, and archives only after cleanup is complete. Deterministic local tests exercise both sides of the race. Payment, order, and entitlement state are not changed by upload cleanup.

The database outcome is fenced, but database transactions cannot include external object storage. A provider operation that continues beyond its lease, or a worker that terminates after such an operation completes, can leave an orphaned object until cleanup is retried. This behavior and remote storage semantics were not verified; therefore this report does not claim complete end-to-end remote safety.

## Original race and reproduction

The concrete vulnerable sequence in ORDERS-2.39 was:

1. `createUpload` reads an owned design in `DRAFT`.
2. `deleteDesign` claims deletion, scans and cleans the design's then-existing assets, and archives it.
3. The paused upload inserts its asset/session after the scan.
4. Upload content/completion previously lacked a fresh design-state fence and could persist an asset after archival.

The new test **“reproduces upload initiation racing after deletion and refuses the archived design”** pauses the upload's database batch after preflight, completes deletion, then releases the upload. The upload returns `409`; the design remains `ARCHIVED` with zero asset rows. Additional barriers pause storage upload and completion to test the competing commit order.

## Root cause and changes

The root cause was using preliminary reads as authorization for later writes, without a persisted upload state or an atomic condition tying finalization to the current design state.

Files changed for ORDERS-2.40:

- [`src/assets.ts`](../../src/assets.ts): conditional upload grant insertion; persisted `PENDING`/`UPLOADING`/`COMPLETE`/`CANCELLED` session transitions; a 15-minute upload lease; upload finalization and completion checks requiring an eligible asset/session and `DRAFT` design; retryable cleanup on storage/database failure.
- [`src/designs.ts`](../../src/designs.ts): deletion refuses to claim while an unexpired upload is active; pending/expired sessions are cancelled; assets are cleaned before archive; archival is conditional on no active upload, no protected history, no shared publication reference, and no undeleted assets. Repeated deletion of an archived design retries physical cleanup.
- [`migrations/0010_asset_upload_leases.sql`](../../migrations/0010_asset_upload_leases.sql): adds upload-session lifecycle and lease columns/index, and marks previously finalized sessions `COMPLETE`.
- [`docs/DATABASE_SCHEMA.md`](../DATABASE_SCHEMA.md): documents the new schema and local-only migration status.
- [`tests/publications.test.ts`](../../tests/publications.test.ts): barrier-based race, failure, retry, and concurrency regressions.
- [`tests/database.test.ts`](../../tests/database.test.ts), [`tests/database-contract.test.ts`](../../tests/database-contract.test.ts), [`tests/vercel.test.ts`](../../tests/vercel.test.ts): migration sequence and legacy backfill expectations.
- [`tests/integration.mjs`](../../tests/integration.mjs): local D1 upload/deletion integration checks.

No existing migration was edited. Migration 0010 has not been applied to any remote database.

## Concurrency and persistence strategy

Upload grant creation uses conditional `INSERT ... SELECT` statements that recheck ownership, `DRAFT` status, and the asset limit when writing. Upload content atomically claims a still-pending session as `UPLOADING` only while the asset and design are eligible. After object storage succeeds, a database batch conditionally advances the asset and session only while the design remains a draft and the lease is valid. `completeUpload` likewise requires the matching completed session, quarantined asset, and draft design.

Deletion's database batch refuses an active, unexpired upload lease and cancels pending or expired sessions. It marks source assets for cleanup and only archives after all assets are `DELETED`; the archive update rechecks the relevant state predicates. If finalization wins before deletion claims the design, deletion observes and cleans the asset. If deletion wins, subsequent upload DB transitions fail their conditions and the request attempts storage cleanup. These checks are database-backed, not process-local locks.

The D1 adapter delegates `batch()` to the D1 database batch API; the Turso adapter uses a write batch. Existing adapter tests verify transactional batch rollback, and tests exercise the local Turso/libSQL adapter and local Wrangler D1. These results support the intended SQLite transaction strategy, but do not prove behavior of deployed D1/Turso service instances or remote storage providers.

## Regression coverage and results

Focused tests added or exercised in `tests/publications.test.ts` cover:

- Upload initiation paused while deletion archives; no asset can be inserted afterward.
- A claimed upload finishing before deletion; deletion then cleans it.
- A paused completion attempting to commit after deletion wins.
- Expired lease cancellation and cleanup retry.
- Concurrent uploads against one draft finalizing once each.
- Upload persistence failure plus failed initial object deletion, leaving cleanup retryable.
- Concurrent design deletion requests remaining idempotent.
- Existing shared-source-asset protection, archived-design upload denial, paid-site ledger/entitlement preservation, and legitimate upload flows.

Verification performed locally:

| Check | Result |
|---|---|
| Focused `tests/database.test.ts` | PASS — 6 tests |
| Focused `tests/publications.test.ts` | PASS — 20 tests |
| `npm run typecheck` | PASS |
| `npm test` | PASS — 156 tests, 0 failures |
| `npm run test:integration` | PASS — local D1 API/payment contracts, legacy regression, constraints, and batch rollback |
| `node --check account\websites\websites.js` | PASS |
| `node --check tests\integration.mjs` | PASS |
| Inline JavaScript in `templates/our-universe/index.html` via extraction and `node --check` | PASS |
| `git diff --check` | PASS |

These are local synthetic/unit and local database results. No browser, Preview, Production, remote D1/Turso, or remote storage verification was performed.

## Remaining risks and limitations

- Storage writes/deletes are external side effects and cannot be made atomic with the database batch. The implementation uses a 15-minute lease, fails closed for DB finalization after lease expiry/deletion, and attempts cleanup on failure. A storage operation that completes late after its cleanup attempt, particularly if the worker terminates, may leave an orphaned object. The archived-design DELETE path can retry storage deletion, but no remote provider behavior or independent orphan scanner was verified.
- Local tests demonstrate the original asset-row/design-state race is blocked. They do not prove distributed contention behavior on deployed providers, nor cover every combination of process termination and late object-store completion.
- No remote migration, provider calls, real uploads, payments, customer operations, deployment, or Production activity occurred. Before rollout, migration 0010 and the cleanup lifecycle require a reviewed deployment plan and verification in an isolated non-Production environment.
- No pricing, payment provider, checkout, webhook, Production configuration, or entitlement policy was changed.

## Git baseline and final state

- Repository: `C:\Users\ltdc9\OneDrive\Desktop\crushify`
- Branch: `main`
- HEAD: `4f4aaa354893309dd8ed325882bfa461058aa9d3` (unchanged)
- Baseline: 18 modified tracked files, 6 untracked files, no staged changes.
- Final state: 19 modified tracked files, 8 untracked files, no staged changes.
- The pre-existing changes and untracked files were preserved. `src/assets.ts` was newly modified by this task; migration 0010 and this report are new untracked files. Edits to files already modified at baseline were integrated without discarding earlier work.

Final modified tracked paths:

`_headers`, `account/websites/websites.js`, `docs/DATABASE_SCHEMA.md`, `docs/PAYMENT_FLOW.md`, `docs/PUBLICATION_AND_DELIVERY.md`, `src/assets.ts`, `src/designs.ts`, `src/index.ts`, `src/logging.ts`, `src/payments.ts`, `src/publications.ts`, `templates/our-universe/index.html`, `tests/database-contract.test.ts`, `tests/database.test.ts`, `tests/integration.mjs`, `tests/payment-contract.mjs`, `tests/publications.test.ts`, `tests/vercel.test.ts`, `vercel.json`.

Final untracked paths:

`docs/qa/ORDERS-2.35-FULFILLMENT-RECOVERY-REMEDIATION.md`, `docs/qa/ORDERS-2.36-PUBLICATION-MANAGEMENT-REMEDIATION.md`, `docs/qa/ORDERS-2.37-FINAL-PRODUCTION-READINESS-AUDIT.md`, `docs/qa/ORDERS-2.38-PUBLICATION-DELETION-ENTITLEMENT-SAFETY-REMEDIATION.md`, `docs/qa/ORDERS-2.39-INDEPENDENT-DELETION-SAFETY-AUDIT.md`, `docs/qa/ORDERS-2.40-UPLOAD-DELETE-RACE-REMEDIATION.md`, `migrations/0009_fulfillment_recovery_leases.sql`, `migrations/0010_asset_upload_leases.sql`.

No commit, push, merge, deployment, remote service access, payment, or Production operation was performed.

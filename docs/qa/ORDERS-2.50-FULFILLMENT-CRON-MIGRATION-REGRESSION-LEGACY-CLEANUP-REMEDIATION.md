# ORDERS-2.50 — Fulfillment Cron, Migration 0012, and Legacy Cleanup

**Verdict: PARTIAL.** The three ORDERS-2.49 gaps are closed with local regression tests. The latest local D1 integration run passes, but the cause of the earlier `SQLITE_IOERR_TRUNCATE`/`ECONNRESET` incident is not conclusively diagnosed.

## Starting baseline

- Repository root: `C:\Users\ltdc9\OneDrive\Desktop\crushify`
- Branch: `main`
- HEAD: `c27136f3c18ef6c20698514b1490d6173830bcf5`
- Upstream: `origin/main`
- Starting `git status --short`: clean
- Staged changes: none
- Unstaged changes: none
- Existing untracked files: none

The branch and commit were read from the current checkout; no branch switch or remote fetch/pull was performed.

## ORDERS-2.49 findings and disposition

| Finding | Disposition |
|---|---|
| Configured Vercel Cron did not invoke failed/pending fulfillment recovery. | Fixed in `src/scheduler.ts`; the configured Production Cron now calls the existing recovery function under its existing payment environment policy. Actual route-to-scheduler execution is tested. |
| Migration 0012 asset-deletion protection trigger lacked direct coverage. | Added direct SQL-trigger tests. Raw asset status updates are rejected for active and retained publication references; deletion succeeds after retention ends; unrelated assets remain deletable. No migration semantics or migration files were changed. |
| Legacy cleanup test did not run historical backfill or reproduce trigger failure after external deletion. | Replaced the synthetic post-migration fixture with a database upgraded from 0010: legacy archived references are backfilled by 0011, an already-removed storage object is followed by the actual trigger rejection, then 0012 and retry behavior are exercised. |
| Prior D1 integration run was inconclusive. | Current isolated integration runs passed. Historical failure cause remains unproven; details and limits are below. No test assertion was weakened and no harness code was changed. |

## Vercel Cron path

**Before:** `vercel.json` scheduled `GET /api/cron/publication-lifecycle` daily at `0 3 * * *`. `api/cron/publication-lifecycle.ts` re-exports the catch-all Vercel handler. In `src/platform/vercel.ts`, the authenticated Production route validated the Cron bearer secret and Production database/storage configuration, then called `runScheduledPublicationLifecycle`. That scheduler ran publication lifecycle and upload cleanup only. `recoverPendingFulfillments` was called by the Cloudflare `scheduled()` handler, not by the configured Vercel schedule.

**After:** The same Vercel route and gates remain in place. `src/scheduler.ts` runs the existing `recoverPendingFulfillments(env, limit, now)` before the other scheduled operations when `resolvePaymentEnvironmentPolicy(env).fulfillmentEnabled` is true. Its default batch limit is 10, and the scheduler rejects limits outside 1–100. Existing lease-token claims, verified-payment predicates, attempt limits, and job idempotency remain inside the existing recovery implementation; this change adds no alternate fulfillment path.

Publication lifecycle, fulfillment recovery, and upload reconciliation are isolated operations. A thrown failure in one is recorded with a fixed safe category and does not skip the other operations. The run record contains per-operation status, counts, or a fixed error code; sensitive exception text is not returned. A run with an operation failure is persisted as `FAILED` and the Cron route returns `503` with the safe operation summary.

Preview/local behavior is not broadened: the Vercel Production Cron route remains Production-only and bearer-authenticated; the staging manual route can run publication/upload maintenance but fulfillment is marked skipped by the existing environment policy. Recovery still revalidates settled SePay payment and processed webhook evidence before fulfillment. No production Cron was invoked or enabled during this task.

### Cron regression tests

`tests/publications.test.ts` now covers the configured HTTP route through the scheduler:

- The authenticated Production route recovers a due paid fulfillment job, completes its order, and preserves single-publication/entitlement behavior.
- Missing/invalid Cron authorization leaves the synthetic job `PENDING` and performs no database connection or recovery.
- A deliberately rejected fulfillment claim yields a safe `503` failure result while publication expiry and upload-attempt reconciliation still complete; removing the synthetic failure allows the next scheduled run to recover the job.
- A scheduled batch limit of 1 processes only one of two due jobs per run; subsequent runs complete the second, and another repeat creates no duplicate publication or entitlement.
- The existing scheduler lease and environment-isolation tests still pass. The configured Vercel schedule remains the only checked-in automatic lifecycle schedule.

## Migration 0012 trigger coverage

No schema change was necessary. The real migration SQL is applied by the regression tests. `tests/publications.test.ts` upgrades a database through migration 0011, creates publication references, applies migration 0012, and issues raw `UPDATE assets SET status = 'DELETION_PENDING'/'DELETED'` statements. The database trigger—not an application preflight—rejects deletion for `PUBLISHED`, `UNPUBLISHED`, `EXPIRED`, and `REVOKED` publications while their references remain active or retained.

The test also keeps an expired publication blocked while its retention deadline is in the future, then moves that deadline into the past and verifies the state-machine sequence `DELETION_PENDING` → `DELETED` succeeds. An unrelated ready asset can follow the same sequence. `PRAGMA foreign_key_check` remains empty.

Migration runner coverage also verifies:

- Fresh databases apply migrations 0001–0012 and repeated initialization is a no-op (`tests/database.test.ts`).
- A database already at 0011 upgrades by applying 0012 (`tests/database.test.ts` and the direct-trigger test).
- The direct-trigger test itself re-applies the full migration list and verifies no second application occurs.

## Legacy archived cleanup regression

The legacy regression constructs the actual historical sequence using local libSQL and the real migrations:

1. Apply migrations 0001–0010.
2. Insert an archived design, revision, and two ready assets whose IDs are in the design's historical JSON references.
3. Apply migration 0011 and assert that its backfill creates the exact two normalized design references.
4. Create a separate paid, expired-but-retained publication referencing the second source asset.
5. Simulate an object already removed by the old cleanup path, then attempt the asset status transition. The migration 0011 trigger rejects it, leaving the database asset `READY` while its object is absent.
6. Apply migration 0012 and verify the backfilled reference continues to block the raw deletion transition. The application cleanup also returns `409` while the other paid publication's retention is active and leaves both design references/assets intact.
7. After moving the publication retention deadline into the past, inject one storage deletion failure. The route returns `503`; both assets remain `DELETION_PENDING`, references are cleared in the appropriate state transition, and a later retry succeeds even for the already-absent object.
8. Repeated cleanup remains idempotent. The separate paid order, succeeded payment, publication snapshot/status, immutable order design snapshot, and storage entitlement remain unchanged.

Storage is a deterministic in-memory test double; no R2, Cloudinary, or other external storage was contacted.

## Local D1 integration diagnosis

The latest `npm run test:integration` completed successfully against the harness's disposable local Wrangler D1/R2 persistence and printed:

`Local integration: passed (D1 API and payment contracts, legacy regression, constraints, and batch rollback).`

An earlier isolated run during this task also passed. The baseline report ORDERS-2.49 records an earlier failure with `SQLITE_IOERR_TRUNCATE` during local Worker reload and a subsequent `ECONNRESET`. At this task's start and after the final run, no Wrangler-related Node process remained. No prior failure log file was available in the active checkout/session to inspect beyond the description preserved by ORDERS-2.49.

The harness uses a unique temporary persistence directory per run and fixed local port 8787. While Wrangler dev is running, the harness also invokes separate `wrangler d1 execute` processes with the same persistence directory for test setup/assertions. That is a plausible local cross-process SQLite contention/reload contributor, but the evidence does not establish that it caused the earlier errors. Current passing isolated runs show that the failure is not reproduced; they do not prove its root cause. No application database defect was reproduced, and no integration harness changes or timeout/assertion relaxations were made.

**Integration result:** latest full local run **PASS**; diagnosis of the earlier incident **INCONCLUSIVE**. This report does not claim remote D1, Turso, or Production verification.

## Verification

| Check | Result |
|---|---|
| Focused configured-Cron tests (`--test-name-pattern` for authenticated route, failure isolation, and batch behavior) | PASS — 3 tests, 0 failures |
| Focused migration 0012 trigger and legacy backfill/cleanup tests | PASS — 2 tests, 0 failures |
| `tests/database.test.ts` + `tests/scheduler.test.ts` | PASS — 11 tests, 0 failures |
| `npm test` | PASS — 181 tests, 0 failures |
| `npm run typecheck` | PASS — `tsc --noEmit` |
| `npm run test:integration` | PASS — complete isolated local D1 integration |
| `git diff --check` | PASS |

An earlier focused run during implementation failed on four test assertions/setup issues: the paid fixture's `next_attempt_at` was in 2099 (so recovery correctly attempted zero jobs); the resulting failure-injection route therefore returned 200 rather than the expected 503; the legacy test called a fixture helper requiring `order_design_snapshots` before migration 0011; and an existing scheduler assertion read the old top-level upload-cleanup result shape. The fixtures were changed to make the job due, the legacy fixture was moved to the correct migration point, and the assertion now reads the per-operation result. The focused reruns and all final gates above pass. Product code and assertions were not weakened.

## Files changed

- `src/scheduler.ts` — bounded recovery invocation, per-operation isolation/results, fixed error codes, failed-run persistence.
- `src/platform/vercel.ts` — return `503` when an acquired scheduled run contains an operation failure.
- `tests/publications.test.ts` — actual Cron route, authorization, failure isolation, bounded/idempotent recovery, migration trigger, and legacy backfill/retry regressions.
- `tests/scheduler.test.ts` — scheduler per-operation result and environment-policy expectations.
- `docs/qa/ORDERS-2.50-FULFILLMENT-CRON-MIGRATION-REGRESSION-LEGACY-CLEANUP-REMEDIATION.md` — this report.

No migration, Vercel configuration, payment provider, pricing, or Production secret/configuration was changed.

## Remaining limitations

- Actual Vercel Cron delivery/execution and remote D1/Turso trigger behavior were not tested.
- The cause of the historical local SQLite I/O/connection-reset failure remains inconclusive despite passing isolated reruns.
- Recovery execution is connected in code but was not invoked against Production; deployment/owner approval is outside scope.

## Final Git safety check

- Branch remains `main`; HEAD remains `c27136f3c18ef6c20698514b1490d6173830bcf5`; upstream remains `origin/main`.
- Staged files: none.
- Modified tracked files: `src/platform/vercel.ts`, `src/scheduler.ts`, `tests/publications.test.ts`, `tests/scheduler.test.ts`.
- New untracked file: this ORDERS-2.50 report.
- Starting worktree was clean, and all pre-existing user changes/artifacts (none at baseline) remain preserved.
- No branch switch, fetch, pull, commit, push, deployment, Production access, real payment, or external storage operation occurred.

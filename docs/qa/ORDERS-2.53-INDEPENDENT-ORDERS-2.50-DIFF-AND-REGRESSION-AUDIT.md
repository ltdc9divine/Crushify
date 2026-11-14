# ORDERS-2.53 — Independent ORDERS-2.50 Diff and Regression Audit

## Verdict: PARTIAL

ORDERS-2.50 closes the Vercel fulfillment-recovery gap and adds meaningful regressions for the migration 0012 trigger and historical legacy cleanup. The focused suites, full unit suite, typecheck, and isolated local integration all pass in this checkout. The intended development checkout is still absent, reverse concurrency interleavings remain unproven, and no real Vercel Cron, remote database, or external storage behavior was tested. Do not treat this as Production approval.

This was a read-only audit except for creating this report. No remediation was implemented.

## 1. Repository baseline

| Item | Captured value |
|---|---|
| Repository root | `C:\Users\ltdc9\OneDrive\Desktop\crushify` |
| Branch | `main` |
| HEAD | `c27136f3c18ef6c20698514b1490d6173830bcf5` |
| Upstream | `origin/main` |
| Origin URL | `https://github.com/ltdc9divine/Crushify.git` |
| Recent history | `c27136f (HEAD -> main, origin/main) Remediate order lifecycle and upload recovery`; parent history includes `2314879` |
| Staged files | None |

`2314879` exists and is an ancestor of current HEAD. Current HEAD is the reported ORDERS-2.50 baseline commit and is itself present on `origin/main`. No fetch or remote service access was performed.

Starting `git status --short`:

```text
 M src/platform/vercel.ts
 M src/scheduler.ts
 M tests/publications.test.ts
 M tests/scheduler.test.ts
?? docs/qa/ORDERS-2.50-FULFILLMENT-CRON-MIGRATION-REGRESSION-LEGACY-CLEANUP-REMEDIATION.md
?? docs/qa/ORDERS-2.51-REPOSITORY-PROVENANCE-ORDERS-2.50-VERIFICATION.md
?? docs/qa/ORDERS-2.52-ORDERS-2.50-BASELINE-RECONCILIATION-INTEGRATION-PLAN.md
```

The four unstaged tracked files are exactly the ORDERS-2.50 diff inventory. The full diff is **681 insertions and 80 deletions**; the cached diff is empty. The three listed reports were already untracked before this audit, and the ORDERS-2.52 report exists. Git proves these are worktree differences from current HEAD; attribution to ORDERS-2.50 is also consistent with the existing ORDERS-2.50–2.52 reports, but there is no commit or pre-task Git snapshot independently proving who authored each hunk.

The previously named checkout `C:\Users\ltdc9\OneDrive\Desktop\======WORK======\crushify` was checked and is absent. Current `main` shares the reported history, but that does not establish that it is the authorized intended development target. This agrees with the provenance limitation recorded in ORDERS-2.52.

## 2. ORDERS-2.49 finding inventory

| ORDERS-2.49 finding | Verdict | Current evidence and remaining limit |
|---|---|---|
| A — No direct regression for migration 0012's retained-publication deletion trigger. | **FIXED** | A new test applies migrations through 0011 and then 0012, and raw SQL asset status updates exercise the actual trigger for active/retained publication references and after retention expiry. |
| B — Configured Vercel Cron did not invoke pending fulfillment recovery. | **FIXED** | The Production handler reaches the shared scheduler; a handler-level test authenticates, recovers a due paid order, and verifies its completed state. Actual Vercel delivery remains untested. |
| B — Reverse payment/deletion and fulfillment-claim transaction orderings were not deterministically tested. | **PARTIAL** | Existing fencing and conditional database claims remain present, and the current concurrency suite passes, but ORDERS-2.50 does not add the missing reverse interleavings. |
| C — Upload cleanup was not exercised through the HTTP Cron entry point with a due attempt. | **FIXED** | The handler regression creates a due cleanup attempt and verifies the scheduler preserves the live asset and advances the attempt to `ATTACHED`. This verifies the actual reconciliation operation through the handler, not a real provider deletion. |
| D — Legacy cleanup did not execute migration 0011's historical backfill or reproduce trigger failure after object removal. | **FIXED** | The regression applies 0010, seeds historical JSON references, runs 0011 backfill, simulates a previously removed object, observes the SQL trigger rejection, applies 0012, then tests protected cleanup, injected failure, retry, and idempotency. |
| The prior isolated local D1 integration run was inconclusive. | **FIXED** | The exact configured integration command now completes successfully in this checkout. The earlier failure's root cause is still unknown. |
| Remote D1/Turso concurrency and actual Vercel Cron delivery/execution were unverified. | **INCONCLUSIVE** | No remote database, Vercel service, or Production resource was accessed. Local tests cannot establish those external behaviors. |
| A provider operation already accepted by R2/Cloudinary cannot be canceled by database fencing; delayed outcomes may need reconciliation or manual review. | **OPEN** | Database fencing, retries, and late-success reconciliation remain, but they cannot revoke a provider-side operation already accepted. No external provider behavior was tested. |

The four broad claims in the ORDERS-2.49 claim matrix therefore resolve as: publication retention **FIXED**; paid fulfillment **PARTIAL** because recovery is now scheduled but reverse interleavings remain untested; upload recovery **FIXED** at the local handler boundary; legacy archived cleanup **FIXED** for the reproduced migration sequence.

## 3. Complete ORDERS-2.50 diff review

| Changed file | Change and prior finding addressed | Risk / review result |
|---|---|---|
| [src/scheduler.ts](../../src/scheduler.ts) | Adds per-operation execution and safe error logging; runs bounded fulfillment recovery under the payment environment policy; records operation results and a failed-run state; validates the shared batch limit (1–100, default 10). Addresses missing Cron recovery, failure isolation, and partial-result visibility. | Later independent operations still run after one operation throws. Failures are represented with fixed error codes rather than exception text. The 5-minute scheduler lease remains. No unrelated scheduler behavior change was found. |
| [src/platform/vercel.ts](../../src/platform/vercel.ts) | Both the manual staging lifecycle route and Production Cron route now return 503 for an acquired run with a failed operation; successful runs remain 200 and lease contention remains 202. | Response status now reflects partial operation failure. The routes retain their existing auth, environment, database, and storage checks. |
| [tests/publications.test.ts](../../tests/publications.test.ts) | Adds due upload-attempt fixture support; handler-path Cron tests for authorization, successful fulfillment, due cleanup, bounded/idempotent recovery, and failure isolation; direct SQL trigger coverage; and the 0010→0011→0012 historical cleanup regression. Updates existing Preview and legacy assertions to match the per-operation result and real migration order. | These are local database/storage-adapter tests, not live provider or Vercel executions. No weakened assertion or unrelated test edit was identified. |
| [tests/scheduler.test.ts](../../tests/scheduler.test.ts) | Updates the Preview scheduler assertion to verify the fulfillment operation is skipped by runtime policy and to assert per-operation result records. | Assertions match the runtime policy and new response structure. |

No migration, Vercel configuration, payment implementation, storage implementation, `src/publications.ts`, or `src/assets.ts` source was changed. The 0010–0012 migrations and underlying fulfillment/retention code are dependencies already present in current HEAD; no missing dependency or duplicate implementation was found.

One low-severity type-contract mismatch was observed: the declared `uploadCleanup.result` type in `runScheduledPublicationLifecycle` omits `preserved`, while the real reconciliation result and serialized runtime result include it. Tests confirm the runtime value, and typecheck passes, but typed callers cannot access that field through the declared return type. This does not currently change runtime behavior; it should be reconciled before relying on that field in typed callers.

## 4. Cron and fulfillment call-chain audit

The configured path is:

```text
vercel.json
  /api/cron/publication-lifecycle (daily at 03:00)
  -> api/cron/publication-lifecycle.ts re-exports api/[...path].ts
  -> createVercelApiHandler
  -> runScheduledPublicationLifecycle
  -> recoverPendingFulfillments
  -> handleFulfillmentForOrder
```

`api/[...path].ts` sets `maxDuration: 60`. The handler accepts only `GET`, requires a `Bearer` `CRON_SECRET` of at least 32 characters and compares it without an early byte-by-byte exit. It rejects non-Production Vercel environments, validates runtime/database configuration, and checks storage configuration before connecting to the database. The test verifies missing/invalid authorization does not connect or claim work. The Preview manual route has a separate secret and Production Cron is not available in Preview.

The scheduler applies a five-minute exclusive task lease and a default batch limit of 10 (maximum 100). Fulfillment runs only when `resolvePaymentEnvironmentPolicy` enables it; that is true for Production and false for staging. Fulfillment recovery precedes publication lifecycle and upload cleanup. Each operation is caught and recorded independently, so a thrown recovery failure does not skip the other two. The response and persisted run record include per-operation states and fixed error codes; an acquired run with any failed operation is marked failed and returned as HTTP 503. The handler test injects a recovery failure and verifies publication expiry and upload reconciliation still complete.

The existing fulfillment path rechecks a paid self-service order, successful SePay payment, processed webhook event, matching amount/currency, review flags, and publication state before finalizing. Claim/update conditions use unique job lease tokens, attempt limits and expiry; entitlement insertion is idempotent by order, and finalization is conditional on the current lease. The scheduler lease and per-job lease reduce duplicate work under overlapping invocations. Tests verify exclusive lease acquisition, bounded recovery, repeated-run idempotency, and order fulfillment. They do not model two complete Vercel HTTP invocations racing through real storage.

The 60-second Vercel runtime setting bounds the deployed function, but no separate per-operation timeout is configured. Local tests establish code-path behavior, not that every real provider operation completes within that platform limit or that the actual Vercel Cron service supplies the expected secret and invokes the route.

## 5. Migration and legacy-cleanup regressions

The migration 0012 test applies the real SQL through 0011, inserts publication references, applies 0012, and issues raw `UPDATE assets` statements. The trigger blocks `DELETION_PENDING` and `DELETED` for `PUBLISHED`, `UNPUBLISHED`, `EXPIRED`, and `REVOKED` publication references while active or retained. It permits deletion after the retention deadline and permits an unrelated asset to transition. This is direct database-trigger execution, not a mocked application predicate.

The legacy test applies migrations 0001–0010, inserts an archived design/revision and two ready assets whose identifiers are in historical JSON, then applies 0011 and checks the exact backfilled design references. It simulates prior object removal using the in-memory storage adapter and observes the actual 0011 trigger reject the asset state change. It applies 0012 and verifies the reference remains protected. Application cleanup returns 409 while a separate publication retains an asset; after retention expires, an injected provider deletion failure returns 503 with retryable database state. A later retry succeeds, repeated cleanup is idempotent, and the paid order, payment, snapshot, publication, and entitlement are preserved.

The historical storage absence and injected failure are modeled with a deterministic in-memory test double; no R2 or Cloudinary service is contacted. The migration and trigger SQL were exercised locally through libSQL/Turso adapters. Remote D1/Turso equivalence remains unverified. The full local D1 integration later passed and also exercised its constraints and batch rollback, but it does not replace remote testing.

## 6. Concurrency and lifecycle regression review

The ORDERS-2.50 source diff does not alter upload, asset-reference, payment, fulfillment, publication-retention, or migration logic. The publication/database/scheduler suites passed, including existing regressions for:

- Design asset reference insertion versus deletion serialization.
- Upload lease expiration, attempt-token fencing, stale workers, late provider success, cleanup retries, and manual review.
- Immutable paid-order snapshots, payment settlement/deletion ordering, fulfillment claim/deletion ordering, failure and retry.
- Payment validation before fulfillment and idempotent fulfillment recovery.
- Active and retained publication asset protection, expired/revoked retention deadlines, and shared-asset cleanup.
- Exclusive scheduled-task leases and Preview fulfillment policy isolation.

The suite supports that these guards continue to operate in the current worktree. It does not close the previously identified reverse payment/deletion or fulfillment-claim interleavings, establish remote provider fencing, or prove remote database transaction semantics.

## 7. Test commands and actual results

| Exact command | Result |
|---|---|
| `node --experimental-strip-types --test --test-name-pattern="runs the authenticated Production Vercel Cron route\|continues publication and upload cleanup when Cron fulfillment recovery fails" tests/publications.test.ts` | **PASS** — 2 tests, 0 failures. |
| `node --experimental-strip-types --test --test-name-pattern="enforces migration 0012 asset retention through the database trigger\|retries legacy archived cleanup after reference backfill without losing the source object" tests/publications.test.ts` | **PASS** — 2 tests, 0 failures. |
| `node --experimental-strip-types --test tests/publications.test.ts tests/database.test.ts tests/scheduler.test.ts` | **PASS** — 55 tests, 0 failures. |
| `npm test` | **PASS** — 181 tests, 0 failures, 0 skipped. |
| `npm run typecheck` | **PASS** — `tsc --noEmit`, exit code 0. |
| `npm run test:integration` | **PASS** — printed `Local integration: passed (D1 API and payment contracts, legacy regression, constraints, and batch rollback).` It exceeded the initial 180-second shell wait, then completed successfully on the follow-up read; it was not canceled or treated as a timeout. |
| `git diff --check` | **PASS** — run at final safety check. |

The integration harness was inspected before execution: Wrangler runs with `--local`, a unique temporary D1/R2 persistence directory, local loopback HTTP, a local email sink, and synthetic payment settings; D1 CLI commands use `--local`. No remote database, real payment, email provider, webhook endpoint, external storage, or Production resource was contacted. The harness removed its temporary directory; no integration listener or matching temp directory remained after completion.

VS Code test discovery was unavailable (zero registered test controllers). The repository's configured Node test commands above were used instead.

## 8. Verdict and readiness

**Overall verdict: PARTIAL.** The three implementation/regression gaps in the Cron recovery, trigger coverage, and historical cleanup areas are closed locally, and the current integration command passes. Important reverse concurrency proof and external-platform evidence remain absent.

| Question | Assessment |
|---|---|
| Technically safe to retain in this worktree? | **Yes, with the noted non-blocking type-contract mismatch and remaining verification limits.** |
| Safe to commit? | **Not yet to `main` or an assumed development target.** The current local diff passes tests, but the intended target is unverified; reconcile the result type and confirm the authorized branch before committing. |
| Safe to integrate into the intended development branch? | **No.** The previously named checkout is absent and the intended branch cannot be established from this checkout alone. |
| Safe for Production? | **No.** Actual Vercel Cron delivery, production secrets/configuration, remote D1/Turso behavior, external storage outcomes, and the 60-second real execution envelope were not tested. |

Recommended next steps, in order:

1. Have the repository owner identify the intended checkout and branch; do not infer it from the project name or current `main`.
2. Resolve the declared `uploadCleanup.result` shape and decide whether the missing reverse interleaving tests are required before commit.
3. Review the four-file diff on the confirmed target without copying, merging, or cherry-picking until provenance is established.
4. Separately validate Preview/staging behavior and the provider/database configuration in an authorized non-Production environment.
5. Consider Production only after platform Cron delivery, remote database behavior, provider retries, and runtime limits are verified and approved.

## 9. Final safety verification

- Branch remains `main`; HEAD remains `c27136f3c18ef6c20698514b1490d6173830bcf5`.
- No staged changes were present; the four pre-existing modified tracked files remain the only tracked changes.
- The three pre-existing untracked reports remain untouched. Only this requested ORDERS-2.53 report was added.
- No source, test, migration, configuration, package, or existing report file was changed by this audit.
- No branch switch, fetch, pull, commit, push, deployment, Production access, real payment, or external provider operation occurred.

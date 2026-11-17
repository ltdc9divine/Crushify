# ORDERS-2.58 — Cleanup Outcome Semantics and Republish Race

## Verdict

**PARTIAL.** Cleanup now returns explicit outcomes and exposes deferred, failed, pending, and manual-review work to its callers and schedulers. The two false-success cases were reproduced before the change and have deterministic regressions. The republish-first/unpublish-cleanup ordering is now deterministically tested and passes against the current working tree, but it did not reproduce a current data-loss bug: the existing active-publication predicate already protects the derivative. This is regression coverage, not evidence that the underlying race was newly fixed.

Preview readiness is **NOT ESTABLISHED**. The local tests do not establish deployed scheduler cadence, remote database behavior, or provider-side cancellation/consistency. Production is **NOT AUTHORIZED**.

## Repository baseline and preserved state

| Item | At start of ORDERS-2.58 | Final |
|---|---|---|
| Root | `C:\Users\ltdc9\OneDrive\Desktop\======WORK======\crushify` | Same |
| Branch | `main` | `main` |
| HEAD | `1be81d555914a9a4f2dc794e96154f371c5cc841` | Same |
| Upstream | `origin/main` | `origin/main` |
| Staged changes | None | None |

At the start, nine tracked files were modified and three pre-existing untracked files were present: `docs/qa/ORDERS-2.56-PUBLICATION-DERIVATIVE-CLEANUP-RACE-REMEDIATION.md`, `docs/qa/ORDERS-2.57-INDEPENDENT-AUDIT-OF-ORDERS-2.56.md`, and `migrations/0013_publication_derivative_operations.sql`. Those changes were preserved. ORDERS-2.58 additionally modified `src/designs.ts` and `src/platform/vercel.ts`, and created only this report.

Final status:

```text
## main...origin/main
 M src/designs.ts
 M src/index.ts
 M src/logging.ts
 M src/platform/vercel.ts
 M src/publications.ts
 M src/scheduler.ts
 M tests/database-contract.test.ts
 M tests/database.test.ts
 M tests/publications.test.ts
 M tests/scheduler.test.ts
 M tests/vercel.test.ts
?? docs/qa/ORDERS-2.56-PUBLICATION-DERIVATIVE-CLEANUP-RACE-REMEDIATION.md
?? docs/qa/ORDERS-2.57-INDEPENDENT-AUDIT-OF-ORDERS-2.56.md
?? docs/qa/ORDERS-2.58-CLEANUP-OUTCOME-SEMANTICS-REPUBLISH-RACE-REMEDIATION.md
?? migrations/0013_publication_derivative_operations.sql
```

No staged changes; `git diff --check` passes. All implementation and test results below are against the dirty working tree, not the unchanged committed HEAD.

## Finding A — Cleanup reported success with unresolved work

### Reproduction

Before changing the outcome semantics, focused regressions expected future-backoff work and another worker's active cleanup lease to be reported as deferred. Both failed against the prior boolean result: `cleanupAssets()` returned `true` although the derivative operation remained unresolved. The cause was that the reconciler scans only due work, while a future retry or unexpired lease is intentionally excluded from that scan.

### Remediation

`src/publications.ts:68-85` defines the explicit cleanup statuses and result counters. `cleanupAssets()` delegates to reconciliation at `src/publications.ts:430-443`. Reconciliation counts due work remaining and deferred work—including future retry timing, active operation/cleanup leases, and optionally future tombstone rechecks—at `src/publications.ts:625-689`. `derivativeCleanupResult()` selects the result status and `hasMore` at `src/publications.ts:692-706`.

The status precedence is `manual_review`, `failed`, `pending`, `deferred`, then `completed`. Immediate caller cleanup disables passive future tombstone rechecks so a verified deletion is not falsely held open solely for a later orphan check; a still-live provider-create lease remains deferred.

Callers no longer treat a truthy boolean as completion. For example, design deletion maps pending/deferred/failure outcomes to explicit errors at `src/designs.ts:466-482`. Scheduler aggregation treats deferred/pending work as pending and failed/manual-review work as failure at `src/scheduler.ts:145-178`. The Vercel maintenance endpoint responds 202 while work remains, 503 on failure, and 200 on completion at `src/platform/vercel.ts:515-523` and `:575-583`. The Worker scheduled handler invokes the shared lifecycle scheduler and logs its summarized outcome at `src/index.ts:169-237`.

### Regression coverage

`tests/publications.test.ts` now covers:

- **“reports future retry backoff as deferred cleanup work”** (`:1679`)
- **“reports another worker's active cleanup lease as deferred work”** (`:1729`)
- **“reports remaining due derivatives when the cleanup batch is bounded”** (`:1777`)
- **“reports provider cleanup failure without claiming completion”** (`:1835`)
- **“keeps an uncertain provider delete visible after the object was removed”** (`:1879`)
- **“distinguishes completed immediate cleanup from passive tombstone rechecks”** (`:1923`)
- **“reports completed when the requested publication has no cleanup work”** (`:1974`)
- **“reports deferred cleanup through overlapping scheduler invocations”** (`:2006`)

These tests separately inspect database journal state and fake-provider object state. Lease/backoff and result-shape cases use controlled fixture states; the overlapping scheduler test uses a deterministic database pause. Provider failure and uncertain-delete tests assert the unresolved operation remains visible instead of reporting verified completion.

**Finding A verdict: FIXED locally and covered by focused regressions.** This does not imply remote DB or provider consistency.

## Finding B — Republish commits before stale unpublish cleanup resumes

The regression `tests/publications.test.ts:1604`, **“preserves the derivative when republish commits before stale unpublish cleanup resumes”**, pauses unpublish immediately before its operation-state update using `PausableDatabase`. It then allows republish to complete before resuming the stale unpublish cleanup. After both requests complete, the test independently asserts that the publication remains `PUBLISHED`, its asset remains `READY` with the original derivative key, and the fake storage still contains that derivative.

The critical cleanup claim and active-READY guard are in `src/publications.ts:465-566`. In particular, the `activeReadyReference` predicate excludes a derivative referenced by a non-revoked READY asset on a PUBLISHED publication, and the claim update repeats the protection check before provider deletion. This prevents the resumed stale cleanup from deleting the derivative that republish now needs.

The test demonstrates the requested ordering with a deterministic barrier and passes. It does **not** show that this was a currently failing race: source-level protection already existed, and the test passed against the working-tree implementation. This work adds reproducible protection for that ordering rather than claiming a new fix to an observed production defect.

**Finding B verdict: deterministic ordering covered; no current failure reproduced.**

## Outcome propagation and scheduler behavior

- The scheduler result distinguishes its own operation execution status from the cleanup result status. Cleanup-level deferred/pending work sets top-level `pending`; cleanup failure or manual review sets `failed` (`src/scheduler.ts:145-178`).
- Vercel scheduled routes return 202 for work remaining, 503 for reported failure, and 200 for completion (`src/platform/vercel.ts:515-523`, `:575-583`).
- The Worker scheduled entry point uses the shared scheduler and logs cleanup counters (`src/index.ts:169-237`).
- `vercel.json:128` configures the publication lifecycle Cron once daily (`0 3 * * *`). The one-hour tombstone recheck delay (`src/publications.ts:449-452`) is therefore **not** a one-hour execution guarantee. A recheck can wait until the next configured invocation.
- Provider requests already in flight cannot be cancelled by DB fencing alone. The journal and later reconciliation improve recovery visibility, but local fake-provider tests cannot prove actual provider behavior or guarantee that late completion will never occur after a terminal manual-review state.

## Files changed for ORDERS-2.58

Implementation/tests changed:

- `src/publications.ts` — typed outcomes, unresolved/deferred counts, cleanup result computation, and caller handling.
- `src/scheduler.ts` — propagate cleanup pending/failure state and log structured outcome counts.
- `src/platform/vercel.ts` — map scheduled outcome to HTTP 200/202/503.
- `src/index.ts` — route Worker scheduled maintenance through shared scheduler and log summarized result.
- `src/designs.ts` — map explicit cleanup outcomes when deleting designs.
- `src/logging.ts` — allow the cleanup metrics in safe structured logs.
- `tests/publications.test.ts` — deterministic republish ordering and cleanup outcome regressions.
- `tests/scheduler.test.ts` — scheduler outcome contract expectations.

No migration was added. Existing migration 0013 was reused and preserved. Pre-existing changes in `tests/database-contract.test.ts`, `tests/database.test.ts`, and `tests/vercel.test.ts` were not part of this task and remain untouched.

## Validation

| Command/check | Result |
|---|---|
| Focused cleanup/outcome/race tests | **PASS**, 11 tests, 11 passed |
| `npm test` | **PASS**, 194 tests, 194 passed, 0 failed, 0 skipped |
| `npm run typecheck` | **PASS**, exit code 0 |
| `npm run test:integration` | **PASS**, exit code 0; local D1/API/payment/legacy/constraint/batch-rollback harness |
| `git diff --check` | **PASS**, exit code 0 |

The integration test used the repository's local harness; no remote database or external provider was accessed. The first test-only barrier-wrapper attempt was stopped after it exposed incompatibility with the native Turso batch interface; the test wrapper was narrowed to the intercepted query, after which the focused tests passed. No production code was changed to accommodate that harness issue.

## Remaining risks and boundaries

- The configured lifecycle Cron is daily, not hourly; this limits how quickly passive tombstone rechecks and deferred work are revisited.
- Provider-side cancellation, uncertain completion, remote object deletion, and remote D1/Turso concurrency were not verified.
- The republish-first regression passes against existing guards; it is not evidence that the old implementation deleted a live derivative under this exact ordering.
- The test suite ran against uncommitted changes. HEAD remains `1be81d555914a9a4f2dc794e96154f371c5cc841` and does not include this work or migration 0013.
- Preview readiness is not established; Production is not authorized.

No commit, push, merge, branch switch, remote migration, deployment, or remote-service request occurred.

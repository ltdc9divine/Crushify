# ORDERS-2.62 — Cleanup Finalization and Manual-Review Recovery

## Result

**Overall: PARTIAL.**

- **F-01:** Fixed in the worktree using an atomic database batch that detaches only the exact old asset pointer and marks its journal operation complete in the same transaction. Failure/restart and fencing tests pass locally.
- **F-02:** Improved with scheduled exact-key lookup for due `MANUAL_REVIEW` operations. Confirmed objects are requeued for cleanup; absent or failed lookups remain durable manual review. This is **not exactly-once recovery**, and an absent result is not treated as proof of provider-side absence.
- **Preview:** **NOT READY / NOT ESTABLISHED** pending integration-harness recovery and an operational review/resolution procedure for persistent manual-review items.
- **Production:** **NOT AUTHORIZED.**

All implementation and test results below apply to the dirty worktree, not the current HEAD commit.

## Repository baseline and preservation

Captured before source inspection and edits:

| Item | Baseline |
|---|---|
| Root | `C:\Users\ltdc9\OneDrive\Desktop\======WORK======\crushify` |
| Branch | `main` |
| HEAD | `1be81d555914a9a4f2dc794e96154f371c5cc841` |
| Upstream | `origin/main` |
| Staged diff | None |
| Status header | `## main...origin/main` |
| Modified tracked files | 11 |
| Unstaged tracked diff | 2,045 insertions, 246 deletions |
| Pre-existing untracked files | 8 |

The pre-existing modified tracked files were:

```text
src/designs.ts
src/index.ts
src/logging.ts
src/platform/vercel.ts
src/publications.ts
src/scheduler.ts
tests/database-contract.test.ts
tests/database.test.ts
tests/publications.test.ts
tests/scheduler.test.ts
tests/vercel.test.ts
```

The pre-existing untracked files were reports ORDERS-2.56 through ORDERS-2.61 and migrations `0013_publication_derivative_operations.sql` and `0014_derivative_provider_success_reconciliation.sql`. All reports ORDERS-2.50 through ORDERS-2.61 existed at baseline. The worktree migration list was 0001–0014.

The baseline had no source/test work committed in HEAD for ORDERS-2.60; migrations 0013 and 0014 remained untracked. This remediation added no migration. Existing changes were preserved. Only `src/publications.ts`, `src/logging.ts`, and `tests/publications.test.ts` were further changed for ORDERS-2.62; all other pre-existing tracked diffs were left intact.

## F-01 — Root cause and remediation

### Root cause

The prior implementation first committed journal status `CLEANED`, then ran a separate update clearing `publication_assets.derivative_key`. A failure between those statements could leave the old key attached even though the operation was no longer eligible for ordinary cleanup. The failure handler was conditioned on the old `CLEANUP_PENDING` status/token and could not restore responsibility after the first write.

### Change

`reconcilePublicationDerivativeCleanup()` in `src/publications.ts` now performs pointer detachment and journal finalization in one `DB.batch` transaction:

1. The pointer update matches `publication_asset_id`, `publication_id`, the exact derivative key, `CLEANUP_PENDING` state, operation ID, cleanup token, and the observed provider-success marker.
2. The journal update can set `CLEANED` only when the old key no longer appears on that exact asset and the observed operation/marker fencing still matches.
3. If a pointer now refers to a different generation, the old cleanup cannot clear it; the old journal item may finish once its own key is no longer referenced.
4. If the batch fails, the transaction preserves the pointer/journal pair. The existing conditional retry records backoff or `MANUAL_REVIEW`; a later reconciliation retries safely.

The database adapters use their batch APIs (`src/database/d1.ts` and `src/database/turso.ts`). Tests inject failures both at pointer detachment and at journal finalization to verify database rollback. The provider delete remains a separate external side effect, so retry repeats an idempotent delete by the immutable exact key.

### Provider-creation uncertainty and `CLEANED`

If cleanup verifies deletion but `provider_create_succeeded_at` is still null, a delayed provider create may still appear after that absence check. The operation now remains `MANUAL_REVIEW` with `PROVIDER_CREATE_OUTCOME_UNCONFIRMED`; the asset pointer is detached atomically, but the operation is not mislabeled `CLEANED`. A later exact-key lookup can reopen cleanup if the object appears.

## F-02 — Root cause and remediation

### Root cause

Due-work selection omitted `MANUAL_REVIEW`, so an object created before a process crash but not recorded by the success marker could remain orphaned indefinitely.

### Change

The reconciler now:

- Selects due `MANUAL_REVIEW` rows by their persisted operation ID, immutable derivative key, `next_cleanup_at`, and cleanup lease.
- Claims each row conditionally without changing it out of `MANUAL_REVIEW` during lookup; the lease prevents concurrent duplicate checks.
- Uses the adapters’ existing exact-key `getPublishedDerivative()` operation. The Cloudinary adapter performs a GET for the exact public ID; R2 calls `bucket.get()` for the exact key. No bucket-wide listing or undocumented API was added.
- If an object is confirmed, persists a success marker and requeues the exact operation as `CLEANUP_PENDING`. The normal cleanup path then deletes and verifies it.
- If lookup returns no object, keeps `MANUAL_REVIEW`, leaves the success marker untouched, records `PROVIDER_LOOKUP_INCONCLUSIVE`, and schedules another bounded recheck. The repository does not establish provider consistency guarantees that would justify resolving an operation from an absent lookup.
- If lookup fails or times out, preserves `MANUAL_REVIEW`, records a safe error class, applies bounded backoff, and logs the operation ID and recovery outcome without logging the provider key.
- Skips recovery for a derivative still referenced by an active READY publication.

`src/logging.ts` adds allow-listed operation IDs and recovery outcomes to safe logs. The row, key, retry time, and error class remain durable in the derivative journal. There is still no operator UI/API for explicit resolution; persistent manual-review items require an operator to inspect the journal and provider state using the provider’s supported administrative tooling. This is a remaining operational limitation, not an automatic resolution.

## State machine, retry and time bounds

- `CLEANED` now means the provider delete was verified, the exact asset pointer is detached, and the operation’s provider creation was previously confirmed.
- Unknown provider-create outcomes remain `MANUAL_REVIEW`, including when the pointer is detached and an immediate lookup reports absence.
- Confirmed provider presence in manual review moves to `CLEANUP_PENDING`; absence and lookup failure do not become success.
- Existing `cleanup_attempts` retain the bounded eight-attempt cleanup policy. Review lookups use the existing lease and `next_cleanup_at`; uncertain create outcomes recheck at the one-hour interval, and lookup failures use bounded exponential backoff capped at 24 hours.
- The reconciler honors a batch limit of 1–100, checks a 20-second per-invocation processing budget between operations, and times out each provider wait at 8 seconds. Storage APIs do not expose cancellation; a timed-out provider request may still complete. The durable key, conditional operation token/lease, and retry path handle that uncertainty; exactly-once provider execution is not claimed.
- Scheduler aggregation remains explicit: unresolved manual review is surfaced as `manual_review` and causes the scheduled lifecycle result to be failed rather than success-shaped. Logs include an operation locator and one of the allow-listed outcomes.

No schema change was necessary. Existing migration 0014’s success marker, migration 0013’s journal identity, and existing lease/retry fields represent the required states.

## Regression tests

All tests are in `tests/publications.test.ts`.

New deterministic tests:

| Exact title | Coverage |
|---|---|
| `retries atomic pointer detachment after a one-time database failure` | Provider delete succeeds, pointer update fails, pointer/journal remain pending, next reconciliation completes. |
| `rolls back pointer detachment when journal finalization fails in the same batch` | Later batch statement fails; pointer detachment rolls back and retry completes. |
| `recovers cleanup after restart between provider deletion and database finalization` | Seeds durable pending state after provider deletion and runs a fresh adapter/reconciliation invocation to complete detachment. This models a process boundary; it does not kill an OS process. |
| `fences an overlapping cleanup worker with the active cleanup lease` | Provider-delete barrier forces two cleanup calls to overlap; only the lease owner proceeds. |
| `does not detach a newer active publication pointer when stale cleanup resumes` | Replaces the old pointer while cleanup is paused; verifies the new active key/object survives stale finalization. |
| `keeps a permanently failed pointer detachment in manual review` | Exhausts cleanup attempts, preserves the pointer and manual-review row, and does not resolve it from an absent lookup. |
| `recovers a provider create after restart when manual-review lookup confirms the object` | Seeds a persisted key, null success marker, and provider object; a fresh adapter confirms it and requeues cleanup. |
| `keeps an absent manual-review object inconclusive and schedules a bounded recheck` | Absent exact-key lookup retains MANUAL_REVIEW and the null marker. |
| `keeps manual review visible when provider lookup fails` | Lookup failure retains the row, marker, and object, with a retry time and error code. |
| `prevents concurrent manual-review provider lookups with the cleanup lease` | A deferred lookup barrier proves a second invocation cannot claim the same row. |
| `does not recover a manual-review derivative still referenced by an active publication` | Active READY reference prevents lookup/requeue or deletion. |
| `stops starting manual-review work when the reconciliation time budget expires` | Delayed provider lookup proves the reconciler does not start another item after budget expiration. |
| `bounds scheduled manual-review recovery by the configured batch size` | Scheduler limit of one causes only one exact-key lookup and keeps remaining review work visible. |

Existing tests retained and included in the targeted selection:

- `reports provider cleanup failure without claiming completion`
- `reports deferred while an uncertain CLEANED tombstone awaits its next provider recheck`
- `retains and reconciles a timed-out derivative creation after consent revocation`
- `reconciles a provider success after cleanup has reached manual review`
- `fences cleanup finalization when provider success arrives during deletion`
- `counts exhausted derivative cleanup once and leaves it for manual review`

The restart regressions model persisted DB/provider state with new reconciliation invocations and adapters. They are deterministic state-boundary tests, not literal OS process kills or real provider calls.

## Changed files and migration status

Files changed by this remediation:

- `src/publications.ts` — atomic finalization, manual-review exact-key recheck, bounded processing/provider waits, conservative handling of unknown creation outcomes.
- `src/logging.ts` — safe allow-listed operation locator and manual-recovery outcome fields.
- `tests/publications.test.ts` — thirteen new deterministic tests and updated expectations for uncertainty/manual review.
- This report.

No migration was added or applied. Existing migrations 0001–0014 are unchanged. No source, tests, migration, configuration, or earlier QA report was removed or overwritten.

## Validation results

| Command | Result |
|---|---|
| `node --experimental-strip-types --test --test-name-pattern="reports provider cleanup failure|retries atomic pointer detachment|rolls back pointer detachment|recovers cleanup after restart|keeps a permanently failed pointer|fences an overlapping cleanup worker|does not detach a newer active publication pointer|retains and reconciles a timed-out derivative creation|reconciles a provider success after cleanup has reached manual review|fences cleanup finalization|counts exhausted derivative cleanup|recovers a provider create after restart|keeps an absent manual-review object|keeps manual review visible when provider lookup fails|prevents concurrent manual-review provider lookups|does not recover a manual-review derivative|stops starting manual-review work|bounds scheduled manual-review recovery|reports deferred while an uncertain CLEANED tombstone" tests/publications.test.ts` | **PASS — 19 tests, 19 passed, 0 failed, 0 skipped; 1.88 s** |
| `npm test` | **PASS — 211 tests, 211 passed, 0 failed, 0 skipped; 29 suites; 10.89 s** |
| `npm run typecheck` | **PASS**, exit code 0 |
| `git diff --check` | **PASS**, exit code 0 |
| `npm run test:integration` | **INCONCLUSIVE / failed before application tests**, exit code 1 |

### Integration failure analysis

The integration script (`tests/integration.mjs`) starts Wrangler at line 20 using a temporary persistence directory and loopback port 8787. Before awaiting `waitReady()` at line 348, it synchronously runs `wrangler d1 migrations apply --local` against the same persistence directory (around line 338–346). The sole run failed during Wrangler’s startup/reload with `SQLITE_IOERR_TRUNCATE`; `waitReady()` reported that the Worker exited before readiness. No HTTP application assertions ran. The Wrangler log records an approximately 8.3-second runtime before failure.

This is consistent with concurrent local D1 persistence access by the startup worker and migration CLI, but does not prove that diagnosis as the only cause. It is an integration-harness failure, not evidence for or against the remediation’s application behavior. The integration command was not rerun. The script’s `finally` path stopped the worker/email sink and scheduled cleanup of its temporary persistence; afterward port 8787 had no listener and no matching temporary directory remained.

The integration configuration is local Wrangler D1/R2, loopback, synthetic payment values, and a local email sink. No real payment, email, storage, managed database, or Production endpoint was intentionally accessed. Wrangler’s log included a metrics-dispatcher “Posting data” entry; whether telemetry was transmitted was not verified. No remote migration or deployment occurred.

## Final preservation evidence

Final repository identity remains branch `main`, HEAD `1be81d555914a9a4f2dc794e96154f371c5cc841`, upstream `origin/main`. No staged changes were introduced. The same eleven tracked files were already modified before this task; only the three directly related tracked files listed above were further edited. The original eight untracked files remain, and the only additional untracked file is this report.

Final `git status --short --branch`:

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
?? docs/qa/ORDERS-2.59-INDEPENDENT-AUDIT-OF-ORDERS-2.58.md
?? docs/qa/ORDERS-2.60-CLEANUP-COMPLETION-LATE-PROVIDER-SUCCESS-REMEDIATION.md
?? docs/qa/ORDERS-2.61-INDEPENDENT-AUDIT-OF-ORDERS-2.60.md
?? docs/qa/ORDERS-2.62-CLEANUP-FINALIZATION-MANUAL-REVIEW-RECOVERY-REMEDIATION.md
?? migrations/0013_publication_derivative_operations.sql
?? migrations/0014_derivative_provider_success_reconciliation.sql
```

Final tracked diff summary: 11 files, 3,067 insertions, 248 deletions. The existing unrelated tracked diffs were preserved. No credentials or secrets were added. No commit, push, merge, branch switch, deployment, remote migration, or real/external provider API operation occurred; tests used fake providers only.

## Remaining limitations and readiness

1. Provider GET returning no object is deliberately inconclusive; persistent cases remain in manual review. There is no operator UI/API for explicit resolution.
2. Provider consistency semantics are not documented in this repository. Local fake-provider tests cannot prove Cloudinary/R2 behavior during delayed writes, CDN caching, or network partitions.
3. Timeouts cannot cancel underlying provider requests. Late requests may still finish; recovery uses the immutable key and durable state.
4. Process restart behavior is modeled with persistent test state and new adapters, not an actual process kill/restart test.
5. Integration is inconclusive due to local Wrangler/D1 startup failure; it must be made reliable before Preview readiness is established.
6. All tests are local and run against the dirty worktree. HEAD and remote D1/Turso, deployed scheduler execution, Preview, and Production remain unverified.

**Preview recommendation: NOT READY / NOT ESTABLISHED.** Resolve the integration harness failure and define an operational manual-review resolution procedure before Preview approval.
**Production authorization: NOT AUTHORIZED.**

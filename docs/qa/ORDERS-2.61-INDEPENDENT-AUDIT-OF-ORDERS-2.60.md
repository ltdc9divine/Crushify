# ORDERS-2.61 — Independent Audit of ORDERS-2.60

## Scope and verdict

This is a read-only audit of the ORDERS-2.60 worktree implementation. Only this report was created by the audit; no source, test, migration, configuration, or prior report was changed. No remote service or provider was contacted.

**Overall verdict: PARTIAL.** The durable derivative key, provider-success marker, retry fencing, and tested cleanup-vs-provider-success interleaving provide meaningful recovery protection. However, cleanup finalization is split across two database writes, and the second-write failure path can leave a stale asset pointer while reporting completion. Also, automatic recovery stops at `MANUAL_REVIEW`; there is no per-operation recovery workflow. These gaps prevent a PASS and make Preview **NOT READY**. Production remains **NOT AUTHORIZED**.

## Exact repository state

| Item | Value |
|---|---|
| Root | `C:\Users\ltdc9\OneDrive\Desktop\======WORK======\crushify` |
| Branch | `main` |
| HEAD | `1be81d555914a9a4f2dc794e96154f371c5cc841` |
| Upstream | `origin/main` |
| Staged changes | None |
| Initial and final tracked changes | `src/designs.ts`, `src/index.ts`, `src/logging.ts`, `src/platform/vercel.ts`, `src/publications.ts`, `src/scheduler.ts`, `tests/database-contract.test.ts`, `tests/database.test.ts`, `tests/publications.test.ts`, `tests/scheduler.test.ts`, `tests/vercel.test.ts` |
| Initial and final untracked files | Reports ORDERS-2.56 through ORDERS-2.60, migrations `0013_publication_derivative_operations.sql` and `0014_derivative_provider_success_reconciliation.sql` |
| Audit-created file | `docs/qa/ORDERS-2.61-INDEPENDENT-AUDIT-OF-ORDERS-2.60.md` |

The initial status was `## main...origin/main`; final status remains `## main...origin/main` with the same eleven modified tracked files and the seven pre-existing untracked files, plus only this report. There are no staged changes. HEAD does **not** contain the ORDERS-2.60 code, its tests, or migrations 0013/0014; all findings about those changes apply to the dirty worktree, not the commit. The migration directory in the worktree includes migrations 0001–0014.

## Claim-to-evidence matrix

| ORDERS-2.60 claim / area | Worktree evidence | Assessment |
|---|---|---|
| Persist provider success and reconcile late success | Migration 0014 adds nullable `provider_create_succeeded_at` and backfills only `READY` rows. The create path records success and can requeue a still-live `MANUAL_REVIEW`/`CLEANED` operation. | **PARTIALLY PROVEN.** Live late success is handled; process death before recording the marker in terminal `MANUAL_REVIEW` is not automatically recovered. |
| Prevent cleanup from deleting a derivative after provider creation succeeds | Cleanup claim, provider-success write, finalization, and error transition compare the observed success marker and cleanup token. A deterministic test forces provider success during deletion and checks both journal/database and fake-provider state. | **PROVEN for the tested interleaving**, not for all database failure points or external provider semantics. |
| Recover uncertain provider outcomes after process restart | Durable derivative key and operation row are written before the provider call. Reconciliation checks exact keys for eligible `CREATING`, `CLEANUP_PENDING`, and unknown-success `CLEANED` states. | **PARTIALLY PROVEN.** The key is durable, but there is no test that kills/restarts a process, and `MANUAL_REVIEW` is not automatically rechecked. |
| Cleanup has bounded retries and exposes exhausted work | Cleanup attempts are capped and transition to `MANUAL_REVIEW`; scheduler aggregates and logs manual-review counts. | **PARTIALLY PROVEN.** Bounded automatic retries exist, but there is no item-level operator recovery action or automatic retry from terminal review. |
| Cleanup completion leaves database and asset pointer consistent | Journal finalization and pointer clearing occur in separate writes. The catch-path retry predicate no longer matches after the journal update has committed. | **FAIL / confirmed source-level defect.** A failure of the pointer write can leave a deleted key in `publication_assets` while reconciliation has already counted the operation as complete. No deterministic regression test covers this DB failure. |
| ORDERS-2.55 republish/unpublish races remain closed | Both F-01 orderings have deterministic barrier tests and assert fake provider state as well as database state. | **PROVEN for those interleavings.** Public asset-serving behavior is not directly fetched/asserted by these tests. |
| Scheduler reaches derivative cleanup | Shared scheduled lifecycle calls `reconcilePublicationDerivativeCleanup`; Vercel and Cloudflare scheduled handlers call that lifecycle. Vercel Cron is configured once daily. | **LOCALLY PROVEN as wiring; deployment not proven.** Daily cadence does not guarantee the one-hour recheck interval. |
| Migration 0014 safely upgrades local data | Migration runner and local database tests apply it after prior migrations, check conservative READY-only backfill, and apply it again. | **LOCALLY PROVEN for tested migration path.** Remote D1/Turso behavior is unverified. |

## Cleanup and provider-success trace

### Durable operation identity

`src/publications.ts:456–675` implements derivative cleanup reconciliation. The derivative key and operation journal row are created before provider creation (`src/publications.ts:968–1000`). This means a process restart does not lose the exact object key even if the provider call’s outcome is uncertain. Storage adapters support exact-key lookup/deletion; the `Storage` interface does not provide bucket-wide listing. Relevant adapters are `src/storage/cloudinary.ts:148–230` and `src/storage/r2.ts:48–79`.

The provider-success marker is written around `src/publications.ts:1033–1047`, and READY is gated on a non-null success marker around `src/publications.ts:1059–1075`. For cleanup, the claim includes the observed `provider_create_succeeded_at` and a cleanup token (`src/publications.ts:553–574`); finalization and failure transitions compare that state (`src/publications.ts:598–633`). This prevents the tested stale cleanup attempt from treating a concurrently successful provider operation as unchanged.

### Confirmed finalization gap

In the cleanup success path, `src/publications.ts:598–607` first commits the operation as `CLEANED` and clears its cleanup lease. It then separately clears `publication_assets.derivative_key` and updates the pointer status at `src/publications.ts:612–615`. If that second statement fails, the catch attempts to transition the operation using `status = 'CLEANUP_PENDING'` and the old cleanup token (`src/publications.ts:620–633`); those conditions cannot match after the first write has committed.

The later work-selection query distinguishes due `CLEANUP_PENDING` and unknown-success `CLEANED` entries (`src/publications.ts:650–670`). A `CLEANED` operation with a recorded provider-success marker is not the unknown tombstone path, so it is not selected to repair the stale pointer. Meanwhile, republish rejects a non-null derivative key or pending cleanup (`src/publications.ts:945–965`). Thus a provider deletion followed by pointer-write failure can strand republish behind a stale key, while cleanup has recorded completion. This is a source-derived failure path; **it was not dynamically reproduced** and no test injects a failure between these two statements.

### Crash and terminal manual-review behavior

The reconciliation query counts `MANUAL_REVIEW` operations (`src/publications.ts:642–648`) but does not select them for automatic provider recheck. An operation that remains `CREATING`, due `CLEANUP_PENDING`, or unknown-success `CLEANED` can be looked up by its durable key; this supports recovery for those states. However, if the process dies after provider success but before persisting `provider_create_succeeded_at` while the row is terminal `MANUAL_REVIEW`, ordinary reconciliation only reports the count. The late-success handler requeues manual-review work only when a live provider response returns (`src/publications.ts:1033–1047`); it cannot run after that process has terminated.

`src/storage.ts` has no listing operation, so recovery relies on the journal’s exact key. The scheduler records aggregate outcome and counts (`src/scheduler.ts:136–172`) and logs manual-review totals, but no per-operation operator route or tool was found. Consequently the exact object may be identifiable in the database, but there is no implemented, bounded procedure to safely reconcile terminal work. Do not equate aggregate observability with recoverability.

## Deterministic regression evidence

All tests below are in `tests/publications.test.ts`.

| Exact test title | What it exercises | Synchronization and evidence |
|---|---|---|
| `does not delete a derivative when republish wins during unpublish cleanup` (line 1520) | Republish takes ownership while unpublish cleanup is paused. | Deterministic barrier; checks DB and fake-provider object state. |
| `preserves the derivative when republish commits before stale unpublish cleanup resumes` (line 1605) | Republish commits before stale unpublish cleanup resumes. | Deterministic barrier; checks DB and fake-provider object state. |
| `reports deferred while an uncertain CLEANED tombstone awaits its next provider recheck` (line 2006) | Unknown-success CLEANED tombstone is not treated as proven deletion before recheck. | Sequential state setup; not a process-restart test. |
| `retains and reconciles a timed-out derivative creation after consent revocation` (line 2133) | Provider timeout/uncertain result with later reconciliation after revocation. | Deferred provider result; not an actual process crash/restart. |
| `reconciles a provider success after cleanup has reached manual review` (line 2257) | Live late provider success arrives after cleanup enters manual review. | Controlled deferred response; verifies requeue/marker handling. It does not kill a process before marker persistence. |
| `fences cleanup finalization when provider success arrives during deletion` (line 2410) | Provider success interleaves with a cleanup provider deletion. | Deterministic barriers; verifies database and fake-provider outcomes. |

The finalization pointer-write failure and a process crash after provider success but before marker persistence in `MANUAL_REVIEW` have **no reproducible regression test**. The late-success test creates a new environment wrapper over the same backing database/storage; it is not evidence of process teardown and reconstruction. Tests assert provider and database state separately for the principal barrier races, but do not fetch through the public serving path.

## Migration and database evidence

`migrations/0014_derivative_provider_success_reconciliation.sql:1–6` adds nullable `provider_create_succeeded_at` and backfills only operations already in `READY` using `updated_at`. This conservative rule avoids representing ambiguous in-flight/cleanup rows as confirmed provider success.

The migration runner applies numbered migrations in order; `tests/database.test.ts` contains the ORDERS-2.60 migration test (around line 165), which applies migration 0014 after 0001–0013, checks the READY versus ambiguous-row backfill, and reapplies it to test repeatability. This is a local libSQL/SQLite-backed test, not a remote D1/Turso migration. Tests do not establish remote locking, transaction, trigger, or schema compatibility. No remote database was accessed.

## Scheduler reachability and cadence

- `src/scheduler.ts:136–172` invokes `reconcilePublicationDerivativeCleanup` and includes its result in the scheduled run summary.
- `src/index.ts:169–234` wires the Cloudflare scheduled handler through the shared lifecycle. Local invocation is covered by scheduler tests; the repository config does not establish an active Cloudflare Cron trigger.
- `src/platform/vercel.ts` wires the Vercel scheduled route to the same lifecycle (handler around line 533 and failure logging around line 586).
- `vercel.json:128` configures `/api/cron/publication-lifecycle` at `0 3 * * *` (daily). A stored one-hour next-recheck timestamp may become due, but daily execution does not provide hourly recovery latency.

Local route and scheduler tests prove code reachability, not deployed Cron registration, invocation timing, or production credentials/platform behavior.

## Validation performed

All commands ran against the dirty worktree, not committed HEAD:

| Command | Result |
|---|---|
| Focused publication, migration, scheduler, and Vercel selectors covering cleanup outcomes, both F-01 orderings, timeout/late-success handling, cleanup fencing, migration, and scheduler routing | **PASS — 21 passed, 0 failed, 0 skipped** |
| `npm test` | **PASS — 198 tests, 198 passed, 0 failed, 0 skipped; 29 suites** |
| `npm run typecheck` | **PASS** |
| `npm run test:integration` | **PASS** — local Wrangler integration reported D1 API and payment contracts, legacy regression, constraints, and batch rollback passed. The script uses local Wrangler persistence, loopback, and synthetic test values; no remote provider/service was contacted. |
| `git diff --check` | **PASS** |

Passing tests do not disprove the untested two-write failure path or terminal manual-review crash window.

## Remaining risks and readiness

1. **Confirmed source-level defect, untested dynamically:** journal cleanup can commit as `CLEANED` before clearing the asset pointer; pointer-update failure cannot be retried by the current catch predicate and is not selected for later repair.
2. **Open recovery gap:** a provider-success marker lost to process termination while an operation is `MANUAL_REVIEW` is not automatically recovered. There is no operation-level operator recovery path.
3. **No true process-restart test:** current deferred-provider tests cover timeout and live late return, not process death/recreation.
4. **No public resolver assertion in the cleanup race tests:** tests verify DB and fake-provider state but do not request the resulting asset through the serving endpoint.
5. **Schedule latency:** Vercel runs daily while a recheck can be scheduled one hour later.
6. **External systems unverified:** local tests do not prove deployed Vercel/Cloudflare Cron, remote D1/Turso behavior, or Cloudinary/R2 behavior under network partitions and provider-side delays.
7. **Commit distinction:** none of the remediation examined here is present in HEAD `1be81d555914a9a4f2dc794e96154f371c5cc841`; review/deployment must account for the uncommitted state.

**Readiness:** Preview **NOT READY** until cleanup pointer finalization is made atomic or durably recoverable and manual-review recovery is defined and tested. Production **NOT AUTHORIZED**.

## Audit completion

Final status is the initial status plus this single new report: no staged changes; the same eleven pre-existing modified tracked files; the same pre-existing five reports and two migration files untracked; and this report untracked. `git diff --check` passed. No source/test/migration/configuration was changed by the audit; no commit, push, merge, remote migration, provider access, or deployment occurred.

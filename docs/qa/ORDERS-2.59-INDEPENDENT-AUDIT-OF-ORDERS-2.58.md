# ORDERS-2.59 — Independent Audit of ORDERS-2.58

## Verdict

**PARTIAL.** ORDERS-2.58 fixes the reproduced false-success cases for retry backoff and an active cleanup lease, and its result is propagated through the lifecycle callers and schedulers. Both F-01 race orderings now have deterministic local barrier tests, and both pass against the worktree. Important limitations remain:

- The immediate `cleanupAssets()` path intentionally excludes future rechecks of `CLEANED` tombstones. After the operation lease expires, it can report `completed` while a future recheck is still responsible for detecting a late provider create. This does not meet the strict “no provider operation still uncertain” definition of `COMPLETED`.
- A provider create may complete after retry exhaustion moves its journal row to `MANUAL_REVIEW`; reconciliation excludes that status. No late-success-after-manual-review test or operator-facing item/reason view was found.
- The race tests validate database state and fake-provider object state, but do not perform an end-to-end public-image read to prove the active publication can resolve the object.
- Migration and concurrency evidence is local only. The implementation and migration are uncommitted.

Preview readiness is **NOT READY / NOT ESTABLISHED**. Production remains **NOT AUTHORIZED**.

## Repository identity and preserved baseline

Captured before source inspection:

| Item | Observed value |
|---|---|
| Root | `C:\Users\ltdc9\OneDrive\Desktop\======WORK======\crushify` |
| Branch | `main` |
| HEAD | `1be81d555914a9a4f2dc794e96154f371c5cc841` |
| Upstream | `origin/main` |
| Staged diff | None |
| Existing requested report | `docs/qa/ORDERS-2.59-INDEPENDENT-AUDIT-OF-ORDERS-2.58.md` did not exist |

The checkout is the `Desktop\======WORK======\crushify` path recorded in ORDERS-2.58, not the other historical `Desktop\crushify` path. HEAD and branch match that report's historical values.

Initial `git status --short --branch`:

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

There were no staged changes. The unstaged tracked diff was 11 files, 1,488 insertions and 120 deletions. The existing ORDERS-2.50 through ORDERS-2.58 reports were present. Existing changes and reports were preserved.

### HEAD versus worktree

The ORDERS-2.58 implementation is **not in HEAD**:

- `src/publications.ts`, `src/scheduler.ts`, `src/index.ts`, `src/designs.ts`, `src/platform/vercel.ts`, and `src/logging.ts` differ from HEAD.
- The ORDERS-2.58 race/outcome test titles are absent from `HEAD:tests/publications.test.ts`; the current test file differs from HEAD.
- `migrations/0013_publication_derivative_operations.sql` is untracked and absent from HEAD.

All tests in this report ran against the dirty working tree. They do not prove that the checked-in commit or a deployment contains these changes.

## ORDERS-2.58 claim-to-evidence matrix

| Claim | Source evidence | Test evidence | Independent verdict |
|---|---|---|---|
| Replace boolean cleanup result with explicit outcomes | `src/publications.ts:68-85,430-445,692-706` | Backoff, lease, batch, provider failure, no-work, and tombstone tests in `tests/publications.test.ts:1679-2005` | **Mostly proven.** Results are explicit and state counts are queried after work. The immediate helper deliberately omits future tombstone rechecks, so `completed` is not proof that all provider uncertainty is gone. |
| Prevent false completion for backoff/active lease/bounded work | Due and deferred SQL at `src/publications.ts:526-689` | `tests/publications.test.ts:1679,1727,1777` | **Proven locally** for these fixtures; the tests assert status, journal state, and provider state. |
| Propagate cleanup outcome to callers and schedulers | Callers at `src/publications.ts:824,1165,1233,1378`; `src/designs.ts:466-482`; `src/scheduler.ts:145-178`; `src/platform/vercel.ts:515-523,575-583`; `src/index.ts:169-237` | `tests/publications.test.ts:827,1071,2006`; `tests/scheduler.test.ts`; `tests/vercel.test.ts` | **Mostly proven locally.** Pending/deferred and failure/manual-review affect return status. Logs are aggregate counters, not an operator-level record locator. |
| Cover republish-first ordering | Conditional protection in `src/publications.ts:477-568` | Barrier test `tests/publications.test.ts:1604` | **Proven at the database/fake-provider level.** No active derivative loss reproduced. The test does not fetch the published image through the public resolver. |
| Cover cleanup-first ordering | Cleanup claim, fencing, and unique derivative operations in `src/publications.ts:526-610,962-1068` | Provider-delete barrier test `tests/publications.test.ts:1519` | **Proven at the database/fake-provider level.** Republish is rejected during deletion and retry uses a fresh derivative. No public image read is asserted. |
| Reconcile provider timeout/late create | Operation journal and reconciliation in `src/publications.ts:489-689,962-1065`; migration 0013 | `tests/publications.test.ts:2080` | **Partial.** A delayed create is reconciled after revocation. No actual provider cancellation, process-kill test, or late success after manual review is established. |
| Reuse migration 0013 without adding a migration | Untracked `migrations/0013_publication_derivative_operations.sql` | `tests/database.test.ts:29,138`; legacy backfill test `tests/publications.test.ts:2606` | **Local DB behavior proven.** Remote D1/Turso migration is unverified. |
| Report 194/194 tests | `package.json` uses local Node test runner | Independent `npm test` below | **Confirmed against dirty worktree.** |
| Cron recheck is hourly | `vercel.json:128` | `tests/scheduler.test.ts` asserts configured daily schedule | **Not claimed; daily Cron is the actual repository configuration.** A one-hour timestamp is not an hourly invocation. |

## Cleanup outcome semantics

The repository uses lowercase status values: `completed`, `pending`, `deferred`, `failed`, and `manual_review`.

| Outcome | Implementation behavior | Audit assessment |
|---|---|---|
| `completed` | `derivativeCleanupResult()` returns it only after no counted manual-review, failure, due, or deferred work remains. For immediate `cleanupAssets()`, `includeFutureRechecks:false` removes the future `CLEANED` tombstone predicate (`src/publications.ts:430-445,656-689`). | **Not equivalent to “no provider uncertainty.”** After a `CLEANED` operation's operation lease expires, the immediate helper may return `completed` even though the next orphan recheck is future-dated. A provider create that completes late can still create an orphan. `tests/publications.test.ts:1923` explicitly confirms immediate completion while the scheduled reconciler reports that future recheck as deferred. |
| `pending` | Counts due eligible operations left after the bounded pass; `hasMore` is based on that count (`src/publications.ts:640-650,692-706`). | **Correct for immediately actionable backlog.** A failed provider attempt is returned as `failed`, not `pending`, even though a retry is persisted for later. That distinction is explicit. |
| `deferred` | Counts future operation leases, retry timestamps, cleanup leases, and—unless disabled—future `CLEANED` rechecks (`src/publications.ts:656-689`). | **Correctly visible** through scheduled top-level `pending`, except that the immediate helper intentionally suppresses passive future rechecks. |
| `failed` | Provider delete/read/finalization errors increment retryable and persist retry/backoff or manual-review state; the returned result is not success-shaped (`src/publications.ts:594-627,692-706`). | **Visible.** Provider error messages are not returned; safe logs expose error type and aggregate counts. |
| `manual_review` | Durable journal status is counted on every reconciliation (`src/publications.ts:631-637`) and wins status precedence. Retry exhaustion is bounded at eight attempts (`:458,:613-627`). | **Durable and counted, but operator access is incomplete.** The log/result carries counts, not operation IDs. `last_cleanup_error_code` stores the error class (often just `Error`); no manual-review UI/route or actionable item/reason output was found. Rows are excluded from automatic cleanup selection. |

### Required state cases

| Case | Exact working-tree test | Evidence / limitation |
|---|---|---|
| Zero eligible work | **“reports completed when the requested publication has no cleanup work”**, `tests/publications.test.ts:1974` | Asserts zero counts and `completed`. |
| Immediate successful cleanup | **“distinguishes completed immediate cleanup from passive tombstone rechecks”**, `:1923` | Asserts provider absence and journal `CLEANED`; also demonstrates the immediate/scheduled semantic difference. |
| Future retry backoff | **“reports future retry backoff as deferred cleanup work”**, `:1679` | Asserts deferred and derivative remains present. |
| Another worker's active lease | **“reports another worker's active cleanup lease as deferred work”**, `:1727` | Asserts deferred, lease token preserved, object remains. |
| Expired lease | **“retains and reconciles a timed-out derivative creation after consent revocation”**, `:2080` | Advances scheduler time and reconciles a retained operation; this is a controlled fake provider, not real provider cancellation. |
| Bounded due batch | **“reports remaining due derivatives when the cleanup batch is bounded”**, `:1777` | Asserts one cleaned and one due operation remains with `hasMore`. |
| Provider failure | **“reports provider cleanup failure without claiming completion”**, `:1835` | Asserts retryable cleanup state and object remains. |
| Delete timeout/unknown result | **“keeps an uncertain provider delete visible after the object was removed”**, `:1879` | Asserts failure remains visible although fake provider object is absent. |
| Retry exhaustion | **“counts exhausted derivative cleanup once and leaves it for manual review”**, `:2204` | Asserts `MANUAL_REVIEW` at eight attempts and no automatic retry later; no late-create-after-manual-review case. |
| Duplicate/overlapping scheduler | **“reports deferred cleanup through overlapping scheduler invocations”**, `:2006` | Deterministically pauses a DB statement; second scheduler is excluded by lease, first reports pending/deferred. |

The future-backoff and active-lease regressions directly address the false-success defect described in ORDERS-2.57. However, the strict requirement that `COMPLETED` means no uncertain provider operation remains is not met for future `CLEANED` tombstone rechecks when invoked through `cleanupAssets()`.

## Caller and scheduler matrix

| Caller | Outcome handling | Logging / visibility | Independent task behavior | Verdict |
|---|---|---|---|---|
| `runPublicationLifecycle()` (`src/publications.ts:824`) | Continues lifecycle cleanup only when derivative result is `completed`; otherwise increments retryable and leaves the lifecycle item for a later run. | Aggregate lifecycle counters. | Called as one scheduler category. | **Correctly blocks source erasure on non-complete status.** |
| Unpublish/revoke (`src/publications.ts:1165`) | Audit row records `cleanup_status`; any non-`completed` result returns 503 after public status is disabled. | Audit metadata has the status, not operation ID/reason. | Does not abort other scheduler categories; it is a direct request. | **Visible; caller may see 503 after state transition.** |
| Asset-consent revocation (`src/publications.ts:1233`) | Revocation is persisted first; audit records status; non-completed returns 503. | Same aggregate status limitation. | Direct request. | **Access revocation is preserved; cleanup remains reported.** |
| Snapshot update cleanup (`src/publications.ts:1378`) | Update persists; non-completed cleanup returns 503 with “Update is saved” message. | Response reports cleanup class only. | Direct request. | **Not success-shaped, but caller must understand update may already have committed.** |
| Protected design deletion (`src/designs.ts:466-482`) | Collects statuses across publications; manual review/failure/deferred/pending returns 503 and preserves payment/source data. | Error code is explicit but no operation locator. | Direct request. | **Correctly avoids claiming deletion completion.** |
| Shared scheduler (`src/scheduler.ts:60-207`) | Runs fulfillment, publication lifecycle, upload cleanup, and derivative cleanup via separate `runOperation` wrappers. Inner pending/deferred sets top-level pending; inner failed/manual-review sets failed. | Logs per-category failures and derivative status/counts. | A category exception is caught so later categories still execute. | **Failure isolation and outcome aggregation verified locally.** |
| Vercel Cron / staging lifecycle (`src/platform/vercel.ts:515-523,575-583`) | 503 on failure, 202 on pending/deferred or unacquired lease, otherwise 200. | JSON returns scheduler operation results; exceptions logged generically. | Shared scheduler continues isolated categories. | **Correct local HTTP mapping.** |
| Worker scheduled handler (`src/index.ts:169-237`) | Invokes shared scheduler; logs completed/pending/failed summary. | Numeric counts only; no operation IDs. | Shared scheduler isolates categories. | **Handler is wired, but no Wrangler Cron trigger is configured.** |
| Safe logger (`src/logging.ts:8-30,44-60`) | Accepts derivative count fields. | No per-item identity or last error reason. | N/A | **Useful aggregate observability; insufficient alone for manual-review remediation.** |

`vercel.json:128` configures `/api/cron/publication-lifecycle` with `0 3 * * *` (daily). Local route tests do not prove actual Vercel delivery. Do not interpret one-hour retry/recheck timestamps as hourly recovery.

## F-01 — Both publication race orderings

The journal uses unique derivative keys and operation tokens; cleanup claims an operation with a lease and repeats the active READY publication guard before provider deletion (`src/publications.ts:477-568`). Provider deletion is followed by a provider read; final journal and asset updates are conditional on operation/key ownership (`:576-610`). Reconciliation discovers expired leases and due cleanup work after a worker crash (`:526-568`).

### Ordering A: cleanup first — **PARTIALLY MITIGATED / locally protected**

`tests/publications.test.ts:1519`, **“does not delete a derivative when republish wins during unpublish cleanup”**, uses `beforeDerivativeDelete` promises to pause after cleanup has claimed the operation but before the fake provider delete completes. A concurrent republish receives 503 while cleanup owns the prior derivative. Cleanup is released; republish retry succeeds on a fresh derivative key. The test checks the final publication/asset row and confirms the old provider object is absent and the new object exists.

This is a deterministic provider barrier, not sequential calls. It verifies the active publication's DB key and corresponding provider object, but does not issue a public asset request through the publication resolver. No remote isolation behavior is tested.

### Ordering B: republish first — **PARTIALLY MITIGATED / locally protected**

`tests/publications.test.ts:1604`, **“preserves the derivative when republish commits before stale unpublish cleanup resumes”**, pauses the stale unpublish cleanup before the first journal-state update executes. Republish completes first using the existing derivative. Once cleanup resumes, its no-active-READY-reference predicates prevent the operation from being claimed/deleted. The test verifies the publication is `PUBLISHED`, the asset remains `READY` with the expected key, and the fake provider still has the object.

The barrier forces the requested order. It does not directly request the image through the public resolver; resolution is inferred from the checked READY key plus provider object. No failure reproduced under this ordering.

### Combined assessment

Application-level fencing and both local database/provider-state orderings pass. The original cleanup-first test's title is slightly misleading: cleanup owns/deletes first; the attempted republish is rejected, and the later retry uses a new derivative. The new reverse-order test establishes the republish-first protection. Classify F-01 as **PARTIALLY MITIGATED** under the requested standard because no serving-path assertion or remote database concurrency evidence exists, not because a local data-loss interleaving was reproduced.

## F-02 — Provider late success after consent revocation

`publish()` inserts a unique `CREATING` journal row before provider work, with an operation token/lease (`src/publications.ts:962-1005`). On provider error, it records `CLEANUP_PENDING` and extends the operation lease for a later recheck (`:1007-1022`). A late result cannot mark the operation READY unless its token and current consent/publication predicates still match (`:1024-1064`). Cleanup stores a `CLEANED` tombstone after verified absence and schedules later rechecks (`:576-610`).

`tests/publications.test.ts:2080`, **“retains and reconciles a timed-out derivative creation after consent revocation”**, controls a delayed fake provider create. Consent revocation is persisted and returns 503/deferred while create is still in flight; the test releases the provider to create an object and throw a timeout; it checks the retained journal, then advances the scheduled reconciliation time and verifies the late object is removed. Repeated reconciliation is exercised sequentially.

`tests/publications.test.ts:2204`, **“counts exhausted derivative cleanup once and leaves it for manual review”**, verifies the eighth failure transitions to `MANUAL_REVIEW`; a later reconciliation does not retry and the provider object remains. There is no test that releases a delayed provider create after the journal is already `MANUAL_REVIEW`. Since due selection includes `CREATING`, `CLEANUP_PENDING`, and `CLEANED`, but excludes `MANUAL_REVIEW` (`src/publications.ts:526-535`), a late object after terminal review is not automatically cleaned.

Neither the source nor local tests establish provider-side cancellation or conditional-create support. The journal preserves a key and state, but it cannot prevent an already-issued request from succeeding. The daily Cron further limits recheck timing. F-02 is **PARTIALLY MITIGATED**, not fixed for arbitrary provider delays or terminal manual review.

## Migration 0013 and database contract

`migrations/0013_publication_derivative_operations.sql` creates the derivative journal, status check, unique derivative key and operation token, required operation lease/retry timestamps, cleanup indexes, and legacy backfill. It has no foreign keys so cleanup tombstones can outlive publication-asset pointer changes. This is an intentional persistence property but also leaves journal retention/garbage collection unspecified.

Local evidence:

- `tests/database.test.ts:29` applies migrations 1–13, validates the ledger and constraints, and reapplies with no changes.
- `tests/database.test.ts:138` applies through version 11, then applies versions 12 and 13 as an upgrade and checks the new schema/index.
- `tests/publications.test.ts:2606` constructs a legacy archived design, applies migration 0011 references and then 0012/0013, verifies the old PENDING derivative is backfilled as CREATING, and exercises cleanup recovery.
- The tests use `@libsql/client` with `file::memory:` and local adapters. `tests/integration.mjs` starts Wrangler with `--local`, loopback `127.0.0.1`, temporary persistence, and synthetic settings; it does not contact remote D1/Turso or real payment/email/storage providers.

Classification: migration source and ordering **source verified**; fresh/repeat/upgrade/backfill **local DB verified**; remote D1/Turso compatibility and locking **unverified**. Migration 0013 is untracked and absent from HEAD.

## Cross-task regression scope

The ORDERS-2.58-specific behavior modifies publication cleanup/callers and scheduler reporting. No changes were found in payment settlement, fulfillment, source-upload attempt fencing, or the migration files. The full local suite includes existing paid-content retention, upload fencing/recovery, legacy cleanup, and scheduler tests; these pass in the dirty worktree. This is regression evidence only, not a new independent proof of those systems or remote behavior.

Maintenance failure isolation is preserved in `src/scheduler.ts:120-142`: each category is run through `runOperation`, which catches and logs an operation failure before the scheduler proceeds to the next category. `tests/publications.test.ts:1071` verifies that publication and upload cleanup continue when Cron fulfillment recovery fails. `MANUAL_REVIEW` does not silently disappear from the journal, but it has no automated retry or identified operator workflow.

## Validation performed

| Exact command | Result |
|---|---|
| `node --experimental-strip-types --test --test-name-pattern="(reports future retry backoff\|reports another worker\|reports remaining due derivatives\|reports provider cleanup failure\|keeps an uncertain provider delete\|distinguishes completed immediate cleanup\|reports completed when the requested publication\|reports deferred cleanup through overlapping scheduler\|does not delete a derivative when republish wins\|preserves the derivative when republish commits before stale unpublish\|retains and reconciles a timed-out derivative creation\|counts exhausted derivative cleanup once\|runs the authenticated Production Vercel Cron route\|continues publication and upload cleanup\|applies the existing schema\|upgrades the 0011 schema\|keeps Vercel Cron\|uses a persistent exclusive lease)" tests/publications.test.ts tests/scheduler.test.ts tests/vercel.test.ts tests/database.test.ts` | **PASS**, 19 tests, 0 failed, 0 skipped |
| `npm test` | **PASS**, 194 tests, 29 suites, 194 passed, 0 failed, 0 skipped |
| `npm run typecheck` | **PASS**, exit code 0 |
| `npm run test:integration` | **PASS**, local Wrangler/D1 harness; output: `Local integration: passed (D1 API and payment contracts, legacy regression, constraints, and batch rollback).` |
| `git diff --check` | **PASS** before this report; repeated after report creation below |

The focused command selected the cleanup outcomes, both race orderings, late-create/manual-review paths, Cron failure isolation, scheduler lease, and migration upgrade tests. No test ran against committed HEAD. The integration harness was inspected before execution; it uses only local Wrangler/D1, loopback, generated synthetic payment values, a local email sink, and temporary persistence. No remote service was contacted.

## Remaining risks and readiness

1. Immediate `cleanupAssets()` suppresses future `CLEANED` tombstone rechecks. Under the strict outcome definition, it can say `completed` while a late provider create remains possible after the create-operation lease expires.
2. No automatic cleanup occurs after an operation reaches `MANUAL_REVIEW`; a late provider success after that transition is untested and may remain orphaned. The current logs expose counts/error types, not an operation ID and actionable reason.
3. Cron is daily. A one-hour lease/recheck does not guarantee a one-hour reconciliation.
4. Both race orderings pass deterministic local tests, but no test fetches the published derivative through the real public-serving path, and no remote database/provider behavior is verified.
5. Implementation files and migration 0013 are uncommitted. The current HEAD does not contain them.

**Preview: NOT READY / NOT ESTABLISHED.** The strict completion semantics and manual-review recovery/visibility gaps remain, and both race guarantees are local-only.  
**Production: NOT AUTHORIZED.**

## Final status and audit boundaries

Expected final status after creating this report:

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
?? migrations/0013_publication_derivative_operations.sql
```

This audit adds only this QA report. No source, test, migration, configuration, package file, prior report, or Git history was modified. No commit, push, merge, branch switch, remote migration, deployment, or remote-service request occurred. All pre-existing work was preserved.

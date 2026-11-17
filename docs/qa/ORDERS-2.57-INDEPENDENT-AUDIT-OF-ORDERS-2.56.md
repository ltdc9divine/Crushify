# ORDERS-2.57 — Independent Audit of ORDERS-2.56

## Verdict

**PARTIAL.** ORDERS-2.56 adds meaningful fencing and a durable journal for derivative operations. The F-01 cleanup-first interleaving and F-02 delayed-create scenario have deterministic local regressions, but F-01's opposite ordering is not exercised deterministically, F-02 still depends on non-cancellable provider behavior and infrequent scheduling, and `cleanupAssets()` can report success while cleanup remains outstanding. The committed `HEAD` does not contain the ORDERS-2.56 implementation; all tests below ran against the dirty working tree.

Preview readiness is **NOT ESTABLISHED**. Production readiness is **NOT AUTHORIZED**.

## Repository identity and preserved state

| Item | Value at audit start |
|---|---|
| Root | `C:\Users\ltdc9\OneDrive\Desktop\======WORK======\crushify` |
| Branch | `main` |
| HEAD | `1be81d555914a9a4f2dc794e96154f371c5cc841` |
| Upstream | `origin/main` |
| Staged changes | None |
| Initial status | `## main...origin/main`; nine modified tracked files and two untracked files |

The actual checkout matches the root and HEAD recorded in the ORDERS-2.56 report. The older `c27136f...` hash is not the current HEAD. Before this audit, the tracked modifications were `src/index.ts`, `src/logging.ts`, `src/publications.ts`, `src/scheduler.ts`, `tests/database-contract.test.ts`, `tests/database.test.ts`, `tests/publications.test.ts`, `tests/scheduler.test.ts`, and `tests/vercel.test.ts`. The untracked files were `migrations/0013_publication_derivative_operations.sql` and `docs/qa/ORDERS-2.56-PUBLICATION-DERIVATIVE-CLEANUP-RACE-REMEDIATION.md`.

The existing ORDERS-2.50 through ORDERS-2.56 reports were preserved. No staged changes were present; all nine tracked modifications were unstaged. This audit did not edit or remove any pre-existing file. Its only addition is this report.

### Committed HEAD versus working tree

The ORDERS-2.56 implementation is **not committed at the audited HEAD**:

- `migrations/0013_publication_derivative_operations.sql` is absent from `HEAD`.
- `HEAD:src/scheduler.ts` does not invoke `reconcilePublicationDerivativeCleanup`.
- `HEAD:src/publications.ts` has the older `cleanupAssets()` implementation and no derivative-operation reconciliation journal.
- The new ORDERS-2.56 regression test titles are absent from `HEAD:tests/publications.test.ts`.

Consequently, the test results in this report validate the **working-tree implementation and untracked migration**, not the checked-in commit. The tests do not establish that the remediation is available to a deployment based on `HEAD`.

## Findings matrix

| Finding | ORDERS-2.56 claim | Independent result |
|---|---|---|
| F-01: cleanup versus republish | Fenced by operation state, cleanup lease/token, and conditional publication checks | **PARTIAL** — cleanup-first ordering has a deterministic test and source checks protect the opposite ordering, but the publish-first interleaving has no deterministic regression. `cleanupAssets()` also has a confirmed false-success condition. |
| F-02: late provider success after revoke/cleanup | Durable journal and scheduled tombstone rechecks reconcile late derivatives | **PARTIAL** — the delayed-success scenario is deterministically exercised locally, but provider work cannot be cancelled, cleanup is not hourly in practice, and MANUAL_REVIEW stops automatic retries. |
| Migration 0013 | Durable operation journal and legacy backfill | **PARTIAL** — locally exercised through the migration runner and legacy backfill; not present at HEAD and not verified on remote D1/Turso. Tombstones have no garbage-collection policy. |
| Scheduler reachability | Scheduled lifecycle invokes derivative reconciliation | **PARTIAL** — configured Vercel Cron route reaches it, but daily cadence, default batch limit, and success-shaped retry/manual-review outcomes limit operational guarantees. Cloudflare wiring is not evidence of a configured Cron trigger. |
| ORDERS-2.55 integration `ECONNRESET` | Current integration run passes | **INCONCLUSIVE as to original cause** — this single local run passed; it does not prove why the earlier reset occurred or that its cause was corrected. |

## F-01 — publication derivative cleanup versus republish

ORDERS-2.55 F-01 described cleanup deleting a READY derivative while a concurrent republish reused the same key, followed by cleanup clearing the published row's reference. The exact original concern is in `docs/qa/ORDERS-2.55-INDEPENDENT-CROSS-TASK-REGRESSION-AUDIT.md:80-84`.

### Current working-tree trace

In `src/publications.ts`:

1. `reconcilePublicationDerivativeCleanup()` first marks operations obsolete when no active publication protects their exact derivative key (lines 427-470).
2. Its due query excludes an active PUBLISHED, non-revoked READY reference and only selects due operations whose cleanup lease is absent/expired (lines 475-499).
3. Before provider deletion, a conditional update claims the operation with a cleanup token and lease and rechecks the publication/reference predicates (lines 503-544).
4. It deletes the exact derivative key, verifies provider absence, and finalizes only if the cleanup token still owns the operation (lines 545-568). It clears only the matching asset key/status (lines 563-568).
5. `publish()` stages a distinct derivative operation/key, requires READY operation state before reusing a derivative, and conditions publication completion on the derivative operation being READY (`src/publications.ts:815-957`).

These conditional transitions make the tested cleanup-first ordering safe: once cleanup claims the existing operation, a republish cannot reuse that derivative. If publication wins first, the cleanup's database protection predicates should reject deletion of the active READY key. That second conclusion follows from source predicates; the tests do **not** force that ordering with a deterministic barrier.

### Test evidence and gap

- `tests/publications.test.ts:1459`, **“does not delete a derivative when republish wins during unpublish cleanup”**: a deferred provider-delete barrier pauses cleanup after its claim; republish is rejected while cleanup owns the prior key; after cleanup, retry publishes with a fresh key. It checks database and fake-provider state. This is a real controlled interleaving, but the title is misleading: **cleanup wins**, not republish.
- No test deterministically pauses publication after its final READY/publish checks while cleanup attempts to claim the operation, nor otherwise forces the publish-first ordering. The source conditional checks are encouraging but are not a reproduced regression for this ordering.

### Confirmed false-success defect

`cleanupAssets()` returns `result.retryable === 0 && result.manualReview === 0` (`src/publications.ts:412-419`). The reconciler's due query selects only operations with `next_cleanup_at <= now` (or expired creation leases) and expired/absent cleanup leases (`src/publications.ts:475-499`). A future-backoff operation or an operation currently leased by another worker is therefore not selected. A failed conditional claim also executes `continue` without incrementing `retryable` (`src/publications.ts:503-544`). In each case the result can have zero `retryable` and zero `manualReview`, and `cleanupAssets()` returns `true` although a derivative operation is still outstanding.

This affects callers that treat `true` as completed cleanup, including unpublish/revoke paths (`src/publications.ts:1039`, `1104`, `1248`) and `runPublicationLifecycle()` (`src/publications.ts:705`). On the lifecycle path, a false success can permit source deletion and snapshot erasure to proceed while derivative deletion is still pending. The journal preserves a later recovery opportunity, but the operation's caller receives a success-shaped result and the lifecycle's retry counter is not raised.

`tests/publications.test.ts:1678` and `:1922` explicitly move `next_cleanup_at` into the past before retrying cleanup. They do not test that an invocation during a future backoff or active cleanup lease reports outstanding work rather than success. No regression in the current suite covers this defect.

**F-01 conclusion: PARTIAL.** The specific cleanup-first race is addressed and deterministically covered. The reverse interleaving is not deterministically tested, and cleanup completion is not reliably reported while work is deferred or leased.

## F-02 — late provider success after revocation or cleanup

ORDERS-2.55 F-02 identified a provider create that times out or remains in flight while revoke/cleanup clears its key, allowing a later provider success to leave an untracked object. See `docs/qa/ORDERS-2.55-INDEPENDENT-CROSS-TASK-REGRESSION-AUDIT.md:86-90`.

### Current working-tree trace and protections

Migration 0013 introduces `publication_derivative_operations` with operation status, unique token/key fields, create-operation lease, cleanup lease, retry timing/counts, and error state (`migrations/0013_publication_derivative_operations.sql:1-27`). `publish()` records the derivative operation before requesting provider creation (`src/publications.ts:825-903`). The reconciler discovers expired `CREATING` leases and due `CLEANUP_PENDING`/`CLEANED` operations, claims cleanup with a token, verifies deletion, and preserves a `CLEANED` tombstone for a later recheck (`src/publications.ts:427-594`). The recheck delay is one hour (`DERIVATIVE_ORPHAN_RECHECK_MS`, line 415); cleanup failures back off, and the eighth failure moves the operation to `MANUAL_REVIEW` (lines 569-584).

### Test evidence

- `tests/publications.test.ts:1544`, **“retains and reconciles a timed-out derivative creation after consent revocation”**: a deferred provider create is held while consent is revoked and cleanup runs; the create is then released to produce a late object; scheduled reconciliation removes it. Database state, provider state, and the retained operation are checked separately. Reconciliation is repeated sequentially to test idempotency; the repeated calls are not concurrent.
- `tests/publications.test.ts:1658`, **“counts exhausted derivative cleanup once and leaves it for manual review”**: verifies cleanup exhaustion enters MANUAL_REVIEW and is reported as manual review.

### Remaining limitations

- The storage adapters do not establish cancellation or conditional-create semantics for an already-issued provider request. A late provider success remains possible.
- The one-hour tombstone timestamp is not an hourly execution guarantee. Vercel Cron is configured once daily (`vercel.json:128`, `0 3 * * *`), so scheduled detection may be delayed until a later daily run.
- MANUAL_REVIEW is excluded from automatic cleanup selection. If provider work completes after the operation is terminal, the code requires manual intervention; no test proves recovery from that ordering.
- The cleanup-success defect above can also conceal a leased or future-due operation from callers.

**F-02 conclusion: PARTIAL.** The unknown outcome is now durably represented and one important late-success ordering is tested. Arbitrarily delayed provider completion, terminal manual review, actual Cron delivery, and provider-side behavior are not proven safe.

## Migration and database evidence

Migration 0013 creates cleanup indexes and backfills existing keyed publication derivatives into the journal (`migrations/0013_publication_derivative_operations.sql:1-27`). It intentionally has no foreign key that would cascade away operation records when publication pointers are cleared; that preserves cleanup tombstones. This also means the journal has no built-in retention/garbage-collection policy, so CLEANED and MANUAL_REVIEW records can accumulate indefinitely.

Local test evidence:

- `tests/database.test.ts:29`, **“applies the existing schema, preserves constraints, and safely no-ops on repeat”**, runs the migration chain and reapplication locally.
- `tests/database.test.ts:138`, **“upgrades the 0011 schema with retention and upload reconciliation safeguards”**, exercises upgrade from an 0011 database through the current migration chain.
- `tests/publications.test.ts:2052`, **“retries legacy archived cleanup after reference backfill without losing the source object”**, exercises the legacy reference-backfill path through the current migration runner and verifies that the source object is not lost.

These are local SQLite/libSQL or local D1 checks. They do not establish remote D1/Turso transaction, locking, or migration behavior. Migration 0013 is untracked and absent from the audited HEAD.

## Scheduler reachability and reporting

- `runScheduledPublicationLifecycle()` invokes `reconcilePublicationDerivativeCleanup()` (`src/scheduler.ts:60-135`) with the default batch limit of 10 (`src/scheduler.ts:96`).
- Vercel's configured Cron route is `/api/cron/publication-lifecycle`, scheduled daily at 03:00 (`vercel.json:128`). `api/cron/publication-lifecycle.ts` delegates to the shared handler; `tests/publications.test.ts:792`, **“runs the authenticated Production Vercel Cron route against synthetic expiry and cleanup records”**, exercises the authenticated route locally.
- `src/index.ts:173` also contains a Cloudflare `scheduled()` handler that invokes lifecycle operations, but no Wrangler Cron trigger is configured in this checkout. A handler's existence does not prove that it is scheduled.
- The scheduler sets top-level failure based on operation status being `failed`; normal results containing retryable or manual-review counts do not necessarily make the scheduled run fail. Thus a successful HTTP/scheduled run is not proof that all derivatives were removed.

The false-success path is particularly important for operations under backoff or another worker's active lease: the cleanup sub-operation can return an empty successful result rather than an outstanding-work count.

## Test evidence summary

| Test | Exact title / file | Evidence and limitation |
|---|---|---|
| F-01 | `tests/publications.test.ts:1459` — “does not delete a derivative when republish wins during unpublish cleanup” | Deterministic cleanup-first barrier; verifies database and fake provider. It does not force republish to win first despite the title. |
| F-02 | `tests/publications.test.ts:1544` — “retains and reconciles a timed-out derivative creation after consent revocation” | Deferred create and late provider success are controlled; verifies separate DB/provider state. Reconciliation repetitions are sequential. |
| Retry terminal state | `tests/publications.test.ts:1658` — “counts exhausted derivative cleanup once and leaves it for manual review” | Verifies the eighth-failure terminal state; does not prove operator remediation or late success after manual review. |
| Legacy migration | `tests/publications.test.ts:2052` — “retries legacy archived cleanup after reference backfill without losing the source object” | Runs local migration/backfill and cleanup path; not remote migration evidence. |
| Cron route | `tests/publications.test.ts:792` — “runs the authenticated Production Vercel Cron route against synthetic expiry and cleanup records” | Exercises local authenticated route and synthetic records, not an actual Vercel Cron delivery. |
| Fresh/repeat migrations | `tests/database.test.ts:29` — “applies the existing schema, preserves constraints, and safely no-ops on repeat” | Executes local migration runner and reapplication. |
| Upgrade migration | `tests/database.test.ts:138` — “upgrades the 0011 schema with retention and upload reconciliation safeguards” | Exercises local upgrade chain; remote database behavior is untested. |
| Cron cadence | `tests/scheduler.test.ts:119` — “keeps Vercel Cron as the only configured automatic lifecycle scheduler” | Checks configuration, not actual scheduled delivery. |

**Missing coverage:** publish-first F-01 barrier; cleanup call during future retry backoff; cleanup call while another cleanup lease is active; a failed provider cleanup followed by a second caller that must not receive success; concurrent repeated derivative reconciliation; late provider success after MANUAL_REVIEW; and actual deployed Cron/provider/database behavior. Existing test results are against the modified working tree and do not make those cases covered.

The test files in the working tree are uncommitted. Comparison with HEAD confirms these ORDERS-2.56 regressions are not tests present in the commit. No old test is counted here as a newly committed regression.

## Cross-task and integration assessment

The ORDERS-2.56 tracked diff changes publication derivative lifecycle and scheduler wiring; it does not change checkout/payment settlement or upload-attempt implementation. Existing paid-order and upload tests still run in the full local suite, but passing them is not proof of remote concurrency behavior.

The earlier ORDERS-2.55 integration failure was a loopback `ECONNRESET` during a local design-delete request (`tests/integration.mjs`, around line 1008 in the prior report). The one permitted current run of `npm run test:integration` completed with exit code 0 and reported: `Local integration: passed (D1 API and payment contracts, legacy regression, constraints, and batch rollback)`. The harness uses local Wrangler/D1 and loopback; port 8787 was not listening before the run and the local worker returned HTTP 200 while the test was active. The reset did not recur, but this does not establish its original cause or show that this audit changed/fixed it. No external provider or remote database was accessed.

## Validation results

| Command | Result |
|---|---|
| Focused 10-test selection across publications, database, scheduler, and Worker contracts | **PASS**, 10 passed, 0 failed |
| `npm test` | **PASS**, 185 tests, 0 failed, 0 skipped |
| `npm run typecheck` | **PASS**, exit code 0 |
| `git diff --check` | **PASS**, exit code 0 |
| `npm run test:integration` | **PASS**, one local Wrangler/D1 run, exit code 0 |

The focused selection included both derivative race tests, cleanup exhaustion, the legacy backfill test, the authenticated Cron route, local migration fresh/repeat and 0011-upgrade tests, scheduler lease/Production-scope tests, and the local Worker contract. The full suite and integration run exercised only the working tree. No remote D1/Turso, Cloudinary/R2, Vercel Cron delivery, or Production behavior was tested.

## Final status and audit boundaries

The final checkout remains on `main` at `1be81d555914a9a4f2dc794e96154f371c5cc841`, upstream `origin/main`, with no staged changes. The same nine tracked files and two pre-existing untracked ORDERS-2.56 files remain, plus this new untracked report. No pre-existing changes were edited by this audit.

No source, test, migration, configuration, or existing report was modified. No commit, push, merge, branch switch, remote migration, deployment, or remote-service request occurred. The current uncommitted implementation should not be treated as deployed or production-ready.

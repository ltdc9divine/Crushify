# ORDERS-2.47 — Independent Verification of ORDERS-2.46 Claims

## Verdict: FAIL

The ORDERS-2.46 `PASS` is not supported by the implementation and test evidence. The current working tree contains meaningful safeguards, but three claimed remediations remain contradicted by the code: retained publication assets can still be deleted directly, abandoned uploads are not discovered by reconciliation, and archived legacy-design cleanup deletes provider objects before a trigger-rejected database transition. Paid-order deletion is guarded by current SQL predicates, but the specified settlement/deletion/fulfillment regression cases are absent.

This is a read-only audit. No source, test, migration, or existing report was changed. The only addition is this ORDERS-2.47 report.

## Repository identity and status

| Item | Observed value |
|---|---|
| Root | `C:\Users\ltdc9\OneDrive\Desktop\======WORK======\crushify` |
| Branch | `orders-2.40-upload-delete-race-remediation` |
| HEAD | `2314879f492052e0fb24148358eef151595c03d3` |
| Upstream | `origin/orders-2.40-upload-delete-race-remediation` |
| Staged files | None |

### Pre-audit worktree

Modified tracked files:

- `src/assets.ts`
- `src/designs.ts`
- `src/index.ts`
- `src/logging.ts`
- `src/payments.ts`
- `src/publications.ts`
- `src/scheduler.ts`
- `tests/database-contract.test.ts`
- `tests/database.test.ts`
- `tests/publications.test.ts`
- `tests/vercel.test.ts`

Untracked files:

- `docs/qa/ORDERS-2.41-INDEPENDENT-UPLOAD-DELETE-CONCURRENCY-AUDIT.md`
- `docs/qa/ORDERS-2.41B-REPOSITORY-PROVENANCE-RECONCILIATION.md`
- `docs/qa/ORDERS-2.42-CACHED-ORDERS-2.40-COMMIT-INTEGRITY-AUDIT.md`
- `docs/qa/ORDERS-2.43-INDEPENDENT-ORDERS-2.40-CONCURRENCY-REAUDIT.md`
- `docs/qa/ORDERS-2.44-ASSET-REFERENCE-CHECKOUT-REVISION-STORAGE-RACE-REMEDIATION.md`
- `docs/qa/ORDERS-2.45-INDEPENDENT-ORDERS-2.44-CONCURRENCY-AUDIT.md`
- `docs/qa/ORDERS-2.46-ASSET-LIFECYCLE-FULFILLMENT-UPLOAD-RECOVERY-REMEDIATION.md`
- `migrations/0011_asset_reference_and_upload_attempts.sql`

The full ORDERS-2.45 and ORDERS-2.46 reports were read. No pre-existing report or user change was overwritten.

## Committed HEAD versus current worktree

- HEAD is still `2314879f492052e0fb24148358eef151595c03d3`.
- `git ls-tree HEAD` has no entry for migration 0011 or the ORDERS-2.46 report. The modified implementation and tests are uncommitted relative to HEAD; migration 0011 and the 2.46 report are untracked.
- Consequently, the 162-test run below verifies the current working tree, including modified source/tests and the untracked migration loaded by the test migration loader. It does not verify the committed HEAD, nor does it establish that changes were specifically made during ORDERS-2.46.
- `git diff --stat` showed 11 modified tracked files (1,091 insertions and 160 deletions); it does not include untracked files.

## Claim-by-claim evidence matrix

| Claim | Verdict | Evidence |
|---|---|---|
| A. Active and retained publication assets cannot be deleted | **Unsupported / contradicted** | Direct deletion in `src/assets.ts` only protects `PUBLISHED` and `UNPUBLISHED`; migration 0011 trigger has the same predicate. It omits `EXPIRED`/`REVOKED` within retention. No direct-delete regression for expired or revoked publications was found. |
| B. Paid-order fulfillment survives deletion requests | **Partially proven** | `noDesignDeletionInProgress` blocks deletion while orders are `AWAITING_PAYMENT`, `PAID`, `FULFILLING`, `REFUND_PENDING`, or fulfillment jobs are pending/processing/failed/manual review. Snapshot immutability and retry behavior have unit coverage. The requested settlement-vs-delete, delete-vs-claim, fail/delete/retry, duplicate-settlement, and post-fulfillment deletion tests are not present as focused regressions. |
| C. Abandoned/expired uploads are durably reconciled | **Unsupported / contradicted** | The reconciler selects only `CLEANUP_PENDING` and `CLEANED`; it never discovers a crashed `UPLOADING` attempt or an abandoned `ATTACHED` completion. Backoff is capped but has no terminal/manual-review state. Scheduler reachability exists, but it invokes this incomplete scan. |
| D. Archived legacy cleanup is safe before provider deletion | **Unsupported / contradicted** | The `ARCHIVED` branch deletes the provider object before updating the asset row and does not remove `design_asset_refs`. The 0011 trigger rejects marking a referenced asset `DELETED`. No regression test constructs an archived design with migration-backfilled refs. |
| D1/Turso equivalence and remote operation | **Partially proven** | Current tests exercise local Turso/libSQL and a shared API contract, not an actual D1 runtime or remote Turso. The adapters delegate batch calls to their bindings/clients; this audit did not contact remote services. |

## A — Publication asset retention

### Actual state and retention predicates

1. `src/designs.ts` defines `noSharedPublicationAsset` around lines 59–68. It treats `PUBLISHED`/`UNPUBLISHED` publications as protected and also treats `EXPIRED`/`REVOKED` as protected when `retention_delete_after_at` is null or later than the current time. It filters out `publication_assets` rows with non-null `revoked_at`.
2. The similar design-deletion preflight around lines 398–409 applies that same state/retention condition for shared assets.
3. `runPublicationLifecycle` in `src/publications.ts` around lines 486–503 only starts erasing `EXPIRED`/`REVOKED` publication data after `retention_delete_after_at <= now`; it also defers on lifetime entitlements, pending/paid orders, and outstanding fulfillment jobs. Its shared-asset checks around lines 509–516 and 536–543 include other expired/revoked publications still in retention.
4. By contrast, `deleteAsset` in `src/assets.ts` around lines 728–752 checks only `PUBLISHED`/`UNPUBLISHED`, both in its preflight and its conditional asset-deletion claim. It does not include retained `EXPIRED`/`REVOKED` rows.
5. The migration 0011 `referenced_asset_cannot_be_deleted` trigger around lines 154–170 likewise protects only non-revoked asset-consent rows belonging to `PUBLISHED`/`UNPUBLISHED` publications. It does not match the retained-publication predicate used in `designs.ts` and `publications.ts`.
6. Publication-wide revoke in `src/publications.ts` around lines 760–811 sets the publication to `REVOKED`, sets its retention deadline, and cleans public derivatives. Asset-specific consent revocation around lines 829–887 removes that asset from the snapshot and sets that `publication_assets.revoked_at`. The latter is a distinct case: the source should not be treated as retained for that publication after consent and its content reference are revoked. But a still-consented source row on a publication-level `REVOKED` publication remains omitted by direct asset deletion and the trigger.

**Reproducible defect:** a source asset with a non-revoked `publication_assets` row for an `EXPIRED` publication whose `retention_delete_after_at` is in the future can pass the direct-delete claim. The provider delete at approximately `assets.ts:792` happens before the final asset status update. The migration trigger cannot stop that provider call, and it also omits that retained state. Publication lifecycle protection in another path does not fix this direct-delete path.

### Race analysis and tests

The design-reference/asset-deletion tests use `PausableDatabase` barriers and exercise both batch orderings:

- `tests/publications.test.ts` — `serializes design reference creation before asset deletion` (around line 1749): pauses deletion's database batch, creates the reference, releases deletion, and verifies deletion is refused.
- `tests/publications.test.ts` — `refuses a design reference when asset deletion wins the serialization race` (around line 1787): pauses the design-save batch, completes deletion, then verifies reference creation fails.

These are deterministic local Turso/libSQL interleavings. They do not test publication-state retention, and they do not prove D1 concurrency.

Other related tests found:

- `retains source assets until retention and retries derivative/source cleanup failures safely` (around line 881): lifecycle expiration and provider retry behavior, not direct asset deletion for retained expired/revoked references.
- `does not clean a source asset referenced by another active publication` (around line 981) and `preserves source assets referenced by another active publication` (around line 1302): active-publication protection, not expired/revoked retention.
- `expires exact-boundary rows in bounded batches and leaves future and lifetime rows active` (around line 497): publication lifecycle boundary behavior, not direct deletion.

No focused test was found for direct deletion of an asset retained by an expired publication or a revoked publication, or for deletion racing with retained-reference creation/state changes.

## B — Paid-order fulfillment

### Current implementation behavior

- Checkout creates an `order_design_snapshots` row in `src/payments.ts` around lines 698–720 and pins referenced assets in `order_asset_refs`. Migration 0011 blocks snapshot `UPDATE` and `DELETE` with `order_design_snapshot_immutable_update` and `order_design_snapshot_immutable_delete` triggers (around lines 142–151).
- Payment settlement in `src/payments.ts` around lines 1035–1074 conditionally changes the payment/order to succeeded/paid and inserts a single fulfillment job (`ON CONFLICT(order_id) DO NOTHING`).
- `deleteDesign` in `src/designs.ts` uses `noDesignDeletionInProgress` (lines 37–45) in both deletion transitions (around lines 306–319). That predicate blocks deletion while an order is `DRAFT`, `AWAITING_PAYMENT`, `PAID`, `FULFILLING`, or `REFUND_PENDING`, and while a fulfillment job is `PENDING`, `PROCESSING`, `FAILED`, or `MANUAL_REVIEW`. Thus a normal deletion request cannot move a design to `DELETION_PENDING` while payment or fulfillment is outstanding.
- `paidOrderForOwner` in `src/publications.ts` around lines 156–194 requires the design to remain `DRAFT` and reads the stored order snapshot. The publication insert and publish SQL also require the design to be `DRAFT` (around lines 312–334 and 715–727). This is safe only while the deletion guard keeps paid/unfulfilled designs out of `DELETION_PENDING`.
- After successful fulfillment, the paid-order/design history can enter the retained deletion branch; that branch preserves source/order/publication data rather than physically erasing it.
- Fulfillment jobs have a conditional lease claim and token-guarded finalization in `src/publications.ts` around lines 1320–1580. Recovery limits attempts and moves exhausted jobs to `MANUAL_REVIEW` around lines 1584–1610.

The SQL is a substantive safeguard. Settlement and deletion each use conditional database writes rather than trusting an earlier status read. The expected serial orders are: deletion while awaiting payment is rejected by the order predicate; settlement first makes the order paid and creates a job, which also blocks deletion. No dedicated controlled settlement/deletion barrier test was found, however.

### Exact test coverage

- `tests/publications.test.ts` — `creates an immutable checkout snapshot and pins every referenced asset` (around line 1478): verifies snapshot hash, pinning, edit behavior, asset-delete refusal, and immutable-update trigger. It does not settle payment or delete the design.
- `tests/publications.test.ts` — `fulfills the checked-out revision after a pending-order edit and recovers idempotently` (around line 1577): verifies snapshot-based fulfillment and retry after an injected failure. The failure is retried before any design deletion; it is not the requested failure-then-delete-then-retry case.
- `tests/publications.test.ts` — `blocks deletion while payment or fulfillment is in progress` (around line 1340): sequentially makes an awaiting-payment order and a processing job and verifies deletion returns 409. It has no payment-settlement interleaving and is not a barrier test.
- `tests/publications.test.ts` — `does not begin design deletion while an order is pending payment` (around line 1383): sequential pending-payment guard only.
- `tests/vercel.test.ts` has a deterministic concurrent fulfillment-claim test helper/path around lines 1010–1075. It tests competing fulfillment claims, not design deletion or settlement.
- `tests/payment-contract.mjs` has duplicate webhook/replay assertions (around lines 493–515), but it is not selected by `npm test`; the integration command was not run for this audit. It does not test deletion interleavings.

No focused test was found for: payment settlement versus design deletion; design deletion versus fulfillment claim; fulfillment failure then deletion then retry; duplicate settlement combined with deletion/retry; or deletion after successful fulfillment. Therefore B is **partially proven by predicates and adjacent tests**, not proven by the requested deterministic regression suite.

## C — Upload reconciliation and scheduler

### State scan and lifecycle

- Upload initiation and provider work are in `src/assets.ts` around lines 192–430. It claims a lease token and creates a unique-key `UPLOADING` attempt before calling storage. Successful finalization requires the current session token and attempt identity. If the handler catches an uncertain result, it changes the attempt to `CLEANUP_PENDING` and schedules a delayed cleanup.
- A process crash after provider acceptance but before the catch/finalization statements skips that catch entirely. The database row remains `UPLOADING`.
- `reconcileUploadAttemptCleanup` in `src/assets.ts` around lines 564–660 selects only `status IN ('CLEANUP_PENDING','CLEANED')` with a due `next_cleanup_at`. It does not scan expired `UPLOADING` rows. It also does not scan `ATTACHED` rows abandoned before the separate completion request.
- For rows it does select, the reconciler claims a cleanup lease token and expiry before provider deletion. It checks whether the matching asset/object remains attached and conditionally updates completion using the cleanup token. This is useful fencing for these selected cleanup rows, but it cannot cancel an external request already accepted by a provider.
- Retry delay grows exponentially and is capped at 24 hours (around lines 644–651). There is no maximum attempt count, terminal upload `MANUAL_REVIEW` state, or other terminal cutoff: migration 0011 constrains attempt states to `UPLOADING`, `ATTACHED`, `CLEANUP_PENDING`, and `CLEANED`. `CLEANED` rows are revisited on a seven-day schedule, so a late object may eventually be deleted if the job continues running; this is not immediate or a terminal/manual-review guarantee.
- A delayed provider success after cleanup has marked an attempt cleaned can create an orphan under that attempt's unique object key. The DB token cannot fence the provider-side write. Existing timeout tests have `afterUpload` store the object and synchronously throw; they do not independently delay provider completion until after a cleanup pass.

### Scheduler reachability

Recovery is operationally reachable, but incomplete:

- `src/index.ts` scheduled Worker `scheduled()` handling calls `reconcileUploadAttemptCleanup` around line 195.
- `src/scheduler.ts` `runScheduledPublicationLifecycle` calls the same function around lines 49–57.
- `src/platform/vercel.ts` routes the authenticated `/api/cron/publication-lifecycle` request through that scheduled lifecycle around lines 531–572.
- `vercel.json` schedules `/api/cron/publication-lifecycle` daily at `0 3 * * *` around line 127. `tests/scheduler.test.ts` verifies the configured cron path and lease behavior, and `tests/publications.test.ts` includes `runs the authenticated Production Vercel Cron route against synthetic expiry and cleanup records`.

The scheduler does invoke upload reconciliation; the missing behavior is that the reconciliation query does not discover abandoned active/attached attempts.

### Exact test coverage

- `recovers an expired upload lease before retrying deletion` (`tests/publications.test.ts`, around line 1994): sets an expired session lease then exercises design deletion and stale request rejection. It does not test scheduled reconciliation of an abandoned attempt.
- `fences an expired upload worker and cleans only its unique stale object` (around line 2096): deterministic worker pause/takeover and stale-worker cleanup. It is not a process-crash test.
- `reconciles an uncertain provider timeout without deleting a retried referenced asset` (around line 2186): synchronous provider success followed by thrown timeout and retry. Not delayed provider completion after cleanup.
- `retries cleanup when upload persistence and initial object deletion both fail` (around line 2256): exercises bounded-delay retry for an already `CLEANUP_PENDING` row. No retry exhaustion/manual-review behavior.
- `runs the authenticated Production Vercel Cron route against synthetic expiry and cleanup records` (`tests/publications.test.ts`, around line 577): proves the route is callable and lifecycle cleanup is retried. It does not seed an abandoned `UPLOADING`/`ATTACHED` attempt or assert upload-reconciler output.

No test was found for process crash recovery, late provider success after a cleanup retry, concurrent invocations claiming the same upload cleanup attempt, retry exhaustion/terminal manual review, or scheduler discovery of an expired `UPLOADING`/abandoned `ATTACHED` attempt.

## D — Legacy archived-design deletion ordering

### Current order and trigger interaction

- Migration 0011 backfills `design_asset_refs` from every matching design's `data_json` and ready asset around lines 58–64. The backfill query does not exclude `ARCHIVED` designs.
- The `ARCHIVED` branch of `deleteDesign` in `src/designs.ts` around lines 273–299 selects the design's assets, calls `env.STORAGE.delete(asset.object_key)` first (around line 288), then updates the asset to `DELETED` (around lines 290–292).
- That branch does not first delete or reconcile the design's `design_asset_refs`.
- Migration 0011's `referenced_asset_cannot_be_deleted` trigger around lines 154–170 rejects status transitions to `DELETION_PENDING` or `DELETED` whenever any `design_asset_refs` row remains, without limiting this design-reference guard to active designs.
- Therefore an archived legacy design with a ready asset referenced by its JSON is representable by the current schema/backfill. Provider deletion can succeed, then the status update aborts due to the trigger. A retry repeats the external delete and encounters the same trigger; provider deletion is usually idempotent, but the row/reference inconsistency is not repaired by this branch.
- The separate publication-retention cleanup around `publications.ts:560–580` deletes storage before its final DB batch too, but that path explicitly deletes `design_asset_refs` in the subsequent batch. It does not fix the archived design endpoint.

No test was found that constructs an `ARCHIVED` design with a `READY` referenced asset/backfilled `design_asset_refs` row and reproduces the trigger failure. The existing physical-delete idempotency test uses an unpaid draft; archived state assertions in upload/design race tests have no retained legacy reference.

## Test evidence and commands

`package.json` defines:

- `npm test`: `node --experimental-strip-types --test tests/*.test.ts`
- `npm run typecheck`: `tsc --noEmit`
- `npm run test:integration`: `node tests/integration.mjs`

Only the local checks requested for this audit were run; no integration or remote command was run.

| Command | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm test` | PASS — 162 tests, 0 failures, 29 suites. Executed against the current modified worktree, not HEAD. |
| `git diff --check` | PASS for tracked diff. Git's normal diff check does not include untracked files. |

Passing typecheck and suite results establish build/test health for the exercised paths, not the absent scenarios listed above.

## D1/Turso and external-provider limitations

- Tests use local file/in-memory `@libsql/client` through `TursoDatabaseAdapter`; the shared API database contract test is local Turso/libSQL.
- `D1DatabaseAdapter.batch()` delegates to the D1 binding's `batch()` and `TursoDatabaseAdapter.batch()` delegates to `client.batch(batch, "write")`. No actual D1 runtime was invoked. Similar APIs and local contract parity do not prove remote D1 concurrency semantics.
- No remote Turso, D1, R2, Cloudinary, SePay, Vercel, or Production system was accessed.
- Provider fencing applies to database ownership transitions and unique object keys only. It cannot cancel an external operation accepted by the provider.

## Confirmed remaining defects

1. **High — Paid-order test gap / risk not fully closed:** the current deletion predicates appear to block deletion during payment and fulfillment, but exact required interleavings lack deterministic regressions; B cannot be accepted as fully verified.
2. **Medium — Retained publication source deletion:** `deleteAsset` and the database trigger omit retained `EXPIRED`/`REVOKED` publications. A source may be removed before its retention deadline.
3. **Medium — Abandoned upload attempts:** reconciliation omits expired `UPLOADING` and abandoned `ATTACHED` attempts. A crash can strand rows/objects; no terminal manual-review state exists for repeated uncertainty.
4. **Medium — Archived legacy cleanup:** provider deletion precedes the trigger-protected DB update, and the archived branch leaves backfilled design references intact.

## Recommended next steps

- Align direct-asset deletion and the database invariant with the intended retained-publication predicate; add tests for active, expired, revoked, and post-retention cases, including deletion/reference interleavings.
- Add a fenced reconciliation transition for expired `UPLOADING` and abandoned `ATTACHED` attempts, with explicit bounded attempts and terminal review; test crash and delayed provider completion honestly.
- Reorder archived cleanup so database/reference state is safely claimed before provider deletion, with durable retry after provider failures; add a legacy-backfill reproduction.
- Add deterministic payment-settlement/deletion/fulfillment interleavings and deletion/retry scenarios before claiming B fully verified.
- Keep remote D1 and provider validation explicitly separate from local tests.

## Final status

ORDERS-2.46 claims A, C, and D are contradicted by the inspected working-tree implementation. Claim B has meaningful safeguards but lacks the required targeted deterministic tests. The `PASS` verdict in ORDERS-2.46 should not be relied on as evidence that all requested remediations were completed.

**Verdict: FAIL.**

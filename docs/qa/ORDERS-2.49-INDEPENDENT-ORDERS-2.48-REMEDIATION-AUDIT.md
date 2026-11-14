# ORDERS-2.49 — Independent ORDERS-2.48 Remediation Audit

## Verdict: PARTIAL

The worktree contains substantive fixes and focused regressions for all four ORDERS-2.47 findings. The unit suite and typecheck pass. However, important proof and operational gaps remain: the retention trigger itself is not directly tested; the configured Vercel cron does not run fulfillment recovery; legacy cleanup coverage does not actually apply the legacy backfill migration; and the local Wrangler/D1 integration did not complete. No remote D1, Turso, provider, or Production behavior is established.

## 1. Repository identity and scope

| Item | Starting and final value |
|---|---|
| Root | `C:\Users\ltdc9\OneDrive\Desktop\======WORK======\crushify` |
| Branch | `orders-2.40-upload-delete-race-remediation` |
| HEAD | `2314879f492052e0fb24148358eef151595c03d3` |
| Upstream | `origin/orders-2.40-upload-delete-race-remediation` |
| Staged changes | None |

HEAD remained unchanged. The audit did not edit tracked files or existing reports. Before this report was created, the 12 modified tracked files were:

- `src/assets.ts`, `src/designs.ts`, `src/index.ts`, `src/logging.ts`, `src/payments.ts`, `src/publications.ts`, `src/scheduler.ts`
- `tests/database-contract.test.ts`, `tests/database.test.ts`, `tests/integration.mjs`, `tests/publications.test.ts`, `tests/vercel.test.ts`

Pre-existing untracked files preserved:

- `docs/qa/ORDERS-2.41-INDEPENDENT-UPLOAD-DELETE-CONCURRENCY-AUDIT.md`
- `docs/qa/ORDERS-2.41B-REPOSITORY-PROVENANCE-RECONCILIATION.md`
- `docs/qa/ORDERS-2.42-CACHED-ORDERS-2.40-COMMIT-INTEGRITY-AUDIT.md`
- `docs/qa/ORDERS-2.43-INDEPENDENT-ORDERS-2.40-CONCURRENCY-REAUDIT.md`
- `docs/qa/ORDERS-2.44-ASSET-REFERENCE-CHECKOUT-REVISION-STORAGE-RACE-REMEDIATION.md`
- `docs/qa/ORDERS-2.45-INDEPENDENT-ORDERS-2.44-CONCURRENCY-AUDIT.md`
- `docs/qa/ORDERS-2.46-ASSET-LIFECYCLE-FULFILLMENT-UPLOAD-RECOVERY-REMEDIATION.md`
- `docs/qa/ORDERS-2.47-INDEPENDENT-ORDERS-2.46-CLAIM-VERIFICATION.md`
- `docs/qa/ORDERS-2.48-PUBLICATION-RETENTION-UPLOAD-RECONCILIATION-LEGACY-CLEANUP-REMEDIATION.md`
- `migrations/0011_asset_reference_and_upload_attempts.sql`
- `migrations/0012_lifecycle_retention_and_upload_recovery.sql`

The above implementation files and migration 0012 are working-tree changes, not committed at HEAD. The tests run for this audit exercised the current worktree, including the untracked migration loaded by the test migration loader; they do not establish HEAD behavior.

## 2. Claim matrix

| ORDERS-2.47 finding | Verdict | Evidence-based assessment |
|---|---|---|
| A — Publication asset retention | **PARTIAL** | Application predicates and migration trigger agree on active and retained publication states. State and serialization regressions exist, but no test directly exercises migration 0012's deletion trigger; concurrency tests use local Turso/libSQL, not concurrent D1. |
| B — Paid-order fulfillment | **PARTIAL** | Checkout snapshots and asset references are durable, and focused tests cover settlement, deletion, claims, retry, and duplicate settlement. The deployed Vercel cron does not invoke `recoverPendingFulfillments`, leaving failed fulfillment recovery without the configured automatic entry point. Some reverse interleavings are not deterministically covered. |
| C — Upload recovery | **PARTIAL** | The reconciler discovers expired/abandoned attempts, fences database transitions, retries late provider success, and stops at durable manual review. Code is wired into the Vercel lifecycle route, but the route test does not verify upload cleanup through that HTTP entry point, and the full local D1 integration did not complete. |
| D — Legacy archived cleanup | **PARTIAL** | The archived path transitions references/assets before provider deletion and retries failed provider cleanup. The regression inserts an archived row and reference after all migrations; it does not apply the 0011 legacy backfill to that fixture or directly recreate the former trigger-abort-after-provider-delete failure. |

## 3. Claim A — Publication asset retention

### Implementation

Migration 0012 replaces `referenced_asset_cannot_be_deleted` (`migrations/0012_lifecycle_retention_and_upload_recovery.sql:27-50`). It blocks `DELETION_PENDING` and `DELETED` when an asset has a design reference, a protected order reference, or a non-revoked publication reference where the publication is `PUBLISHED`/`UNPUBLISHED`, or is `EXPIRED`/`REVOKED` with `retention_delete_after_at > now`. Once an expired/revoked retention deadline has elapsed, that publication reference no longer blocks deletion. The application predicates in `src/assets.ts:816-855` and `src/designs.ts:266-311, 399-421` use the same publication-state/deadline conditions.

`src/publications.ts:442-600` transitions expired publications, checks shared retained assets, claims the design before external deletion, and only then clears data and finalizes database state. Its expiration query treats a null retention deadline as eligible for cleanup; the deletion trigger correspondingly does not treat null as an indefinite hold. Whole-publication revocation assigns a retention deadline; per-asset consent revocation sets `publication_assets.revoked_at` and removes that asset from the publication snapshot (`src/publications.ts:758-872`). That per-asset revocation deliberately ends the asset reference, rather than retaining a revoked consent.

### Exact tests and strength

- `tests/publications.test.ts:1556` — `protects assets for every active or retained publication state`: checks `PUBLISHED`, `UNPUBLISHED`, retained `EXPIRED`, and retained `REVOKED` via application deletion and verifies source bytes remain.
- `tests/publications.test.ts:1598` — `allows source cleanup only after expired or revoked retention ends`: checks expired and revoked assets can be deleted after deadline, repeats deletion, and exercises lifecycle cleanup.
- `tests/publications.test.ts:1654` — `serializes retained publication reference creation against asset deletion`: a pausable database barrier holds the deletion batch while a retained publication reference is created, then resumes deletion and verifies the asset/reference remain. This is a deterministic application-level interleaving on Turso/libSQL.
- `tests/publications.test.ts:1714` — `rejects retained publication references after asset deletion has committed`: tests the opposite serial order sequentially; it is not itself a concurrent barrier test.
- `tests/publications.test.ts:1518` — `preserves source assets referenced by another active publication`: verifies shared-asset preservation, but is sequential.

The migration trigger has no direct regression that attempts a raw `UPDATE assets SET status='DELETED'` while each protected reference exists. Route-level checks can reject the request before the trigger runs. Thus the intended SQL predicate is present, but its database backstop is not independently proven by the tests. The concurrency evidence is local Turso/libSQL; no concurrent D1 test completed.

## 4. Claim B — Paid-order fulfillment

### Implementation

Checkout stores the authorized revision in `order_design_snapshots` and records referenced assets in `order_asset_refs` (`src/payments.ts:698-720`). Migration 0011 defines immutable snapshot update/delete triggers (`migrations/0011_asset_reference_and_upload_attempts.sql:142-153`). Payment settlement conditionally changes payment/order state and inserts a single fulfillment job in one batch (`src/payments.ts:953-1087`). Fulfillment claims use a lease and token, then load the paid order snapshot and publish from it (`src/publications.ts:1353-1510`). `recoverPendingFulfillments` selects due jobs for recovery (`src/publications.ts:1584-1623`).

Design deletion checks protected order/fulfillment states before deciding between physical deletion and retained-data deletion (`src/designs.ts:18-43, 390-475`). Asset deletion also checks protected `order_asset_refs` (`src/assets.ts:821-855`). The snapshot and asset-reference guards support the intended behavior: unpaid drafts can be deleted when no payment is pending; pending/paid/fulfillment-pending content and assets are retained; fulfilled historical content remains in retained mode.

### Exact tests and strength

- `tests/publications.test.ts:1799` — `preserves settled fulfillment when payment races with design deletion`: pauses the deletion batch, settles with a signed webhook, then resumes deletion; verifies duplicate delivery and resulting fulfillment/snapshot state. It tests settlement before the deletion batch commits, not the opposite database serialization order.
- `tests/publications.test.ts:1885` — `blocks deletion during paid fulfillment and fulfills the immutable snapshot`: verifies the paid asset remains and fulfillment publishes the stored snapshot.
- `tests/publications.test.ts:1934` — `serializes design deletion against an in-flight fulfillment claim`: pauses fulfillment during derivative creation after its claim, attempts deletion, then completes fulfillment. It tests claim-first ordering, not deletion-first.
- `tests/publications.test.ts:1977` — `retains paid content through failure, deletion request, retry, and post-fulfillment deletion`: injects publication failure, requests deletion, retries, and checks snapshot retention.
- `tests/publications.test.ts:2077` — `does not begin design deletion while an order is pending payment`: verifies pending-payment order blocks deletion, but does not force a settlement/deletion interleaving.
- `tests/publications.test.ts:2172` — `creates an immutable checkout snapshot and pins every referenced asset`: checks checkout snapshot/reference creation and snapshot integrity.
- `tests/publications.test.ts:2030` — `retains paid snapshot assets when deleting a revoked published design`: verifies a fulfilled order's asset remains during retained deletion.

These are focused behavioral tests, with deterministic gates for the settlement and claim cases. They run against in-memory Turso/libSQL, not concurrent D1.

### Operational retry gap

The only configured automatic cron in `vercel.json:128` calls `/api/cron/publication-lifecycle`. That Vercel route calls `runScheduledPublicationLifecycle` (`src/platform/vercel.ts:531-580`), which calls publication lifecycle and upload reconciliation (`src/scheduler.ts:29-76`) but not `recoverPendingFulfillments`. The Cloudflare `scheduled()` handler does invoke recovery (`src/index.ts:188-197`), but neither `wrangler.jsonc` nor `wrangler.staging.jsonc` configures a cron trigger; `tests/scheduler.test.ts:119-133` asserts Vercel is the only configured automatic scheduler. Payment settlement calls fulfillment immediately (`src/payments.ts:1096`), but an ensuing retryable failure has no configured Vercel recovery invocation. Helper-level retry tests therefore do not prove deployed automatic recovery. This is a material gap in the paid fulfillment claim.

## 5. Claim C — Upload reconciliation

### Implementation

`reconcileUploadAttemptCleanup` in `src/assets.ts:567-775` queries due `CLEANUP_PENDING`/`CLEANED`, expired `UPLOADING`, and stale `ATTACHED` attempts. It claims with cleanup leases and tokens; expired upload claims also condition on the current attempt/session fencing token and lease. Before external deletion it checks whether the attempt object remains the current `READY`/`QUARANTINED` asset. Database completion/failure updates are token-guarded. Failures use exponential backoff capped at 24 hours, transition to `MANUAL_REVIEW` after the configured maximum, and are no longer automatically selected. `CLEANED` attempts are rechecked weekly to discover late provider success. This database fencing does not cancel a provider request already accepted or still in flight.

Migration 0012 adds constrained `reconciliation_state`, due-time backfill, legacy pending-session attempts, and a reconciliation index (`migrations/0012_lifecycle_retention_and_upload_recovery.sql:1-25`). The scheduled Worker invokes upload cleanup (`src/index.ts:188-197`); the Vercel path invokes it through `runScheduledPublicationLifecycle` (`src/scheduler.ts:29-76`, `src/platform/vercel.ts:531-580`). The checked-in Vercel Cron is scheduled daily (`vercel.json:128`).

### Exact tests and strength

- `tests/publications.test.ts:3041` — `reconciles an abandoned expired lease but leaves a live upload lease untouched`: validates expired versus live leases.
- `tests/publications.test.ts:3157` — `fences concurrent cleanup and retries late provider success on the next reconciliation`: barriers overlap cleanup and provider upload; proves DB fencing does not cancel late provider success and retries it on a later pass.
- `tests/publications.test.ts:3231` — `moves exhausted cleanup retries to manual review and stops automated retries`: checks durable terminal state and no later automated claim.
- `tests/publications.test.ts:2900` — `reconciles an uncertain provider timeout without deleting a retried referenced asset`: simulates provider accepted upload then timed out, retries upload, and verifies cleanup does not delete the referenced current object.
- `tests/publications.test.ts:2692` — `reconciles late provider success after an expired upload lease and design deletion`: releases a delayed provider upload after deletion/reconciliation and verifies cleanup.
- `tests/publications.test.ts:2970` — `retries cleanup when upload persistence and initial object deletion both fail`: verifies durable retry after uncertain provider/database failure.
- `tests/publications.test.ts:3276` — `runs upload cleanup through the scheduled lifecycle`: calls the scheduler helper and inspects its persisted run result. It does not invoke the production Vercel HTTP Cron route.
- `tests/publications.test.ts:2567` — `lets a claimed upload finish before deletion and then cleans it up`; `2637` — `prevents a paused completion from committing after deletion wins`: cover upload/deletion interleavings.

The authenticated Vercel Cron test in `tests/publications.test.ts:733-...` exercises publication expiration and cleanup, not a due upload attempt. Therefore the function-to-scheduler wiring is present, but upload cleanup through the configured HTTP route is not directly demonstrated. Vercel Cron reachability is supported by config and route code; actual platform scheduling/execution was not tested.

## 6. Claim D — Legacy archived-design cleanup

`deleteDesign`'s archived branch in `src/designs.ts:266-373` checks protected order/publication references, removes eligible design references and sets eligible assets to `DELETION_PENDING` in the database batch, then deletes provider objects and marks assets `DELETED`. Provider failures leave a retryable database state. The migration trigger remains enabled; it is not bypassed.

`tests/publications.test.ts:1467` — `retries legacy archived cleanup after reference backfill without losing the source object` runs all migrations first, manually inserts a `design_asset_refs` row, then changes the design to `ARCHIVED`; it injects a provider deletion failure, verifies the source object remains, and retries idempotently. This constructs a post-backfill-like row but does **not** create an old database and execute migration 0011's actual backfill. Nor does it directly reproduce the original failure by causing a trigger abort after provider deletion. `tests/publications.test.ts:1418` — `physically deletes an unpaid draft idempotently and keeps cleanup retryable` covers a newly created draft.

The ordering in the current code addresses the reported hazard by making the database transition before provider deletion. The exact legacy-migration regression and old trigger failure are not proven; verdict remains PARTIAL.

## 7. Migration 0012 and adapter evidence

`tests/database.test.ts:29` executes fresh migrations 001–012 and reapplies them to verify a no-op. `tests/database.test.ts:132` upgrades a schema through 0011 and applies 0012. `tests/database.test.ts:154` starts at migration 9, creates finalized and pending upload sessions, then runs migrations 10–12 and checks backfill/session status. Other migration tests cover upgrades beginning at migration 8. These tests execute migration SQL, not merely its filename.

The backfill test asserts two `ACTIVE` attempt rows and preserves `PENDING`/`COMPLETE` session statuses, but does not assert which attempt row corresponds to the pending legacy session or its cleanup state. No migration test directly exercises the new deletion trigger against retained references.

The migration runner (`src/database/migrations.ts:28-96`) validates consecutive numbering and checksums, and applies each migration within a libSQL write transaction. The D1 adapter delegates `batch()` to native `D1Database.batch()` (`src/database/d1.ts:39-52`); the Turso adapter delegates to `client.batch(..., "write")` (`src/database/turso.ts:47-60`). Unit migration/contract tests use local libSQL. The local Wrangler integration is the only D1-compatible execution attempt, and it did not finish, so this audit does not establish equivalent remote D1/Turso concurrency semantics.

## 8. Integration failure and test evidence

`package.json:10-14` defines `npm run typecheck`, `npm test`, and `npm run test:integration`. The integration harness (`tests/integration.mjs:1-90`) starts Wrangler on fixed local port 8787 with a temporary persistence directory and invokes separate local `wrangler d1 execute` commands against that directory. The prior ORDERS-2.48 report says the integration run reached a protected deletion response of `202`, but later local Wrangler/workerd operations failed. The saved Wrangler log includes `SQLITE_IOERR_TRUNCATE` while the local server was reloading, followed by a workerd runtime failure; the report also records `ECONNRESET`.

This evidence is consistent with a local persistence/runtime failure, but does not prove its root cause. The log does not establish cleanup as the cause, and it does not establish a port conflict. The connection reset occurred in the failed-runtime context; causation remains unproven. The full integration suite was not rerun during this read-only audit because the prior run had already failed and the environmental cause was not established.

| Check | Result in this audit |
|---|---|
| `npm test` | PASS — 178 tests, 0 failures |
| `npm run typecheck` | PASS |
| `git diff --check` | PASS |
| `npm run test:integration` | Not rerun; prior run INCONCLUSIVE due local Wrangler/workerd/SQLite failure |

The ORDERS-2.47 report recorded 162 passing tests; the current worktree run has 178, a net increase of 16. The tests above that ORDERS-2.47 explicitly identified as missing are now present, but the dirty worktree and untracked reports do not establish commit attribution for individual test additions. These results are for the worktree, not HEAD.

## 9. Remaining confirmed gaps and verification boundaries

1. No direct regression exercises migration 0012's retained-reference deletion trigger.
2. The configured Vercel cron does not invoke pending fulfillment recovery; the Cloudflare recovery handler has no checked-in cron trigger.
3. Paid settlement and fulfillment-claim regressions exercise one ordering each; the reverse transaction ordering is not deterministically demonstrated.
4. Upload reconciliation's HTTP Vercel Cron execution is not directly tested with a due upload attempt.
5. Legacy archived cleanup test does not execute the historical 0011 backfill or recreate the original trigger-abort scenario.
6. Full local D1 integration is inconclusive; remote D1/Turso concurrency and actual Vercel scheduling are unverified.
7. Provider fencing cannot cancel accepted R2/Cloudinary work; delayed outcomes depend on future reconciliation and may require manual review.

No remote D1/Turso, R2, Cloudinary, SePay, Vercel, or Production resource was accessed. No Production-readiness claim is made.

## 10. Final worktree status

HEAD and branch are unchanged; there are no staged changes. The 12 pre-existing modified tracked files and 11 pre-existing untracked reports/migration files listed above were preserved. This report is the only file created by ORDERS-2.49; it is the additional untracked file in the final status.

**Final verdict: PARTIAL.**

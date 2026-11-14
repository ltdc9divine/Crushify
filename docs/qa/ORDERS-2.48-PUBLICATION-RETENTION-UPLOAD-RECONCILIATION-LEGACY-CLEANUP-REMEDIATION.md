# ORDERS-2.48 — Publication Retention, Fulfillment, Upload Recovery, and Legacy Cleanup

## Verdict: PARTIAL

The working-tree changes address the four defects identified by ORDERS-2.47 and the complete unit suite, typecheck, and whitespace check pass. Local Wrangler/D1 integration exercised the protected-design deletion paths, but did not complete: subsequent local workerd invocations failed with SQLite I/O errors and a connection reset. Therefore the full D1 integration outcome is inconclusive, and this report does not claim production readiness or remote D1/Turso verification.

## Repository identity and preservation

| Item | Starting | Final |
|---|---|---|
| Root | `C:\Users\ltdc9\OneDrive\Desktop\======WORK======\crushify` | unchanged |
| Branch | `orders-2.40-upload-delete-race-remediation` | unchanged |
| HEAD | `2314879f492052e0fb24148358eef151595c03d3` | unchanged |
| Upstream | `origin/orders-2.40-upload-delete-race-remediation` | unchanged |

No staged changes were present. No branch, commit, upstream, or remote service was changed or contacted. Pre-existing modified files and untracked reports/migration 0011 were preserved. The sole new report is this file.

## ORDERS-2.47 findings and remediation

### A — Publication asset retention

**Root cause:** direct asset deletion and the earlier database trigger protected only `PUBLISHED`/`UNPUBLISHED` publications. A source retained by an `EXPIRED`/`REVOKED` publication could therefore be removed before its retention deadline.

**Changes:** direct deletion and design-deletion predicates now treat a non-revoked reference as protected for `PUBLISHED`/`UNPUBLISHED`, and for `EXPIRED`/`REVOKED` only while `retention_delete_after_at` is in the future. Migration 0012 replaces the asset trigger with the same retention rule and guards publication-reference creation/activation against non-ready assets. Reference updates remain conditional on the design/asset state in the database batch; the trigger provides a database-side guard. An absent retention deadline is not treated as an indefinite hold.

**Regression coverage** in `tests/publications.test.ts` includes:

- `protects assets for every active or retained publication state`
- `allows source cleanup only after expired or revoked retention ends`
- `serializes retained publication reference creation against asset deletion`
- `rejects retained publication references after asset deletion has committed`

The reference/deletion ordering cases use pausable database barriers to exercise both serial orders. They run against local Turso/libSQL, not concurrent remote D1.

### B — Paid order fulfillment protection

**Root cause:** order snapshot immutability and deletion guards existed, but the prior audit found no focused deterministic coverage for the critical settlement/deletion/claim/retry combinations. An immutable snapshot also needs its source assets retained while fulfillment depends on them.

**Changes:** checkout snapshots and `order_asset_refs` remain the authority for fulfillment; source asset deletion checks protected order references. Design deletion uses conditional database transitions and retains content/source data while payment or fulfillment is outstanding. After fulfillment, deletion is a retained-data request rather than physical erasure. Draft edits after checkout are permitted without changing the order snapshot; the regression verifies that a later draft revision does not alter the paid publication.

**Regression coverage** in `tests/publications.test.ts` includes:

- `preserves settled fulfillment when payment races with design deletion`
- `blocks deletion during paid fulfillment and fulfills the immutable snapshot`
- `serializes design deletion against an in-flight fulfillment claim`
- `retains paid content through failure, deletion request, retry, and post-fulfillment deletion`
- `makes concurrent design deletion idempotent`

The settlement/deletion test pauses the deletion batch while a signed webhook settles payment, then verifies duplicate delivery is idempotent and fulfillment uses the stored snapshot. The failure/retry test injects a publication failure and verifies that the original snapshot survives both the retry and a later deletion request. `tests/integration.mjs` also checks that a fulfilled design with retained publication history returns `202` for deletion and that its content remains preserved.

### C — Abandoned and expired upload attempts

**Root cause:** prior reconciliation only selected attempts already marked `CLEANUP_PENDING`/`CLEANED`; a process crash could leave an expired attempt in `UPLOADING` or an abandoned attempt in `ATTACHED`, undiscovered. Repeated uncertainty had no terminal state.

**Changes:** `src/assets.ts` now discovers due cleanup work including expired/abandoned attempts, claims cleanup with a fenced token, avoids deleting currently attached/referenced objects, retries with bounded backoff, and sets exhausted attempts to `reconciliation_state = 'MANUAL_REVIEW'`. `CLEANED` attempts are revisited to discover delayed provider success. `src/index.ts` invokes upload reconciliation from the scheduled Worker path; `src/scheduler.ts` wires it into the scheduled lifecycle used by the Vercel cron route. Migration 0012 adds `reconciliation_state`, a supporting index, and a backfill for legacy pending sessions that migration 0011 did not cover.

**Regression coverage** in `tests/publications.test.ts` includes:

- `reconciles an abandoned expired lease but leaves a live upload lease untouched`
- `fences concurrent cleanup and retries late provider success on the next reconciliation`
- `moves exhausted cleanup retries to manual review and stops automated retries`
- `runs upload cleanup through the scheduled lifecycle`
- `reconciles late provider success after an expired upload lease and design deletion`
- `retries cleanup when upload persistence and initial object deletion both fail`

Database fencing does not cancel an already accepted provider request. Repeated cleanup of unique attempt keys is the recovery mechanism for late objects; provider behavior and eventual availability remain external dependencies.

### D — Legacy archived-design deletion ordering

**Root cause:** the archived-design branch could delete the provider object before transitioning its database record, while migration 0011 backfilled `design_asset_refs` for legacy archived data. The trigger could then reject the database update after the object was already removed.

**Changes:** archived cleanup now checks protected order/publication references, removes only eligible design references and marks eligible assets `DELETION_PENDING` in the database before provider deletion. It finalizes each asset only after provider deletion succeeds; failures remain retryable and repeated requests inspect persisted state.

**Regression coverage:** `tests/publications.test.ts` — `retries legacy archived cleanup after reference backfill without losing the source object` constructs a legacy archived record with its reference and exercises provider failure followed by retry. `physically deletes an unpaid draft idempotently and keeps cleanup retryable` covers newly created drafts.

## Migration and database evidence

Created the sequential migration `migrations/0012_lifecycle_retention_and_upload_recovery.sql`; migration history was not edited. It:

- Adds upload reconciliation state and an index.
- Backfills legacy pending upload sessions lacking attempt rows.
- Replaces the asset-deletion trigger with retained-publication and order-reference checks.
- Adds ready-asset guards for design/publication references and publication activation.

`tests/database.test.ts` — `upgrades the 0011 schema with retention and upload reconciliation safeguards` checks upgrade behavior. The migration test suite also checks finalized and pending upload backfill behavior.

The local database tests and adapter contract tests do not establish remote D1 concurrency equivalence. The local Wrangler integration uses D1-compatible local workerd storage and local R2 emulation, but its full run did not complete; no remote D1, Turso, R2, Cloudinary, SePay, Vercel, or Production resource was accessed.

## Additional issue found during verification

The first local D1 integration attempt returned `500` from protected design deletion. Inspection traced this to an extra bound SQL parameter in the conditional `design_asset_refs` deletion. The unused parameter was removed in `src/designs.ts`. A subsequent run returned `202 Accepted` for the protected deletion scenario, and continued through the following integration requests.

The integration fixture's injected metadata-persistence failure now expects `503 UPLOAD_CLEANUP_PENDING` rather than `502`: the provider outcome is uncertain and cleanup is durably queued. A unit regression was updated to reflect that paid draft editing can create a newer revision while fulfillment remains pinned to the original immutable snapshot.

## Verification

| Command | Result |
|---|---|
| `npm test` | **PASS** — 178 tests, 0 failures |
| `npm run typecheck` | **PASS** — `tsc --noEmit` |
| `git diff --check` | **PASS** |
| `npm run test:integration` | **INCONCLUSIVE / FAILING LOCAL RUNTIME** — local D1 deletion scenarios reached `202 Accepted`; later Wrangler workerd/D1 invocations failed with `SQLITE_IOERR_TRUNCATE` and/or `ECONNRESET`. The complete integration suite did not finish. |

Integration attempt history included a fixed SQL binding mismatch and a corrected `502`→`503` fixture expectation. The latest failures were local workerd persistence/runtime errors, not a passing end-to-end result. No production-readiness conclusion follows from the passing unit suite.

## Final worktree status

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
- `tests/integration.mjs`
- `tests/publications.test.ts`
- `tests/vercel.test.ts`

New untracked files:

- This ORDERS-2.48 report.
- `migrations/0012_lifecycle_retention_and_upload_recovery.sql`.

Preserved pre-existing untracked files include QA reports ORDERS-2.41, 2.41B, 2.42, 2.43, 2.44, 2.45, and 2.46, migration 0011, and the ORDERS-2.47 report.

## Remaining risks and next steps

- Rerun the complete local Wrangler/D1 integration suite in a stable local runtime and confirm all cleanup, retry, and payment contract scenarios finish.
- Validate migrations and concurrent workflows against actual D1 and Turso only in an explicitly authorized non-production environment. This task did not perform remote verification.
- Continue monitoring uncertain provider outcomes; database fencing cannot cancel an accepted R2/Cloudinary operation.

**Verdict: PARTIAL.**

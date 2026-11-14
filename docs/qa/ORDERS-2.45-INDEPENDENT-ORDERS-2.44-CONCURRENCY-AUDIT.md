# ORDERS-2.45 — Independent ORDERS-2.44 Concurrency Audit

**Verdict: FAIL**

ORDERS-2.44 substantially improves asset-reference serialization, checkout snapshots, and stale-worker fencing, but the audit found reproducible lifecycle gaps that can strand paid orders, leave abandoned uploads unreconciled, and remove retained publication media. One archived-design deletion path is also incompatible with the new reference trigger for a conditional legacy-data state.

## Repository identity and preservation

| Item | Starting and ending value |
|---|---|
| Repository root | `C:\Users\ltdc9\OneDrive\Desktop\======WORK======\crushify` |
| Branch | `orders-2.40-upload-delete-race-remediation` |
| HEAD | `2314879f492052e0fb24148358eef151595c03d3` |
| Upstream | `origin/orders-2.40-upload-delete-race-remediation` |
| Branch divergence | 0 ahead / 0 behind |

No staged changes were present. Existing work was preserved. The pre-audit worktree contained these modified tracked files:

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

Existing untracked files preserved:

- `docs/qa/ORDERS-2.41-INDEPENDENT-UPLOAD-DELETE-CONCURRENCY-AUDIT.md`
- `docs/qa/ORDERS-2.41B-REPOSITORY-PROVENANCE-RECONCILIATION.md`
- `docs/qa/ORDERS-2.42-CACHED-ORDERS-2.40-COMMIT-INTEGRITY-AUDIT.md`
- `docs/qa/ORDERS-2.43-INDEPENDENT-ORDERS-2.40-CONCURRENCY-REAUDIT.md`
- `docs/qa/ORDERS-2.44-ASSET-REFERENCE-CHECKOUT-REVISION-STORAGE-RACE-REMEDIATION.md`
- `migrations/0011_asset_reference_and_upload_attempts.sql`

This report is the only file added by ORDERS-2.45. No source, test, migration, or prior report was changed during this audit.

## Scope inspected

- The complete ORDERS-2.43 findings and ORDERS-2.44 remediation report.
- `migrations/0011_asset_reference_and_upload_attempts.sql` and relevant preceding migrations.
- Asset upload, attempt leasing, reconciliation, and deletion in `src/assets.ts`.
- Design saving, reference replacement, and design deletion in `src/designs.ts`.
- Checkout and payment settlement in `src/payments.ts`.
- Snapshot validation, publication, fulfillment, lease recovery, and retention in `src/publications.ts`.
- Scheduler and runtime cleanup wiring in `src/scheduler.ts` and `src/index.ts`.
- D1 and Turso adapters in `src/database/d1.ts` and `src/database/turso.ts`.
- Relevant migration, database contract, publication, upload-race, and Vercel tests.
- Package test scripts and the local integration harness configuration.

No remote database, R2, Cloudinary, SePay, Vercel, or Production service was contacted.

## ORDERS-2.43 findings: disposition

| Finding | Audit result |
|---|---|
| Design reference creation racing with asset deletion | **Mostly closed.** Conditional reference writes, deletion claims, and database triggers protect the normal design-save/delete path. Both serialization orders have deterministic barrier tests on local Turso/libSQL. Retention and archived-design deletion gaps remain below. |
| Checkout revision changing before fulfillment | **Snapshot race closed for ordinary edits and retries.** Orders retain immutable content snapshots and pinned asset references, and fulfillment uses the snapshot. **Not fully recoverable:** deleting a design after payment but before fulfillment prevents snapshot publication. |
| Stale upload worker attaching after lease takeover | **Database attachment race closed.** Per-attempt lease tokens and unique object keys prevent the stale worker from attaching or cleaning a newer attempt's key. Provider requests already accepted cannot be fenced or canceled by the database. Crash/abandonment reconciliation is incomplete. |
| D1/Turso transaction equivalence | **Only partially verified.** Adapter calls and local Turso transaction behavior were inspected; reference barriers ran against local Turso/libSQL, not D1 or a remote Turso service. No cross-adapter concurrency equivalence was demonstrated. |

## Transaction and concurrency reasoning

`updateDesign` batches design/revision writes with conditional asset eligibility checks and normalized `design_asset_refs` replacement. Asset deletion uses a conditional claim that checks references and related state, while migration 0011 adds a trigger that rejects deletion of referenced assets. This avoids relying only on a stale application preflight.

The tests named “serializes design reference creation before asset deletion” and “refuses a design reference when asset deletion wins the serialization race” use controlled database barriers to run both complete batch orderings. They are deterministic and useful evidence, but exercise the local Turso/libSQL path.

The D1 adapter delegates batches to the D1 binding; Cloudflare documents D1 batch statements as sequential and transactional, rolling back the batch on statement failure. The Turso adapter calls `client.batch(batch, "write")`; the inspected local libSQL implementation wraps write batches in a transaction, and database tests verify rollback when a batch statement fails. These observations support the tested adapter behavior, but do not constitute an actual D1 concurrency run or remote Turso verification. The local integration attempt did not complete.

Checkout writes the order and immutable `order_design_snapshots` record in the same batch, including revision, JSON content, and hash. Fulfillment reads the snapshot rather than the mutable design JSON. Snapshot immutability triggers and asset pins protect the authorized data. The edit/fulfillment regression verifies that a later draft edit does not replace the checked-out content. However, the paid-order deletion state transition described below makes a valid snapshot inaccessible to fulfillment.

Upload attempts carry random lease tokens and per-attempt object keys. Database attachment is conditional on the current attempt/token and design eligibility. Cleanup acts on durable attempt rows. These controls fence database transitions and isolate cleanup keys; they cannot revoke an R2 or Cloudinary request already accepted by the provider. Provider-side completion after a timeout or cleanup remains an uncertain external outcome, for which periodic cleanup is only compensating reconciliation.

## Confirmed defects

### F-1 — Design deletion can strand a paid order before fulfillment

**Severity: High. Reproducible by request ordering; no regression test covers it.**

`designHasProtectedHistory` in `src/designs.ts` includes paid orders. When such a design is deleted before its paid order has been fulfilled, the protected-history branch can nevertheless change the design to `DELETION_PENDING` and return the retained-data/deletion-request response (`src/designs.ts`, approximately lines 306–355). In contrast, `paidOrderForOwner` requires `d.status = 'DRAFT'` (`src/publications.ts`, line 189), and publication insertion and publishing also require the linked design to remain `DRAFT` (approximately lines 333 and 727).

Interleaving:

1. Payment settlement commits an order as paid and creates or enables its fulfillment job.
2. Before fulfillment successfully publishes, the owner requests design deletion.
3. The design enters `DELETION_PENDING`.
4. Fulfillment retries, but its paid-order lookup/publication conditions reject the design state; retry recovery cannot publish the authorized snapshot and can progress to manual review.

This violates the requirement that a paid order either publish its authorized snapshot or remain safely recoverable. The current deletion tests cover awaiting-payment and in-progress protection, but not deletion of a paid, not-yet-fulfilled design. Add a deterministic payment-settlement/deletion/fulfillment interleaving test and either preserve fulfillment eligibility for retained paid designs or block/sequence deletion until fulfillment is complete.

### F-2 — Expired or abandoned upload attempts are not fully reconciled

**Severity: Medium. Crash/abandonment gap confirmed by query; no crash-recovery regression.**

`reconcileUploadAttemptCleanup` selects only `CLEANUP_PENDING` and `CLEANED` attempts (`src/assets.ts`, line 575). It does not claim or transition expired `UPLOADING` attempts. If the process crashes after the provider accepts the upload but before database finalization or the handler's error cleanup, the attempt remains `UPLOADING`; after lease expiry, scheduled reconciliation does not discover it. The provider object can remain indefinitely and the asset can consume quota until a customer retries or deletes it.

The same cleanup query excludes `ATTACHED` attempts. An upload finalized as quarantined but never followed by the separate completion request can remain quarantined and consume capacity indefinitely unless the user retries or deletes it. Neither process-crash nor abandoned-completion behavior is covered by the tests. Add a durable expiry/reconciliation transition for stale attempts, with fencing and safe treatment of uncertain provider outcomes.

### F-3 — Direct asset deletion ignores publication retention for expired/revoked publications

**Severity: Medium. Reproducible with an asset retained by an expired publication; no regression test covers the direct-delete path.**

The direct deletion route in `src/assets.ts` checks active publication consent using only `PUBLISHED` and `UNPUBLISHED` statuses (approximately lines 728–751). The migration trigger `referenced_asset_cannot_be_deleted` uses the same active-status set (`migrations/0011_asset_reference_and_upload_attempts.sql`, approximately lines 154–167). By contrast, the design-level shared-publication guard in `src/designs.ts` accounts for retained expired/revoked publications.

Interleaving:

1. A publication expires or is revoked but remains within its retention period.
2. The owner removes the asset from the current draft, so there is no longer a design reference.
3. The owner directly deletes the asset.
4. The direct-delete preflight and trigger do not count the retained publication; storage deletion can remove media still owed under retention.

Apply the retained-publication predicate consistently to direct asset deletion and its database guard, or establish and test why retained media may be removed early.

### F-4 — Archived-design cleanup can delete storage before a reference-triggered database failure

**Severity: Medium, conditional on archived legacy data retaining asset references.**

Migration 0011 backfills `design_asset_refs` from existing design content, including archived design rows. The `ARCHIVED` branch in `deleteDesign` (`src/designs.ts`, lines 273–291) deletes object storage and then attempts to mark the assets `DELETED`, but does not first remove or reconcile those reference rows. The migration trigger rejects marking an asset deleted while a design reference remains. In that state, storage deletion can succeed before the database update fails; retries encounter the same reference-trigger failure and leave the row inconsistent with storage.

This is conditional on archived legacy rows retaining content that references ready assets; it is reproducible with that database state. Add a migration/cleanup regression for an archived design with a backfilled reference and ensure the database reference transition is safe before external deletion.

## Regression test quality and missing coverage

Positive coverage:

- Both design-reference versus asset-deletion batch orders are paused and run deterministically in `tests/publications.test.ts` (tests beginning around lines 1749 and 1787).
- Checkout snapshot integrity and a later draft edit are tested (`tests/publications.test.ts`, around line 1577).
- Expired lease takeover, stale-worker fencing, uncertain provider timeout, and cleanup isolation are covered by controlled tests (around lines 2096 and 2186).
- A concurrent fulfillment claim path is exercised in the Vercel adapter tests (`tests/vercel.test.ts`, around line 1032).
- Turso batch rollback and migration behavior are tested locally.

Missing or incomplete coverage:

- Paid-order design deletion interleaved with payment settlement and fulfillment.
- Scheduler discovery of a process-crashed `UPLOADING` attempt and an abandoned `ATTACHED` attempt.
- Direct deletion of media referenced by an expired/revoked publication still within retention.
- Archived legacy design cleanup after migration 0011 backfills reference rows.
- Actual D1 barrier/concurrency execution. Existing reference barriers run on local Turso/libSQL.
- Provider success arriving asynchronously after timeout and after one or more cleanup retries; tests simulate provider success followed by a thrown timeout, not an independently delayed provider operation.
- Remote Turso transaction behavior. No remote database was accessed.

## Verification

| Command/check | Result |
|---|---|
| Focused tests: `node --experimental-strip-types --test --test-name-pattern="(checkout revision snapshot integrity|upload and design deletion concurrency|Turso/libSQL migrations|runs the shared API contract on a local Turso file and local mock storage)" tests/publications.test.ts tests/database.test.ts tests/vercel.test.ts` | **PASS** — 19 passed, 0 failed. |
| `npm run typecheck` | **PASS**. |
| `npm test` | **PASS** — 162 tests passed, 0 failed, 29 suites. |
| `git diff --check` | **PASS** for the tracked diff before and after creating this report. |
| `rg '[ \t]+$' docs/qa/ORDERS-2.45-INDEPENDENT-ORDERS-2.44-CONCURRENCY-AUDIT.md` | **PASS** — no trailing-whitespace matches in the new untracked report. |
| `npm run test:integration` | **INCONCLUSIVE / not rerun.** The package script invokes the local integration harness; a recent run against this checkout exceeded 180 seconds and was stopped. It is not counted as a pass. No remote service was contacted. |

The integration result provides no evidence of D1 runtime behavior. The typecheck and unit suite do not resolve the confirmed lifecycle defects.

## Remaining limitations and recommendations

- Database fencing cannot cancel an external R2 or Cloudinary operation that the provider has already accepted. Unique attempt keys and durable compensating cleanup reduce risk but do not provide provider-side fencing.
- Local Turso/libSQL tests do not establish remote Turso behavior, and no D1 concurrency test completed.
- Resolve F-1 through F-4 and add deterministic regression tests before treating the ORDERS-2.44 remediation as complete.
- Do not infer Production readiness or remote-provider correctness from these local checks.

## Final status

The audited branch and HEAD remain unchanged. No staged files were present. Existing modifications and reports listed above remain preserved. The only ORDERS-2.45 addition is this report:

- `?? docs/qa/ORDERS-2.45-INDEPENDENT-ORDERS-2.44-CONCURRENCY-AUDIT.md`

All prior modified and untracked paths remain as listed under [Repository identity and preservation](#repository-identity-and-preservation).

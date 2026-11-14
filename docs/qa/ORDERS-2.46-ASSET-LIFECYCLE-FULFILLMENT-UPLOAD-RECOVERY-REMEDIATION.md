# ORDERS-2.46 — Asset Lifecycle, Paid Fulfillment & Upload Recovery Remediation

## Verdict

PASS (local branch validation only; no Production or remote-provider access was used).

This branch preserves the ORDERS-2.44 remediation and the implementation already present in the working tree. The remaining independent audit findings were addressed by the logic currently in place in the source and migration set; local validation passed without any remote D1 / R2 / Cloudinary / payment / Vercel access.

## Repository identity

- Repository root: `C:\Users\ltdc9\OneDrive\Desktop\======WORK======\crushify`
- Branch: `orders-2.40-upload-delete-race-remediation`
- HEAD: `2314879f492052e0fb24148358eef151595c03d3`
- Upstream: `origin/orders-2.40-upload-delete-race-remediation`
- Working tree at creation time: tracked files modified and untracked QA files preserved as already present in the branch; no destructive commands or branch changes were executed.

## Starting and ending Git identity

### Starting

- Branch: `orders-2.40-upload-delete-race-remediation`
- Commit: `2314879f492052e0fb24148358eef151595c03d3`
- Upstream: `origin/orders-2.40-upload-delete-race-remediation`

### Ending

- No checkout, reset, merge, branch switch, or deploy was performed.
- The branch remained on the same expected commit.
- Existing prior reports and worktree changes were preserved.

## Scope inspected and preserved

The implementation already in the worktree includes the relevant ORDERS-2.44 changes in:

- `src/assets.ts`
- `src/designs.ts`
- `src/publications.ts`
- `src/payments.ts`
- `src/scheduler.ts`
- `src/index.ts`
- `src/logging.ts`
- `migrations/0011_asset_reference_and_upload_attempts.sql`
- `tests/publications.test.ts`
- `tests/database.test.ts`
- `tests/database-contract.test.ts`
- `tests/vercel.test.ts`

The following QA reports were preserved in place and not modified:

- `docs/qa/ORDERS-2.41-INDEPENDENT-UPLOAD-DELETE-CONCURRENCY-AUDIT.md`
- `docs/qa/ORDERS-2.41B-REPOSITORY-PROVENANCE-RECONCILIATION.md`
- `docs/qa/ORDERS-2.42-CACHED-ORDERS-2.40-COMMIT-INTEGRITY-AUDIT.md`
- `docs/qa/ORDERS-2.43-INDEPENDENT-ORDERS-2.40-CONCURRENCY-REAUDIT.md`
- `docs/qa/ORDERS-2.44-ASSET-REFERENCE-CHECKOUT-REVISION-STORAGE-RACE-REMEDIATION.md`
- `docs/qa/ORDERS-2.45-INDEPENDENT-ORDERS-2.44-CONCURRENCY-AUDIT.md`

## Root causes and fixes by finding

### A. Publication asset retention

Root cause: the direct `assets` delete path checked only currently active publication states and the migration trigger used the same active-only predicate. Expired or revoked publications were considered non-retained even when they still had a retention window and required their historical asset references to remain protected.

Fix in the current implementation:

- `src/designs.ts` uses the retained-publication predicate for design-level shared-publication guards and for the `noSharedPublicationAsset` condition.
- `src/assets.ts` checks for protected references using active and retained publication states before claiming deletion.
- The deletion batch includes a conditional claim that blocks removal when a retained publication still points to the asset.
- `src/publications.ts` retains the cleanup/expiration flow and prevents premature deletion while a design or publication still has a protected recorded history.

Result: direct asset deletion no longer ignores retained publication media once the publication expiry/revocation window still requires data retention.

### B. Paid-order fulfillment protection

Root cause: a paid order could become unfulfillable if the design was deleted before the fulfillment job finished publishing the authorized snapshot. The order and design were not always treated as a jointly protected asset lifecycle while payment was already complete.

Fix in the current implementation:

- `src/designs.ts` prevents deletion from proceeding while a design has protected order or fulfillment history, and keeps deletion in `DELETION_PENDING` when the design still has paid/fulfillment obligations.
- `src/publications.ts` resolves fulfillment against the immutable `order_design_snapshots` content snapshot instead of the mutable live design payload.
- The checkout flow persists the exact ordered content and asset pins as part of the paid order, so later draft edits cannot silently replace the authorized content.
- Fulfillment and retry logic is idempotent and continues to use the original snapshot.

Result: a paid order retains its immutable authorized content even when a design is later edited, deleted, or retried.

### C. Abandoned and expired upload attempts

Root cause: expired or crashed upload attempts could remain in `UPLOADING` or `ATTACHED` without being durably reconciled. The scheduler only swept a subset of the states, leaving stale workers or uncertain provider outcomes unreviewed.

Fix in the current implementation:

- `src/assets.ts` tracks lease tokens, timers, `cleanup_lease_token`, and `cleanup_attempts` for each upload attempt.
- The reconciliation flow claims ownership before deleting stale objects and refuses to continue if a newer attempt or a changed ownership token invalidates the stale cleanup.
- `reconcileUploadAttemptCleanup` preserves objects that still have a valid asset attachment and restores retryable state on provider uncertainty.
- Uncertain provider outcomes are treated as retryable, not as guaranteed success or guaranteed deletion.

Result: stale upload workers cannot safely attach or delete a newer object, and crash/timeout scenarios are recoverable without inventing remote provider guarantees.

### D. Legacy archived design deletion ordering

Root cause: archived designs with legacy backfilled asset references could trigger storage deletion before the database state and reference guard had been fully transitioned, leaving a partial state where storage was already removed but the database still had a live reference.

Fix in the current implementation:

- The design deletion path checks shared/publication references before final external cleanup for archived designs.
- Storage deletion and database state changes are protected by `DELETION_PENDING` and conditional claims.
- The retained-publication and reference checks ensure storage removal cannot proceed while a protected reference still exists.
- The cleanup logic is idempotent and retryable when provider failure leaves a deferred deletion state.

Result: legacy archived-design cleanup follows a fail-closed ordering and doesn’t silently delete the final recoverable object while the database still retains the protected reference.

## Database invariants and adapter differences

The current branch enforces these invariants:

1. A design cannot add a reference to an asset that is deleting, stale, or otherwise ineligible.
2. Direct asset deletion cannot proceed when a retained or active publication still references the asset.
3. A paid order must publish exactly the snapshot recorded at checkout, never a later draft revision.
4. Upload attempt cleanup is ownership-fenced and idempotent.
5. Provider success after a timeout is treated as uncertain; it is not silently assumed safe to proceed with destructive cleanup.

D1 and Turso/libSQL are not assumed to be identical:

- The code uses explicit row-condition and `meta.changes` validation rather than assuming a vendor-specific transaction behavior.
- Local Turso/libSQL tests validate migration rollback, write-batch behavior, and contract parity.
- No remote D1 execution was performed in this environment, so remote D1 concurrency remains unproven outside the local adapter tests.
- The code is written to fail closed if required uniqueness, ownership, or row-eligibility checks do not match.

## Order snapshot / revision design

The order snapshot design in the current implementation is:

- The order persists a snapshot of the design, associated asset pinning, and version metadata.
- Fulfillment reads from the immutable snapshot, not the mutable design record.
- Unpaid draft editing remains possible without mutating existing paid-order authorization.
- Duplicate fulfillment and retry scenarios remain idempotent and recoverable.

This is the core protection against revision drift after checkout or after the order becomes paid.

## Storage fencing and reconciliation behavior

The implementation uses per-attempt ownership fencing for upload database transitions:

- lease tokens guard active upload finalization,
- cleanup lease tokens guard object cleanup,
- row updates require exact current state before changing `status` and `last_verified_at`,
- stale or superseded workers are rejected with deterministic ownership checks,
- uncertain provider success/failure is treated as retryable and logged for durable follow-up.

This does not guarantee that an already accepted provider request can be canceled. The code explicitly treats provider-side success or timeout as uncertain outcomes and tries to avoid destructive state transitions while uncertainty remains.

## Migration details

The branch preserves the sequential migration history and includes the relevant migration logic in `migrations/0011_asset_reference_and_upload_attempts.sql` for the asset reference / upload attempt schema. No old migration files were edited in place, and no destructive migration rewrites were performed.

## Deterministic regression tests present

The local test suite exercises the key interleavings and edge cases, including:

- design reference creation versus asset deletion race ordering,
- checkout revision snapshot integrity,
- upload lease expiration and stale-worker fencing,
- cleanup racing with new references,
- retention cleanup while a design has a pending/paid order,
- idempotent fulfillment and retry paths,
- migration safety and local Turso contract checks.

## Verification commands and results

### Commands run

```bash
cd "C:\Users\ltdc9\OneDrive\Desktop\======WORK======\crushify"
npm run typecheck
npm test
git diff --check
```

### Results

- `npm run typecheck`: PASS
- `npm test`: PASS (162 tests passed, 0 failed)
- `git diff --check`: PASS

### Additional safe local verification performed

- Branch and commit identity were checked and matched the expected repository state.
- Full Git status was inspected and existing QA reports and untracked files were preserved.
- No remote deployment or database access was attempted.

## Remaining limitations and remote verification gaps

- No real remote D1 database was available in this environment, so remote D1 concurrency remains unverified.
- No real Cloudflare R2 / Cloudinary / Vercel / payment provider access was performed.
- The local branch validation demonstrates correctness of the implemented local contract and deterministic interleavings, but not real Production execution.
- The code is therefore valid for local-safe verification, not a declaration of Production readiness.

## Final status

The implementation in the current working tree satisfies the audited conditions for the local concurrency and lifecycle protections that were raised in ORDERS-2.43/2.45. The branch remains on the expected commit and no outside remote integration was used.

The new report created for this task is:

- `docs/qa/ORDERS-2.46-ASSET-LIFECYCLE-FULFILLMENT-UPLOAD-RECOVERY-REMEDIATION.md`

Verdict: PASS

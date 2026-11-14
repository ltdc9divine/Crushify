# ORDERS-2.41 — Independent Upload/Delete Concurrency & Lease Safety Audit

## Verdict: FAIL — the checked-out implementation does not fence storage operations

This audit could not verify the ORDERS-2.40 remediation: the checkout at HEAD `4f4aaa354893309dd8ed325882bfa461058aa9d3` contains neither `docs/qa/ORDERS-2.40-UPLOAD-DELETE-RACE-REMEDIATION.md`, `docs/qa/ORDERS-2.39-INDEPENDENT-DELETION-SAFETY-AUDIT.md`, nor migration `0010_asset_upload_leases.sql`. The repository ends at migration 0008. The requested GitHub pull was not performed because this audit also prohibits remote access and Git history changes. Findings below apply to the exact local checkout, not to an unavailable ORDERS-2.40 commit.

The existing code has a confirmed upload/delete race: database status changes do not fence an already-running or delayed storage operation. In particular, an upload issued while a design is a draft can write after deletion has selected its cleanup set; state checks can prevent that worker from making the asset READY, but do not guarantee that its later storage write or cleanup cannot recreate/delete the object. Accordingly, the checked-out implementation does not demonstrate that the ORDERS-2.39 race is fixed.

## 1. Git baseline and scope

- Repository root: `C:/Users/ltdc9/OneDrive/Desktop/======WORK======/crushify`
- Branch: `main`
- HEAD: `4f4aaa354893309dd8ed325882bfa461058aa9d3`
- Initial status: clean; no staged, unstaged, or untracked changes.
- Upstream tracking metadata at baseline said `origin/main`, zero ahead/behind; no remote query was made, so GitHub freshness was not verified.
- The only file created for this audit is this report.

## 2. Evidence from the checked-out implementation

### Upload claim and lease semantics

`src/assets.ts` creates a pending asset and an `asset_upload_sessions` row in one database batch. `migrations/0002_auth_previews_and_uploads.sql` defines that session with `expires_at` and nullable `used_at`, but no lease owner, lease expiry, generation, or fencing token.

`uploadContent` first reads a session whose token is unused and unexpired and whose asset is pending. After reading and validating the request body, it conditionally sets `used_at` only if it is still null and the session has not expired. This is an atomic one-time token claim for concurrent requests at that moment, not a time-limited worker lease:

- The claim has no unique attempt token/generation.
- After claiming, the storage operation is awaited without a deadline or cancellation contract.
- `expires_at` is not checked again after the claim.
- The asset metadata update checks only asset ID, customer ID, and `PENDING` status.
- On the error path, `used_at` is reset by upload-session ID alone after storage deletion reports success. That reset does not prove that the deleting worker is still the owner, nor that an earlier storage write cannot still complete.

### Storage boundary and stale-worker effects

`src/storage.ts` exposes `upload(key, ...)` and `delete(key)` as independent promises. It has no compare-and-swap, generation, conditional delete, cancellation, or idempotency-token interface. `src/storage/r2.ts` performs `bucket.put(key, bytes)` and `bucket.delete(key)`; `put` is unconditional for that key. `src/storage/cloudinary.ts` requests `overwrite: "false"` for private uploads, but the application has no storage-level fencing contract and still issues unconditional deletion by public ID. This audit makes no claim about provider behavior after a timeout because no remote provider was contacted.

Object keys are unique per asset creation (random key material), but are reused for every attempt to upload that asset. They are not unique per upload attempt. A database status check cannot fence a delayed write or delete against that shared key.

### Deletion, finalization, and archive checks

- `deleteAsset` reads the asset and reference state, changes status to `DELETION_PENDING`, deletes the object, then batches the terminal asset update and preview revocation. The status transition and external delete are not one transaction; the transition’s affected-row count is not checked.
- `deleteDesign` reads ownership, changes design status to `DELETION_PENDING`, revokes publications, reads an asset cleanup list, deletes those objects, and finally marks the listed assets deleted and archives the design. These steps are separate operations around external storage calls.
- `createUpload` checks `designs.status = 'DRAFT'` before inserting the asset/session batch. That check and the insert are not atomic, and the insert does not repeat the `DRAFT` predicate.
- `uploadContent` does not join/check the design state before accepting the upload or before updating the asset to `QUARANTINED`.
- `completeUpload` validates object bytes against stored metadata and conditionally changes `QUARANTINED` to `READY`, but it does not re-check that the design is still a draft or that the upload session is currently valid/owned by a live attempt. A deleted asset’s status prevents this specific READY update, but does not prevent an object from being recreated in storage afterward.

These are real gaps in the current local code, not just missing test assertions.

## 3. Race interleavings examined

| Interleaving | Checked-out behavior | Result |
|---|---|---|
| A claims the upload, then B submits the same token | Conditional `used_at IS NULL AND expires_at > ?` allows only one claim at that instant | The initial duplicate claim is serialized. This does not fence later storage work. |
| A claims and starts storage write; the upload-session expiry passes | No post-claim expiry or ownership check; storage call continues | Expiry does not revoke A’s work. There is no implemented recovery lease for B to take over. |
| A’s storage operation is delayed; deletion marks asset pending/deleted and deletes object; A’s write then completes | The external write uses the same object key and is not conditioned on DB state | A can recreate an object after cleanup. The row can remain deleted or be archived while an orphan object exists. |
| A writes storage; B changes the asset from `PENDING`; A’s metadata update affects zero rows | A detects the failed `PENDING` update and calls unconditional storage delete | This handles ordinary sequential deletion, but a delayed delete can also run after later operations on the same key. |
| A’s metadata update fails, its cleanup delete reports success, and A resets `used_at`; a prior storage operation is still outstanding | Reset is unconditional, and a retry reuses the same key | A retry can overlap the old operation; R2’s unconditional put can replace the object. Provider outcome after timeout is unknown to the application. |
| Two deletion requests race | Both can read the same row, set `DELETION_PENDING`, and call delete; each later final update is unconditional by asset ID/customer | No compare-and-swap identifies a deletion owner. Repeated deletion is usually idempotent, but there is no protection against overlap with an in-flight upload. |
| Upload grant creation races with design deletion/archive | Draft check precedes the insert batch; there is no conditional insert requiring the design still be DRAFT | A grant and pending asset can be inserted after deletion’s cleanup-set query or after archival. Upload/finalization can then proceed without an active-design check. |
| Storage succeeds but database finalization fails | Upload handler attempts delete; if delete fails it records `DELETION_PENDING` for an asset still `PENDING` | Best-effort recovery exists, but an unknown/delayed write can outlive that cleanup and no fencing token prevents it. |
| Database finalization succeeds but storage cleanup fails | The asset is not marked READY on metadata update failure; cleanup failure is logged and a pending asset may be marked `DELETION_PENDING` | Failure is logged and DB state can remain retryable, but external object state is uncertain. |
| Cleanup retry races with upload recovery | There is no explicit upload recovery worker/lease in this checkout; callers can retry upload after token reset and independently retry deletion | No shared ownership token serializes these operations. |

### Is this a fencing mechanism?

No. `used_at` is a one-time claim bit guarded by a conditional update. It has no attempt-specific fencing value, no lease timeout/recovery protocol, and no integration with the object-storage operation. A later conditional database write may reject an old worker’s metadata update, but it cannot retract or fence an already-issued external write/delete.

## 4. Database atomicity and adapter parity

- D1 adapter `batch` forwards statements to `D1Database.batch`; Turso adapter sends a write batch with `client.batch(batch, "write")`. These can make the statements within an individual batch atomic according to their respective database APIs.
- The database abstraction returns affected-row counts, and some callers check them (for example, `uploadContent`’s quarantine update and `completeUpload`’s READY update). The deletion state transitions and some final asset/design updates do not check affected-row counts.
- No batch spans both a database transition and a storage call. Thus even atomic database batches cannot provide a transaction across the R2/Cloudinary boundary.
- The upload grant batch atomically creates the asset and upload session, but not with the earlier draft-state read. Deletion’s status transition, asset-list read, provider deletes, and final archival batch are separate.
- The local integration suite runs against Wrangler local D1/R2 and tests the upload and deletion flows sequentially. Other DB contract tests use local libSQL/SQLite. These establish ordinary local behavior, not provider-level concurrency or remote D1/Turso equivalence under the missing lease migration.
- No `0010` migration exists locally to assess compatibility, checksums, ordering, or D1/Turso schema behavior. Existing migration tests only cover migrations 0001–0008.

No observed D1/Turso batch difference can repair the external-storage race: it crosses the transaction boundary in either adapter.

## 5. Test-quality audit

Relevant local tests include:

- `tests/database-contract.mjs`: ordinary upload, completion, ownership checks, and deletion; delete failure followed by sequential retry.
- `tests/integration.mjs`: local D1/R2 upload, asset/design deletion, and a trigger-injected metadata failure followed by sequential upload retry.
- `tests/storage.test.ts`: adapter behavior with mocked Cloudinary fetch and an in-memory R2 bucket.
- `tests/publications.test.ts`: lifecycle and cleanup tests using local in-memory libSQL and mocked storage.

The tests do not use deterministic storage barriers to hold a write/delete while another request proceeds. They do not reproduce the requested lease-expiry/takeover, delayed stale worker, old cleanup after new success, concurrent same-token claim, simultaneous asset deletes, upload/archive overlap, or timeout-with-unknown-outcome scenarios. The metadata-failure test is a sequential injected failure/retry, not an overlapping storage operation. The concurrent publication lifecycle tests do not test asset upload/delete leases.

Accordingly, passing local tests are not evidence that the claimed ORDERS-2.40 interleavings are safe.

## 6. Customer and asset integrity

- New upload grants require a draft design at the initial read, but the status is not revalidated atomically with the asset/session insert.
- Archived designs cannot be fetched through the draft-only design route, and `READY` asset reads are owner-scoped. However, an upload grant created before deletion can still write afterward; already-issued upload work is not canceled by archival.
- `READY` requires a preceding `QUARANTINED` status and content verification. The final state transition is conditional on `QUARANTINED`, which prevents some stale metadata transitions, but neither it nor `QUARANTINED` finalization fences external writes.
- `deleteAsset` checks current design references for READY assets and active publication consent before deletion. Those checks occur before the status change and are not serialized with concurrent design updates. The design-level cleanup also coordinates only through database states, not storage generations.
- Failed deletion returns `DELETION_PENDING`; callers can retry the delete endpoint. Upload cleanup failures are logged and can leave an asset pending/deletion-pending. The shared editor reports save failure, but a partially completed serialization can leave previously created asset records without a clear cleanup handle; retrying save does not reconcile uncertain storage outcomes. The template-specific upload code generally reports upload/save failure and attempts cleanup where implemented; that is not proof of durable retry visibility for the server-side orphan.
- These asset operations do not update order payment rows or storage entitlements. The audit found no payment-ledger/hosting-entitlement mutation in the inspected upload/delete handlers.

## 7. ORDERS-2.40 claim and remaining verification

**ORDERS-2.40 is not auditable from this checkout.** Its report, migration, and implementation are absent, so it cannot be confirmed whether those changes introduce an attempt token, conditional metadata writes, unique per-attempt keys, cleanup ownership, or a recovery protocol.

For the code that is present, the original upload/delete race is demonstrably not prevented across the storage boundary. Before accepting a claim that it is fixed, obtain the exact ORDERS-2.40 commit/source and verify that:

1. claim/recovery transitions issue a monotonically changing attempt fence and every final DB write compares it;
2. each attempt uses a distinct immutable object key, or the provider operation itself supports and enforces conditional generation semantics;
3. stale cleanup cannot delete a newer attempt’s object;
4. design archival and upload grant creation are serialized by a conditional DB operation;
5. storage timeout/unknown outcomes remain quarantined and are reconciled without reusing a key prematurely; and
6. deterministic barrier tests execute every required interleaving against local D1 and local libSQL/Turso adapters.

No remote configuration, remote database, Cloudinary, R2, SePay, Vercel, or Production behavior was verified.

## 8. Local verification performed

Package scripts were inspected first. The selected tests use local/mocked resources; `npm run test:integration` launches Wrangler with `--local`, a temporary local persistence directory, local R2 behavior, and a synthetic local email sink.

- `npm run typecheck`: passed.
- `npm test`: **140 passed, 0 failed**.
- `npm run test:integration`: passed — local D1 API/payment contracts, legacy regression, constraints, and batch rollback.
- `node --check account\websites\websites.js`: passed.
- `node --check tests\integration.mjs`: passed.
- Inline JavaScript checks on template HTML files: **2 inline scripts checked, passed**.
- `git diff --check`: passed on the clean baseline; repeated after report creation.

The unit tests emit expected safe-log events for synthetic storage/database failures; the test process exited successfully.

## 9. Final Git verification

- Branch and HEAD unchanged: `main`, `4f4aaa354893309dd8ed325882bfa461058aa9d3`.
- Initial worktree changes: none.
- Final staged changes: none.
- Final unstaged tracked changes: none.
- Final untracked change: `docs/qa/ORDERS-2.41-INDEPENDENT-UPLOAD-DELETE-CONCURRENCY-AUDIT.md` only.
- All pre-existing changes were preserved; there were none at baseline.
- No remote services or Production resources were accessed. No upload, payment, migration, deployment, commit, push, merge, or pull was performed.

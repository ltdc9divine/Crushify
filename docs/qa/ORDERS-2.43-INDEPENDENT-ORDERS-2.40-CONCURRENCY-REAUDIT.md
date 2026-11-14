# ORDERS-2.43 — Independent ORDERS-2.40 Upload/Delete Concurrency Re-Audit

## Verdict: FAIL

The exact ORDERS-2.40 commit closes the original database race between upload-grant creation and design deletion, and it conditionally prevents stale upload completion from changing database state after a design is archived. The local unit suite and typecheck pass.

It does **not** establish complete concurrency safety. Two additional database-level interleavings can leave a design referring to a deleted asset or leave a paid order unable to fulfill. In addition, the database lease does not fence an already-running R2 or Cloudinary operation. These are implementation gaps, not just missing remote verification.

## Audited checkout and safety boundary

- Repository root: `C:\Users\ltdc9\OneDrive\Desktop\======WORK======\crushify`
- Branch: `orders-2.40-upload-delete-race-remediation`
- HEAD: `2314879f492052e0fb24148358eef151595c03d3`
- Upstream: `origin/orders-2.40-upload-delete-race-remediation`
- Ahead/behind upstream: `0 / 0`
- Initial audit status: no staged or modified tracked files; the three pre-existing untracked reports ORDERS-2.41, ORDERS-2.41B, and ORDERS-2.42 were present.
- The audited source was the checked-out tree at the stated commit; no branch, ref, or Git history was changed.
- No remote service was contacted. No database outside local in-memory/file tests, object storage, payment provider, Preview, Production, or deployment resource was accessed.
- Only this new report is permitted to be created by this task.

## Files and paths examined

The principal lifecycle and state predicates were inspected in:

- `migrations/0010_asset_upload_leases.sql` and earlier schema/migration definitions.
- `src/assets.ts`: `createUpload`, `uploadContent`, `completeUpload`, and `deleteAsset`.
- `src/designs.ts`: `validateAssetReferences`, `updateDesign`, and `deleteDesign`.
- `src/payments.ts`: `createOrder`.
- `src/publications.ts`: `validateOwnedAssets`, `insertPublication`, and `handleFulfillmentForOrder`.
- `src/storage.ts`, `src/storage/r2.ts`, and `src/storage/cloudinary.ts`.
- `src/database/d1.ts`, `src/database/turso.ts`, and `src/database/migrations.ts`.
- `shared/customer-editor.js`.
- `tests/publications.test.ts`, `tests/database.test.ts`, `tests/storage.test.ts`, and relevant portions of `tests/integration.mjs`.
- `docs/qa/ORDERS-2.39-INDEPENDENT-DELETION-SAFETY-AUDIT.md`, `docs/qa/ORDERS-2.40-UPLOAD-DELETE-RACE-REMEDIATION.md`, and the prior ORDERS-2.41/2.42 reports.

There is no `src/storage/provider.ts` in this tree; the storage contract is in `src/storage.ts`.

## What is implemented

### Upload and design deletion

`src/assets.ts:76-179` inserts the asset and upload session conditionally against an owned `DRAFT` design. The 15-minute lease is set at `src/assets.ts:8,241-253`; the claim changes only `PENDING` to `UPLOADING`. There is no upload lease renewal, per-attempt owner/generation token, or takeover of an expired `UPLOADING` session.

After calling external storage, `uploadContent` conditionally updates both asset and session state only while the design is `DRAFT` and the session lease is unexpired (`src/assets.ts:259-295`). It checks both batch row counts. On failure it tries to delete the object and either returns the database state to retryable `PENDING` or leaves cleanup pending (`src/assets.ts:296-376`). `completeUpload` requires a quarantined asset, a completed upload session, and a still-draft design before setting `READY` (`src/assets.ts:384-469`).

`deleteDesign` refuses to begin while an unexpired lease exists, cancels pending or expired upload sessions, cleans assets, and only archives once no undeleted assets remain (`src/designs.ts:209-423`). The upload/deletion claim and completion checks are database conditions rather than process-local locks.

These controls prevent the ORDERS-2.39 late grant/finalization database race in the tested orderings. They do not cancel, version, or otherwise fence an external object-store operation.

### Database adapters and migrations

`src/database/d1.ts:39-58` passes statements to `D1Database.batch`; `src/database/turso.ts:66-85` calls libSQL `client.batch(..., "write")`. Both expose per-statement results. The intended state transitions rely on each adapter's batch transaction semantics. Local libSQL tests exercise rollback and transaction behavior; this turn did not run the local Wrangler/D1 integration script, so D1 runtime parity was not independently verified here.

Migration 0010 adds constrained session status, nullable lease expiry, an index, and a backfill to `COMPLETE` for used sessions whose assets are `QUARANTINED` or `READY` (`migrations/0010_asset_upload_leases.sql:1-18`). It does not repair a legacy session with `used_at IS NOT NULL` and a still-`PENDING` asset. That row remains `PENDING` but cannot be claimed because new upload claims require `used_at IS NULL` (`src/assets.ts:243-253`). The migration test covers a pending session with `used_at IS NULL`, not this interrupted legacy state (`tests/database.test.ts`).

### Storage-provider boundary

The `Storage` interface only provides key-based `upload`, `get`, and `delete` (`src/storage.ts:15-23`). R2 performs unconditional `bucket.put`/`bucket.delete` (`src/storage/r2.ts:11-42`). Cloudinary private upload sets `overwrite: "false"` and deletion targets the public ID (`src/storage/cloudinary.ts:43-89,119-146`), but neither adapter accepts a fencing generation, conditional delete, cancellation signal, or attempt identity. Network exceptions become ordinary storage errors; the caller cannot distinguish “definitely not accepted” from “accepted but response lost.”

Each grant creates a random object key unique to its asset (`src/assets.ts:119-123`; schema uniqueness in `migrations/0001_initial_schema.sql`). A distinct replacement asset therefore has a distinct key, but retries of the same asset reuse the key. A lease is a database claim only; it cannot stop an already-issued put or prevent a late put from recreating an object after cleanup.

## Confirmed database-level defects

### 1. READY asset deletion races a design save adding a reference

`validateAssetReferences` in `src/designs.ts:73-86` checks that all referenced assets are `READY`, but `updateDesign` runs that query before its write batch (`src/designs.ts:119-207`). The batch conditionally updates the design revision/status but does not recheck that its referenced assets are still `READY`.

`deleteAsset` first reads `design.data_json` and rejects a reference found in that snapshot (`src/assets.ts:471-520`). It later claims deletion in a separate batch (`src/assets.ts:531-558`). The claim rechecks current asset status, upload lease, and publication consent, but **does not recheck whether the design currently references the asset**.

An allowed ordering is:

1. The design has no reference to READY asset X. `deleteAsset` reads that design snapshot and passes its reference check.
2. `updateDesign` validates a new reference to X while X is still READY.
3. `updateDesign` saves the new data/revision, or pauses before that save.
4. `deleteAsset` claims X as `DELETION_PENDING`; its SQL does not check the current design data.
5. Storage deletion completes and the asset becomes `DELETED`.
6. The saved design now references the deleted asset.

This is not prevented by transaction semantics: the reference validation and the later write/claim are separate operations, and neither conflicting write rechecks the invariant in its own conditional database operation. The final state is a design that points to an unavailable image.

The order/publication path makes the impact material. `createOrder` accepts a draft at its current revision and does not include an asset-readiness check in its conditional order insert (`src/payments.ts:280-437,638-730`). `insertPublication` validates referenced assets and returns `ASSET_UNAVAILABLE` when one is no longer READY (`src/publications.ts:227-238,242-274`). Automatic fulfillment calls this path and records a failed/retryable job, eventually subject to its retry/manual-review limit (`src/publications.ts:1337-1450,1544-1559`). A customer can therefore pay for a design that cannot be published because the deletion race removed a newly referenced image.

No existing test creates this interleaving. The current deletion tests check a reference sequentially; the upload/deletion barrier tests do not pause between `validateAssetReferences` and the design write or between `deleteAsset`'s reference read and deletion claim.

### 2. Draft edits/uploads are not locked by checkout or fulfillment

`createOrder` inserts an order with `design_revision` but does not transition or lock the design (`src/payments.ts:638-730`). `updateDesign` accepts a `DRAFT` design and saves the next revision without checking for a pending/paid order (`src/designs.ts:119-207`). Upload grant/finalization also continue to accept a `DRAFT` design (`src/assets.ts:76-179,181-295`).

If a customer saves an upload-driven design change after checkout, the order retains the earlier revision. Publication creation requires the order revision and current design revision to match (`src/publications.ts:303-326`). Fulfillment then cannot publish the older order revision against the changed design; it fails/retries and can reach manual review while the payment remains recorded. The system may have intended `CHECKOUT_LOCKED` (present in the schema status constraint), but no such transition is used by these source paths.

The suite tests that **deletion** is blocked while an order or fulfillment is active (`tests/publications.test.ts:1308-1341`); it does not test or block design edits/uploads in that state. No deterministic test covers this order-revision race.

## Required concurrency scenario matrix

“DB” describes conditional database state changes; “storage” describes provider-side effects, not provider guarantees. “NOT COVERED” means no test proves the named interleaving; it does not mean safe.

| # | Scenario | Database state / stale worker | External storage, retry, and customer impact | Deterministic evidence and result |
|---|---|---|---|---|
| 1 | Upload starts, then design deletion begins before completion | An unexpired `UPLOADING` lease blocks design deletion; if deletion wins after expiry, finalization checks require `DRAFT` and a live lease. | Active uploads are not cancelled by DB state. A late put may outlive deletion; cleanup is compensating only. | Barrier tests cover upload initiation vs deletion and active upload vs deletion; paused completion test covers deletion winning before final DB completion (`tests/publications.test.ts:1446-1609`). **PARTIAL** |
| 2 | Storage write reaches provider; lease expires before DB completion | Expired lease prevents successful finalization; there is no lease renewal or takeover. | The provider write remains in flight. If cleanup precedes late provider completion, the object may be recreated. | No test holds a provider write across lease expiry and releases it after cleanup. **NOT COVERED** |
| 3 | Worker B takes over an expired lease while A remains active | No such takeover is implemented: claims require session `PENDING`, while A's session remains `UPLOADING`. There is no fencing token. | Existing A's external request continues; no safe same-session recovery protocol exists. A fresh grant uses another asset/key rather than taking ownership. | Expiry test manually changes DB state and deletes; it does not run two workers. **NOT COVERED (takeover path absent)** |
| 4 | A completes after B takes over | B cannot claim the same session through the current API. No exact worker/attempt token exists to fence A if a future recovery path is added. | A stale external operation is not fenced by the session state. | No two-worker takeover test. **NOT COVERED** |
| 5 | Storage succeeds but database finalization fails | Conditional asset/session finalization checks row counts; failed batch is treated as failure rather than READY success. | Handler tries object deletion. If delete fails, asset/session cleanup remains pending and can be retried. | Test forces metadata persistence failure after mock storage succeeds, forces first cleanup failure, and verifies retry (`tests/publications.test.ts` concurrency suite, “retries cleanup…”). It does not simulate uncertain provider acceptance. **PARTIAL** |
| 6 | Storage times out after provider may have accepted the write | Handler treats the thrown error as failure; there is no persistent “outcome unknown” state. | Cleanup may race a provider-side operation that continues after timeout; a late object can remain or be recreated. | Storage tests mock ordinary errors; no accept-then-timeout/delayed-completion test. **FAIL** |
| 7 | Deletion begins while upload is executing against storage | While lease is unexpired, deletion returns a conflict. After expiry, deletion can cancel the session and proceed. | In-flight external work is not cancelled when expiry permits deletion. | Test pauses before mock storage writes while lease is active and verifies deletion is blocked; it does not expire the lease during the blocked call. **PARTIAL** |
| 8 | Deletion completes while delayed upload worker is active | Stale worker cannot mark the archived design's asset READY; DB checks reject later completion. | A timed-out/delayed storage request can recreate the deleted key after deletion completed. A worker that resumes normally attempts compensating deletion, but a lost process or uncertain provider outcome defeats that guarantee. | Expiry test sends a new upload only after archive and verifies it is rejected; it then manually recreates an object and verifies a repeated design-delete cleans it. No provider operation is actually held in flight across cleanup. **FAIL** |
| 9 | Two deletion requests race | Conditional claims and archived-state retries converge on the terminal DB state. | Delete-by-key is repeated; no storage-operation barrier verifies overlapping calls against provider semantics. | `Promise.all` design-delete test checks final DB/storage state but the fake storage delete is immediate (`tests/publications.test.ts:1773-1800`). **PARTIAL** |
| 10 | Upload/edit races checkout, renewal, or fulfillment | A successful publish changes the design out of `DRAFT`, so later upload completion is rejected. But checkout leaves the design editable, and design update is not fenced against an outstanding order. | New or stale uploads can leave orphaned objects; an edit after order creation can make the paid order's stored revision unfulfillable. | No deterministic upload/edit-vs-fulfillment test. Order revision is enforced at publication insert, after the design can be changed. **FAIL** |
| 11 | Cleanup races a replacement upload or a new reference to the same asset | Different grants use unique asset IDs/keys, limiting old-key cleanup from deleting a distinct replacement. However, the READY-asset/new-design-reference race described above lets deletion win without a current-reference check. Same-asset retry reuses its key. | Old provider work can still affect the same key on retry; no generation-safe cleanup exists. | No test for cleanup vs same-key retry or design-reference creation. The design-reference interleaving is a confirmed code-level race. **FAIL** |
| 12 | Retry after uncertain storage outcome | Database can leave cleanup pending and permit later deletion retry, but does not identify whether the old provider operation is still active. | Same-key retry and late old write can overlap. No provider reconciliation/orphan scanner was verified. | Existing cleanup retry is for a deterministic mock delete failure, not an unknown write outcome. **FAIL** |
| 13 | Stale worker updates session after losing ownership/lease | `COMPLETE`/asset updates require `UPLOADING`, `lease_expires_at > now`, and expected asset/design state; cancellation/archive blocks stale DB finalization. There is no exact attempt token, and expired sessions are not takeover-capable. | External side effects are unaffected by rejected DB updates. | Tests cover deletion-winning completion, not a held storage write that loses its lease. **PARTIAL** |
| 14 | Archived design receives delayed upload completion | Claim/finalization/completion require the design remain `DRAFT`; the archived design cannot be restored by those DB writes. | An already-issued object write can still leave an orphan after DB rejection. | Paused-completion test verifies DB rejection after deletion; no late provider completion after cleanup. **PARTIAL** |

## Customer and asset integrity

- **Archived design upload:** new upload grants and DB finalization require a draft; stale DB completion cannot restore an archived asset.
- **READY state:** normal upload finalization requires a completed session, and customer completion verifies the quarantined object before changing it to READY.
- **Shared publication assets:** `deleteAsset` checks active publication consent, and design deletion has shared-publication guards. These checks do not repair the unguarded race with a concurrently added draft-design reference.
- **Failed cleanup:** deletion failures return `DELETION_PENDING`; retry routes repeat object cleanup. A cleanup retry after a stale provider write has already been accepted is not a durable fence against another later write.
- **Payment/entitlement ledger:** upload/deletion cleanup does not directly mutate payment or entitlement rows; existing tests verify deletion blocking/preservation paths. The newly identified order-revision/reference races can nevertheless leave a paid order without a successful publication.
- **Customer UI:** `shared/customer-editor.js:61-90` returns an asset ID only after upload and completion succeed; `:185-239` reports save failures rather than success. On failure, the granted asset ID is not retained by the UI helper, so retry can create another grant and leave the first asset consuming capacity or awaiting cleanup.
- **Retry duplication:** new grants create new asset IDs/object keys; the editor does not expose a failed grant ID for direct cleanup. Same-session retries are not a takeover mechanism.

## Test quality and verification

The `tests/publications.test.ts:1445-1800` concurrency suite uses deferred gates and is meaningful for selected local database interleavings:

- Grant creation paused while deletion archives.
- An upload paused before the fake storage write while the lease is active.
- Completion paused after storage read while deletion wins.
- Expired-session deletion and later cleanup retry.
- Cleanup retry after a deterministic storage-delete failure.
- Two design-delete requests started with `Promise.all`.

The race storage fake performs in-memory operations. It does not model a remote write accepted before timeout and completed after a successful delete. No test deterministically covers: lease expiry during an active provider write; an old worker resuming after a newer lease; same-key stale cleanup vs retry; concurrent design-reference addition vs asset deletion; design edit/upload vs paid fulfillment; or a storage timeout after provider acceptance.

Commands run on the checked-out commit:

| Command | Result |
|---|---|
| `npm test` | **PASS** — 156 tests, 0 failures. Includes the existing upload/design-deletion barrier tests and local libSQL tests. |
| `npm run typecheck` | **PASS** |
| `npm run test:integration` | **NOT RUN this turn.** The exact-commit ORDERS-2.42 report records a prior local integration attempt that remained hung beyond 180 seconds and was stopped. This re-audit does not claim D1 integration success. |
| `git diff --check` | To be run after creating this report; result will be recorded in final verification below. |

The source/test evidence above is local only. It does not establish deployed D1/Turso or R2/Cloudinary behavior.

## Relation to ORDERS-2.41 and ORDERS-2.42

- The original ORDERS-2.41 FAIL verdict was against outdated `main` and is **not a valid verdict for this commit**. ORDERS-2.40 added database-backed upload-session state, lease checks, conditional grant/finalization, and deletion guards; the original grant-vs-delete race is covered locally.
- ORDERS-2.42's PARTIAL finding about external storage not being fenced by a database lease remains **valid** for this exact commit.
- This re-audit finds additional defects not established in ORDERS-2.42: deletion can race a design save that adds an asset reference, and an editable draft can change revision after checkout so fulfillment cannot publish the order's revision. Consequently, the broader database-safety conclusion from ORDERS-2.42 is insufficient for the complete lifecycle.

## Required remediation and remaining verification

Before treating upload/delete concurrency as fixed:

1. Make design-reference validation and asset deletion mutually exclusive at the database write boundary. The design-save write must verify all referenced assets are still READY as part of the same atomic conditional operation; the asset deletion claim must also reject a currently referenced asset, not rely on an earlier JSON snapshot. Add a deterministic barrier test for both write orderings.
2. Prevent draft revision changes while an order is pending/paid/fulfilling, or explicitly make fulfillment consume a durable immutable order snapshot that can still be fulfilled after later edits. Add a test that saves/uploads after order creation and drives the paid fulfillment path.
3. Define a storage-outcome recovery protocol that handles in-flight and unknown-outcome writes. Use per-attempt immutable keys or provider-supported conditional/versioned operations and durable reconciliation; a DB lease alone is not external fencing. Add delayed-write and accept-then-timeout tests.
4. Add migration recovery for legacy `used_at IS NOT NULL` upload sessions whose asset remains `PENDING`, or document and implement an explicit cleanup/regrant path.
5. Run the local Wrangler/D1 integration tests when the hang is resolved. Separately verify provider and deployed database behavior only in an explicitly isolated, authorized non-Production environment; none was accessed here.

## Final Git verification

- `git diff --check`: **PASS**.
- The new untracked report was separately checked for trailing whitespace: **PASS**.
- Branch/HEAD/upstream are unchanged: `orders-2.40-upload-delete-race-remediation` / `2314879f492052e0fb24148358eef151595c03d3` / `origin/orders-2.40-upload-delete-race-remediation`; `0` ahead, `0` behind.
- Staged paths: none.
- Modified tracked paths: none.
- Untracked paths: the three pre-existing ORDERS-2.41, ORDERS-2.41B, and ORDERS-2.42 reports, plus this new ORDERS-2.43 report.
- The three pre-existing reports were preserved and not modified; this report is the only file created by this task.
- No source, test, migration, configuration, or existing report was modified. No remote service, payment, deployment, commit, push, merge, or branch operation was performed.

# ORDERS-2.44 — Asset Reference, Checkout Revision & Storage Race Remediation

## Result

**Verdict: PARTIAL.** The local code and deterministic tests establish database-level protection for asset references and checkout snapshots, and fence stale upload workers from attaching assets. Provider requests already accepted by R2 or Cloudinary cannot be canceled by the database lease; delayed provider-side completion remains a reconciliation risk. No remote provider, database, or deployment verification was performed.

## Repository identity and preservation

- Repository root: `C:\Users\ltdc9\OneDrive\Desktop\======WORK======\crushify`
- Starting and ending branch: `orders-2.40-upload-delete-race-remediation`
- Starting and ending HEAD: `2314879f492052e0fb24148358eef151595c03d3`
- Upstream: `origin/orders-2.40-upload-delete-race-remediation`
- Final upstream divergence: `+0 -0`
- No branch changes, commits, pushes, or remote access occurred.

The four pre-existing untracked reports were preserved and not edited: ORDERS-2.41, ORDERS-2.41B, ORDERS-2.42, and ORDERS-2.43.

## Root causes and implemented invariants

### A. Asset reference creation versus deletion

Previously, checking an asset before writing a design reference left a race window: deletion could claim the asset after validation but before the reference was persisted. Migration `0011_asset_reference_and_upload_attempts.sql` adds normalized `design_asset_refs` and `order_asset_refs`, plus database triggers that reject references to ineligible assets and protect assets with active references. Design saves in `src/designs.ts` validate referenced assets and batch the design/revision/reference changes together. Asset deletion in `src/assets.ts` conditionally claims only assets without protected references before storage cleanup. Existing references are not silently discarded; lifecycle cleanup explicitly removes design-reference rows as part of the corresponding design-erasure path.

`src/database.ts` retains the adapter-specific batch calls: D1 uses native `D1Database.batch`, while Turso uses its write batch. Local database-contract tests exercise the supported adapter contract and rollback behavior; the production Turso service itself was not contacted.

### B. Checkout revision versus later edits and fulfillment

An order recording only a design ID/revision cannot reproduce the authorized content after the draft changes. Checkout in `src/payments.ts` now persists an immutable `order_design_snapshots` record containing the design content, template/schema information, revision, and content hash, and pins referenced assets. The snapshot write and order creation are batched after revalidating the draft and assets. `src/designs.ts` blocks edits when a paid order exists while leaving unpaid drafts editable. Fulfillment in `src/publications.ts` publishes from the order snapshot and verifies its hash when available; retries reuse the existing publication. Migration backfills legacy orders with snapshots but cannot calculate their SHA-256 in SQL, so legacy empty hashes are accepted without hash verification.

### C. External storage and stale upload workers

`src/assets.ts` records per-attempt ownership tokens and unique storage object keys. Lease ownership and attempt identity are checked on state transitions and asset attachment, so a stale worker cannot attach its result after takeover or attach to a design that is no longer eligible. Cleanup is recorded durably in `asset_upload_attempts`; `reconcileUploadAttemptCleanup` retries and checks for references before deleting, and is invoked by scheduled maintenance in `src/scheduler.ts` / `src/index.ts`.

These are database-side controls. Neither an R2 nor a Cloudinary request already accepted by the provider is canceled or fenced by a database token. A timeout is an uncertain outcome, not proof that the provider rejected the operation. Unique attempt keys and delayed, recurring reconciliation reduce orphan and replacement-deletion risks, but an arbitrarily delayed provider request may still recreate an object after cleanup. Provider-level cancellation, fencing, and timing guarantees were not established here.

## Concurrency scenario matrix

| Scenario | Result | Evidence / boundary |
|---|---|---|
| Design save races asset deletion; reference write wins | **PASS** | Transactional batch and reference trigger serialize eligibility/reference changes; deterministic barrier test verifies the asset remains ready and referenced. |
| Asset deletion claim wins before a new reference | **PASS** | Conditional deletion claim prevents a subsequent design-reference insert; tests cover both controlled interleavings. |
| Shared asset has another design/order/publication reference | **PASS** | Deletion preflight checks normalized references; prior shared-publication retention tests remain in the suite. |
| Checkout races a draft edit | **PASS** | Checkout revalidates the draft at its write boundary and stores the content snapshot in the batch; snapshot test checks revision, content hash, and asset pins. |
| Draft edited after checkout but before payment/fulfillment | **PASS** | Unpaid draft edits remain allowed; fulfillment test proves the checked-out snapshot is published rather than the newer draft. Paid-order edits are rejected. |
| Duplicate/retried fulfillment | **PASS** | Existing publication/idempotency path reuses the publication; deterministic recovery test verifies stable snapshot publication. |
| Upload lease expires; a new worker takes over; old worker completes late | **PASS (database)** | Attempt token/key conditions fence the old worker from state update and attachment; takeover and stale completion are covered with controlled storage promises. |
| Upload targets an archived/deletion-pending design | **PASS (database)** | Attachment requires a current eligible design and attempt ownership; delayed completion cannot register an asset after the eligibility transition. |
| Provider accepts upload but request times out | **PARTIAL** | Timeout is treated as uncertain and cleanup is persisted/retried; tests inject acceptance followed by timeout. The external request cannot be canceled or fenced, so eventual provider-side completion remains possible. |
| Cleanup overlaps a new upload/reference | **PASS (database), PARTIAL (provider)** | Per-attempt unique object keys plus reference recheck avoid deleting a new valid attempt; deterministic cleanup test covers a newly referenced asset. A provider request arriving after cleanup may recreate an orphan under its old unique key. |
| Two simultaneous deletion requests | **PASS (database)** | Conditional claim makes only one request own deletion; durable cleanup supports retries. No claim is made that an already-running provider delete is cancelable. |
| Upload authorization/session creation races design deletion | **PASS (database)** | Session/attachment writes and deletion state are conditionally checked; authorization and ownership checks remain in place. Deterministic API tests cover stale completion after deletion. |
| Storage upload succeeds but database attachment fails | **PARTIAL** | Attempt-specific key and durable cleanup allow later reconciliation, avoiding accidental deletion of a replacement key. Until reconciliation succeeds, an unreferenced provider object may remain. |
| Provider delete/upload times out with uncertain outcome | **PARTIAL** | Durable retry and post-operation/reference checks reduce inconsistency; provider-side delayed completion cannot be ruled out locally. |

`PASS` here describes the local implementation/test boundary, not a guarantee from a remote provider or Production.

## Deterministic regression evidence

Focused regression coverage was added primarily in `tests/publications.test.ts`:

- Controlled batch barriers cover both design-reference/deletion orderings.
- Checkout tests verify immutable content snapshots, revision/hash, and asset pins.
- A controlled edit/payment/fulfillment test proves the published revision comes from the order snapshot, with idempotent retry behavior.
- Deferred storage promises exercise expired-lease takeover, late stale-worker completion, provider acceptance followed by timeout, and cleanup overlapping a new reference.
- Existing design ownership, consent, and publication checks remain in place.

Migration/adapter compatibility is also exercised by `tests/database.test.ts` and `tests/database-contract.test.ts`; related publication and scheduled-maintenance tests remain in the full suite.

## Commands and results

- `npm run typecheck` — **PASS**.
- `npm test` — **PASS**, 162 tests passed, 0 failed.
- Focused migration, payment/publication, upload/delete, lease takeover, provider-timeout, cleanup, and checkout tests — **PASS**.
- Local Wrangler D1 migrations using an isolated temporary persistence directory — **PASS**, migrations 0001–0011 applied; `d1_migrations` contained 11 records, including `0011_asset_reference_and_upload_attempts.sql`.
- Local Wrangler query of the isolated D1 schema — **PASS**, confirmed the new reference, snapshot, and upload-attempt tables exist. The app-owned `schema_migrations` table is empty in this probe; Wrangler's migration ledger is `d1_migrations`.
- `npm run test:integration` — **INCONCLUSIVE**; the local integration command did not complete within 180 seconds and was stopped. No pass is claimed.
- `git diff --check` — **PASS**.
- The temporary local D1 probe directory was removed after verification.

No test contacted remote credentials/services. The integration timeout means local end-to-end HTTP integration is not verified by this run.

## Changed files

Added:

- `migrations/0011_asset_reference_and_upload_attempts.sql`
- `docs/qa/ORDERS-2.44-ASSET-REFERENCE-CHECKOUT-REVISION-STORAGE-RACE-REMEDIATION.md`

Modified:

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

No changes were made to previous QA reports.

## Remaining risks and next remediation scope

1. Re-run the local integration suite in an environment where its worker/server lifecycle completes, then exercise the relevant routes end-to-end against local D1.
2. Verify Turso transaction/batch behavior in an approved local or staging test environment; current evidence is limited to the adapter's local contract tests.
3. If stronger protection from delayed provider operations is required, define a provider-supported cancellation/versioning protocol or an operational reconciliation horizon and alerting policy. Do not treat database fencing as external request cancellation.
4. Validate migration rollout and provider behavior in a controlled non-production environment before considering release. This audit does not establish Production readiness.

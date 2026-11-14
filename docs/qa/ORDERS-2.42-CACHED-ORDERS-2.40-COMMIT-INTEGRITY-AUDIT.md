# ORDERS-2.42 — Cached ORDERS-2.40 Commit Integrity Audit

## Verdict: PARTIAL — credible database race remediation; external storage operations remain unfenced

The exact commit `2314879f492052e0fb24148358eef151595c03d3` contains a substantive remediation for the upload-grant/design-deletion database race. Conditional SQL ties grant creation, upload claims, finalization, and archival to the current design and asset states. Deterministic local tests cover important database interleavings.

It does **not** provide end-to-end fencing for R2 or Cloudinary. The 15-minute upload lease has no attempt ID, owner, generation, renewal, cancellation signal, or storage-provider condition. An external write/delete can outlive the database lease; a timeout is treated as an ordinary failure even though the provider's final outcome may be unknown. The implementation report itself acknowledges possible late objects. This commit is a reasonable **database-level remediation candidate**, but not evidence that all upload/delete races are prevented or that the system is safe for production storage operations.

**ORDERS-2.41 should be rerun against this exact commit.** The previous ORDERS-2.41 audit examined `main` at its earlier HEAD, not this implementation. The cached ref is not being declared authoritative for GitHub or Production.

## 1. Audited revision and Git scope

- Audited tree: commit `2314879f492052e0fb24148358eef151595c03d3`
- Local ref at audit start: `refs/remotes/origin/orders-2.40-upload-delete-race-remediation`
- Parent: `4f4aaa354893309dd8ed325882bfa461058aa9d3`
- The checkout remained on `main` at `4f4aaa354893309dd8ed325882bfa461058aa9d3`; the target tree was read with Git object commands and an isolated temporary archive, not checked out.
- After the user explicitly requested a pull, `git pull --ff-only` completed with “Already up to date.” The current branch, HEAD, and worktree remained unchanged. This was the only remote Git operation. No database, Cloudinary, R2, SePay, Production, or Preview resource was accessed. The cached ref is not asserted to be authoritative for GitHub or Production.
- At baseline, the worktree had no staged or modified tracked files. Two pre-existing untracked reports were preserved: the ORDERS-2.41 audit and ORDERS-2.41B provenance report.

Line references below are to the audited commit's tree.

## 2. Implementation findings

### Upload lifecycle, ownership, and authorization

- `src/assets.ts:76-178` (`createUpload`) requires a customer session and CSRF token, verifies design ownership/status, and uses conditional `INSERT ... SELECT` statements that recheck the owned `DRAFT` design and asset limit. The asset and session are inserted in a database batch; row counts are checked. This closes the earlier preflight-read/late-insert gap at the database boundary.
- `src/assets.ts:181-257` (`uploadContent`) resolves the upload capability by its hash and asset ID, joins the asset to its design, requires `PENDING` states and `DRAFT`, validates expiry and bytes, and conditionally changes the session from `PENDING` to `UPLOADING`.
- `src/assets.ts:259-295` uploads bytes and then conditionally advances the asset and session only while the design is still a draft and the lease timestamp is considered valid. Both batch row counts are checked.
- `src/assets.ts:384-469` (`completeUpload`) requires an authenticated owner, a `QUARANTINED` asset, `COMPLETE` session, and draft design; it validates bytes and conditionally marks the asset `READY`.
- Content upload uses the unguessable bearer capability; grant creation and completion use session/CSRF checks. Asset queries are customer-scoped.

### Lease semantics and recovery

- `src/assets.ts:8,241-253` sets a fixed 15-minute `lease_expires_at`. The claim only transitions `PENDING` to `UPLOADING`.
- No code renews an upload lease or reclaims an expired `UPLOADING` session for a second upload worker. Expired sessions are cancelled during asset/design deletion (`src/assets.ts:531-558`, `src/designs.ts:260-306`); there is no same-session takeover protocol.
- The lease has no attempt-specific fencing token or generation. Finalization checks session status and time but cannot distinguish two attempts by a unique owner token. A stale worker's database commit is usually blocked by changed asset/session/design state, not by an attempt fence.
- Error handling at `src/assets.ts:296-376` tries to delete the object. If deletion reports success, it resets the asset/session for retry while the design remains a draft; otherwise it marks cleanup pending/cancels the session and returns a cleanup-pending error. A worker crash bypasses this compensation. Provider success/failure responses do not prove that an independently timed-out operation has stopped.
- The time value used in conditional SQL is generated in application code immediately before the database call (`src/assets.ts:267`, `src/designs.ts:221,260`), rather than using a database clock at the conditional write. A queued write can therefore compare against a timestamp captured before the statement actually executes.

### Migration and compatibility

- `migrations/0010_asset_upload_leases.sql:1-18` adds a constrained session status, lease expiry, a lifecycle index, and backfills sessions as `COMPLETE` when `used_at` is set and their asset is `QUARANTINED` or `READY`.
- `src/database/migrations.ts:28-110` sorts and validates consecutive migration numbers, checks checksums, and applies each migration with its ledger entry in a write transaction. The target unit tests verify migrations 1–10, repeat application, checksum behavior, and preservation of existing rows.
- Compatibility gap: a legacy session with `used_at IS NOT NULL` and an asset still `PENDING` is not changed by migration 0010, so it remains `PENDING` but cannot pass the new claim predicate `used_at IS NULL` (`src/assets.ts:243-253`). The migration test at `tests/database.test.ts:160-194` covers a pending session with `used_at = NULL`, not this interrupted-upload state. The asset can be deleted through cleanup, but that session cannot be retried as an upload. This is a recoverability gap, not evidence that the main deletion race remains open.

### Database atomicity and adapter scope

- `src/database/d1.ts:39-58` forwards a batch to `D1Database.batch`; `src/database/turso.ts:66-85` calls `client.batch(..., "write")`. Conditional SQL and batch row counts are used for application-level state transitions.
- Local integration tests contain a D1 batch rollback assertion (`tests/integration.mjs:1235-1256`); migration/unit tests use local libSQL. The concurrency barriers use a `PausableDatabase` wrapping the Turso/libSQL adapter (`tests/publications.test.ts:31-48`), not deployed D1 or remote Turso.
- Batches make database statements atomic only within the database adapter. No transaction includes a storage operation; database atomicity cannot fence an already-issued external request.

### Storage provider boundary

- `src/storage.ts:15-23` exposes only key-based `upload`, `get`, and `delete`; there is no generation, conditional delete, cancellation, attempt ID, or idempotency key.
- Each asset gets a random private key (`src/assets.ts:119-123`), and `migrations/0001_initial_schema.sql:74` makes `object_key` unique. A distinct replacement asset therefore gets a different key; ordinary stale cleanup of the old asset does not target the replacement key. However, retries of the same asset reuse that asset's key; keys are not unique per upload attempt.
- `src/storage/r2.ts:11-42` uses unconditional `bucket.put` and `bucket.delete`.
- `src/storage/cloudinary.ts:43-89,119-146` sets `overwrite: "false"` for private uploads and performs deletion by public ID. Network rejections are translated to `StorageError`, without an “outcome unknown” state; a successful delete is not linked to an upload generation.
- Provider tests use mocks/in-memory storage. No provider behavior after an actual network timeout was verified.

### Customer upload and retry behavior

- `shared/customer-editor.js:61-90` requests a grant, uploads, completes, and returns the asset ID only after all steps succeed. On any failure, the helper throws before returning the ID; the save handler at `:185-239` reports an error and leaves Save available for retry.
- The UI does not retain the grant's asset ID in the failure path or expose a cleanup action for that partially completed upload. Retrying serialization may create another grant/asset, while the first asset remains cleanup-pending or pending. This can leave orphaned asset rows or consume the per-design photo limit until server-side/design cleanup runs.
- The server error text asks the customer to retry removing a photo when cleanup is pending, but the upload helper has not returned the asset ID to the caller. That instruction is not actionable for this failure path without another way to discover the asset.

## 3. Adversarial scenario results

| Scenario | Database fencing | External storage fencing / idempotency | Deterministic test evidence | Result |
|---|---|---|---|---|
| **A. A's lease expires; B takes a new lease; A completes late** | The described B takeover is not implemented: claims require `status='PENDING'`, while A's session is `UPLOADING`. If expiry or deletion has changed/cancelled state, A's finalization predicates reject it. There is no per-attempt token. | None. A's storage request is not cancelled by lease expiry. | `tests/publications.test.ts:1613-1669` manually expires a lease, deletes the design, then starts a stale upload request. It does not keep A's storage operation in flight, create B, or resume A after B. | **PARTIAL** — DB commit is guarded for tested state changes; takeover and stale external completion are untested and no takeover exists. |
| **B. A's storage upload is in flight; design archives; A resumes** | Deletion refuses an unexpired lease; once deletion wins, design/session/asset state predicates prevent a later upload finalization or `READY` transition (`src/designs.ts:258-306,353-415`; `src/assets.ts:268-295,445-459`). | No provider fence. A late put may occur after cleanup; cleanup is compensating and can itself have an unknown outcome. | `tests/publications.test.ts:1488-1551` pauses upload while the lease is active and verifies deletion is blocked. `:1558-1606` pauses completion after object read, not the external upload. No test expires the lease while a storage put remains blocked. | **PARTIAL** — database ordering is tested for active upload and paused completion, but not late storage writes after expiry/archive. |
| **C. Cleanup overlaps a replacement upload** | A new asset insertion is blocked once the design is `DELETION_PENDING`; for asset-level replacement while the draft remains open, it is a separate asset. | Distinct asset keys are unique and random, so old-key deletion does not ordinarily delete a replacement asset. Retries of the same asset reuse its key, and the storage interface has no generation fence. | No barrier test overlaps old cleanup with creation/upload of a replacement asset or a retry on the same key. | **PARTIAL** — distinct replacement-key isolation is a strength; same-key late provider operations are unproven. |
| **D. Two deletion requests execute simultaneously** | Conditional status/state predicates, terminal-state checks, and archived-design cleanup make repeated requests converge on deleted/archived state (`src/assets.ts:531-590`; `src/designs.ts:229-255,260-423`). There is no deletion-owner token. | Deletes are repeated by object key. Idempotency depends on provider delete behavior; it does not fence an upload. | `tests/publications.test.ts:1773-1798` starts two design deletes with `Promise.all` and checks final state, but has no storage-delete barrier to force overlap. | **PARTIAL/PASS for tested idempotent outcome** — repeated deletion converges locally; the exact external interleaving is not forced. |
| **E. Grant authorization/session creation races with design deletion** | Conditional insert predicates recheck owner and `DRAFT` during the batch; deletion changes design state and cancels pending sessions transactionally. Either order rejects the late grant or deletes/cancels the already-created grant. | No storage call occurs during grant creation. Later upload uses the session and design state checks. | `tests/publications.test.ts:1446-1485` pauses grant batch, completes deletion, then releases it and verifies 409/no asset. Local D1 integration at `tests/integration.mjs:1153-1227` covers active/expired lease deletion behavior, but not the same barrier interleaving. | **PASS for the tested local database ordering**; remote/deployed adapter behavior remains unverified. |
| **F. Storage request times out after provider may have accepted it** | Handler treats the thrown provider error as failure and transitions state/tries cleanup (`src/assets.ts:296-376`). | No “unknown outcome” reconciliation. A cleanup delete can race a late provider-side write; if the request was accepted but response lost, the app cannot prove ordering or final object state. | No test makes a provider accept a write and then time out, followed by a delayed write after successful cleanup. Cloudinary adapter tests are mocked. | **FAIL for complete external-race prevention** — no provider-level fence or unknown-outcome recovery. |
| **G. A loses its lease while external storage is still running** | Lease expiry permits deletion to proceed and cancels expired sessions. A later database finalization should fail if deletion has changed the state, subject to the application-timestamp timing caveat above. There is no renewal/heartbeat. | The provider request is not aborted or fenced. The handler attempts cleanup only when it resumes; process termination or an uncertain late provider result can leave an orphan. | No test combines a held storage write, lease expiry, deletion/cleanup, and release of the original write. | **FAIL for external-storage safety** — lease ownership does not control an already-running provider operation. |

`tests/publications.test.ts:64-99` confirms the race-storage fake can pause `beforeUpload` and `afterGet`, but its underlying map operations are immediate; the tests do not model an accepted remote write that completes after a timeout or after a delete response.

## 4. Verification evidence and limitations

### Run against the exact target commit in an isolated archive

The temporary archive was created outside the repository from the exact commit. Existing `node_modules` were linked into that archive; no dependency install was performed.

- `npm test`: **PASS — 156 passed, 0 failed**.
- `npm run typecheck`: **PASS**.
- `npm run test:integration`: **INCONCLUSIVE** — started with the local-only Wrangler/D1 script, produced no output and remained running beyond 180 seconds; it was stopped. Do not treat this run as a pass. The implementation report claims a prior local integration pass, but that result was not independently reproduced here.
- No remote DB or storage operation was intentionally performed. The integration script is configured for Wrangler `--local`, loopback, and synthetic test values; because the run hung, no successful integration result is claimed.

The passing unit tests demonstrate local libSQL behavior and mocked storage behavior. They do not prove remote D1/Turso transaction behavior, Cloudinary/R2 late-operation semantics, or any Production configuration.

## 5. Conclusion and recommendation

- **Technical strengths:** conditional upload authorization and session insertion; state-guarded upload and completion; archive predicates; retryable deletion states; unique per-asset keys; useful deterministic barriers for grant/deletion and completion/deletion orderings; all 156 target unit tests and typecheck pass.
- **Confirmed limitation:** no attempt-specific storage fencing, no lease renewal/takeover, and no handling that can determine the final result of a timed-out provider operation. Local database checks cannot solve that external side-effect race.
- **Candidate status:** safe to treat as the intended **database-level** ORDERS-2.40 remediation candidate, but not as a complete upload/delete race fix or a Production safety sign-off.
- **ORDERS-2.41 rerun:** **Yes.** Rerun the independent audit against `2314879f492052e0fb24148358eef151595c03d3`; the prior audit's findings about the old `main` tree do not evaluate this implementation. Include the missing expiry-with-in-flight-storage and timeout-after-provider-acceptance interleavings.
- **Next safe action:** perform that independent audit against this exact commit and report the late-storage limitation explicitly. Separately decide how to reconcile unknown provider outcomes (for example, provider operation identity/versioning or durable cleanup reconciliation) before claiming end-to-end race safety. Do not infer deployment, remote migration state, or provider guarantees from this local commit.

## 6. Final worktree verification

- Branch: `main`
- HEAD: `4f4aaa354893309dd8ed325882bfa461058aa9d3`
- Staged paths: none.
- Modified tracked paths: none.
- Pre-existing untracked reports preserved:
  - `docs/qa/ORDERS-2.41-INDEPENDENT-UPLOAD-DELETE-CONCURRENCY-AUDIT.md`
  - `docs/qa/ORDERS-2.41B-REPOSITORY-PROVENANCE-RECONCILIATION.md`
- New project file created by this task: `docs/qa/ORDERS-2.42-CACHED-ORDERS-2.40-COMMIT-INTEGRITY-AUDIT.md`
- No source, migration, test, or existing report was modified.
- `git diff --check`: passed after report creation.

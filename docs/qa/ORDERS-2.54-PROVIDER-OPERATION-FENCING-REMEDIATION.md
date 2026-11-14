# ORDERS-2.54 — Provider Operation Fencing & Stale Upload Side-Effect Remediation

## Verdict: PARTIAL

The application already has durable upload-operation intents, a unique object key per attempt, lease-token fencing for database attachment, and stale-attempt reconciliation. This change closes a recovery gap: after cleanup observed an object absent and marked its attempt `CLEANED`, a provider request still in flight could create the object later, but the next verification was delayed by seven days. The retry verification interval is now one hour, and deterministic local tests cover both worker completion orders, cleanup during a retry, and an unknown-timeout late success.

**External provider operations are still not atomically fenced or guaranteed cancellable.** An already accepted R2/Cloudinary request can complete after cleanup's absence check. Reconciliation reduces orphan lifetime but cannot prove the request has terminated, and the checked-in Vercel schedule runs daily. This is not a PASS or Production approval.

## 1. Baseline and preservation

| Item | Starting value |
|---|---|
| Repository root | `C:\Users\ltdc9\OneDrive\Desktop\crushify` |
| Branch | `main` |
| HEAD | `c27136f3c18ef6c20698514b1490d6173830bcf5` |
| Upstream | `origin/main` |
| Remote | `origin https://github.com/ltdc9divine/Crushify.git` |
| Staged changes | None |

Starting status:

```text
 M src/platform/vercel.ts
 M src/scheduler.ts
 M tests/publications.test.ts
 M tests/scheduler.test.ts
?? docs/qa/ORDERS-2.50-FULFILLMENT-CRON-MIGRATION-REGRESSION-LEGACY-CLEANUP-REMEDIATION.md
?? docs/qa/ORDERS-2.51-REPOSITORY-PROVENANCE-ORDERS-2.50-VERIFICATION.md
?? docs/qa/ORDERS-2.52-ORDERS-2.50-BASELINE-RECONCILIATION-INTEGRATION-PLAN.md
?? docs/qa/ORDERS-2.53-INDEPENDENT-ORDERS-2.50-DIFF-AND-REGRESSION-AUDIT.md
```

The four modified tracked files and four untracked reports above were present before this task. No staged changes were present. The tagged `templates/our-universe/index.html` was not modified. No branch, HEAD, upstream, or remote changed; no fetch, checkout, reset, clean, stash, commit, push, or deployment occurred.

ORDERS-2.53 identified provider-operation fencing as an open limitation: database lease tokens cannot cancel provider-side work already accepted, and late results may require reconciliation. Its report and the upload implementation, adapters, migrations 0010–0012, and upload concurrency tests were inspected before changes.

## 2. Root cause and threat model

### Existing upload lifecycle

1. The upload-grant route creates a pending asset and upload session with a hashed capability token.
2. A valid upload request claims the session with a fresh lease token, writes an `asset_upload_attempts` row, and generates a fresh random object key for that attempt before calling storage.
3. If an expired session lease is taken over, the new worker receives a different lease token and object key. The previous attempt becomes `CLEANUP_PENDING`, with cleanup delayed beyond the new lease.
4. After the provider call returns, the worker can attach only if the session still has its lease token, the lease has not expired, the attempt identity/key/status match, and the asset/design are still eligible.
5. Cleanup claims stale attempts using its own cleanup lease. It protects an object if the database says that exact attempt key is still the asset's current quarantined/ready object; it also checks references before rejecting an asset. Otherwise it deletes only that attempt's object and verifies absence with the adapter's `get`.
6. If an upload outcome is unknown, the attempt is queued for cleanup and a retry gets a fresh attempt key. If cleanup cannot finish, it retries with backoff and eventually moves to manual review.

Migration 0011 already persists attempt identity, unique `lease_token`, unique `object_key`, lease times, cleanup state, and cleanup leases. No new migration was needed.

### Fencing boundaries

| Boundary | What is enforced | What is not enforced |
|---|---|---|
| Database fencing | A stale token cannot commit the asset/session/attempt attachment after takeover. Cleanup claim tokens prevent two cleanup workers from owning one database cleanup lease simultaneously. | A database transaction cannot roll back a storage request that has already been accepted. |
| Application-level fencing | Each attempt has a distinct random object key and durable row before the storage upload. Stale cleanup targets that key, not the current retry key. Attachment rechecks current lease and attempt state. | An in-flight handler cannot be assumed stopped merely because its lease expired, a later request took over, or an HTTP response timed out. |
| Provider behavior visible in this checkout | R2 upload calls `bucket.put` with key and metadata; R2 reads use `bucket.get`. Cloudinary upload sends `overwrite: "false"` and its adapter reads through a signed download request. | The R2 adapter supplies no conditional-write precondition. Neither adapter exposes upload cancellation, a provider idempotency key, or provider-side attempt fencing. `overwrite: "false"` is a request parameter, not evidence here of a cancellation or idempotency guarantee. There is no provider-wide list/reconciliation API in the `Storage` interface. |
| Atomicity across DB/provider | Durable intent and a unique key make it possible to reconcile known attempts later. | The database and provider do not participate in a shared atomic transaction. A timeout does not establish whether an object was created, and an absence check does not establish that an in-flight request has terminated. |

The threat scenario is: worker A begins uploading; its lease expires; worker B claims the session with another token and object key; cleanup removes or checks A's key while A's provider operation is still pending; A then completes after that check. A cannot attach because its database token is stale and cannot overwrite B's key because the attempt keys differ. A can, however, leave an orphan at its own key.

## 3. Remediation

`src/assets.ts` previously scheduled a successfully cleaned attempt's next verification seven days later. The code now schedules it one hour later using `UPLOAD_ORPHAN_RECHECK_MS`. Thus, if an old provider request creates its object after the cleanup verification, the durable `CLEANED` attempt remains discoverable and eligible for a subsequent exact-key cleanup.

This is a reconciliation interval, not a provider-operation timeout or cancellation guarantee. The Vercel lifecycle Cron is configured once daily, so the actual next attempt depends on the next successful scheduler invocation; a one-hour database timestamp does not make the production scheduler run hourly. If cleanup reaches its configured failure limit, it still enters `MANUAL_REVIEW`, which requires operator action.

No schema, provider adapter, configuration, or credential changes were made. The existing per-attempt key and current-token attachment rules remain unchanged.

## 4. Deterministic regressions

Added a controllable two-worker regression in [tests/publications.test.ts](../../tests/publications.test.ts):

- Worker A begins and pauses inside the fake provider.
- Its lease is expired; worker B takes over with a second key and pauses in its provider call.
- A completes first. Its response is rejected as stale; it does not attach.
- Cleanup is made due for A while B remains in flight. It removes A's key only.
- B then completes and attaches; the asset points to B's key and only B's object remains.
- A repeated cleanup pass does not change the active object.

The existing companion regressions exercise the opposite completion order (B attaches before A returns), uncertain provider timeout followed by retry, and cleanup completing before an old upload's late provider success. The latter now checks for that late object after the one-hour recheck interval rather than after seven days. They also cover cleanup failure/retry and preservation of referenced/current objects.

The fake provider controls completion order and failure injection; all tests use local libSQL and in-memory storage, not real provider APIs.

## 5. Files changed by this task

| File | Change |
|---|---|
| [src/assets.ts](../../src/assets.ts) | Added a one-hour `CLEANED` attempt orphan recheck interval instead of a seven-day interval. |
| [tests/publications.test.ts](../../tests/publications.test.ts) | Added deterministic takeover/cleanup ordering test; changed the late-success regression to verify at one hour. This file already contained uncommitted ORDERS-2.50 changes at task start; those existing hunks were preserved. |
| [ORDERS-2.54 report](./ORDERS-2.54-PROVIDER-OPERATION-FENCING-REMEDIATION.md) | This report. |

No migration was added. Existing uncommitted changes in `src/platform/vercel.ts`, `src/scheduler.ts`, `tests/scheduler.test.ts`, and the four ORDERS-2.50–2.53 reports were not edited by this task.

## 6. Validation

| Exact command | Result |
|---|---|
| `node --experimental-strip-types --test --test-name-pattern="fences an expired upload worker\|cleans a stale worker result while a takeover upload is still in flight\|reconciles an uncertain provider timeout\|fences concurrent cleanup and retries late provider success" tests/publications.test.ts` | **PASS** — 4 tests, 0 failures. |
| `npm test` | **PASS** — 182 tests, 0 failures, 0 skipped. |
| `npm run typecheck` | **PASS** — `tsc --noEmit`, exit code 0. |
| `npm run test:integration` | **PASS** — isolated local Wrangler D1 harness printed `Local integration: passed (D1 API and payment contracts, legacy regression, constraints, and batch rollback).` It ran with `--local`, temporary persistence, local loopback services, and synthetic test payment values; no remote database, real payment, customer account, external provider, or Production resource was accessed. |
| `git diff --check` | **PASS**. |

The integration command exceeded the initial tool wait, but completed successfully on the follow-up read; it was not canceled or treated as a pass without output.

## 7. Remaining risks and verification limits

- Provider requests cannot be reliably canceled by this application after transmission. A request can still finish after a cleanup pass.
- The adapters do not provide attempt-aware provider metadata, conditional R2 writes, provider-wide object listing, or a guaranteed cancellation/idempotency contract. Reconciliation is limited to keys in durable database attempt rows.
- `Storage.get` is the available existence check; Cloudinary's implementation performs a signed download rather than a metadata-only `HEAD`. No remote API behavior was tested.
- The one-hour recheck timestamp is not an hourly job. The configured Vercel Cron runs daily, and any failed/missed run delays the next check. No real Cron invocation was attempted.
- After repeated cleanup failures, attempts enter `MANUAL_REVIEW`; unresolved external objects may require operator reconciliation.
- Local adapter and deterministic fake-provider tests cannot prove R2/Cloudinary consistency, timeout semantics, or provider behavior under a real network partition. No credentials were used.

Accordingly, database/application fencing and eventual orphan detection are improved and locally verified, but external side effects remain outside atomic control. Verdict remains **PARTIAL**; retain the explicit operational limitation and do not infer Production readiness.

## 8. Final safety verification

- Branch is still `main`; HEAD is still `c27136f3c18ef6c20698514b1490d6173830bcf5`; upstream remains `origin/main`.
- No staged changes were added.
- The original ORDERS-2.50 tracked changes and ORDERS-2.50–2.53 untracked reports remain present and untouched.
- This task's implementation/test changes are limited to the orphan recheck interval in `src/assets.ts` and the described additions/adjustment in `tests/publications.test.ts`; only this requested ORDERS-2.54 report was added.
- No migration, provider configuration, credential, or tagged HTML file was changed.
- No checkout, reset, clean, stash, commit, push, fetch, deployment, or Production operation occurred.

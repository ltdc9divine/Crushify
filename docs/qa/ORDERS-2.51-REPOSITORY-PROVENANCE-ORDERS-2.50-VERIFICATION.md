# ORDERS-2.51 — Repository Provenance and ORDERS-2.50 Verification

**Verdict: PARTIAL.** The ORDERS-2.50 remediation and its regression coverage are present in the current working tree, and the reported local integration PASS is consistent with the task execution record. However, the prior development checkout is unavailable, the intended development branch cannot be independently established, and the changes are not committed in the current branch history.

## Repository identity and starting state

- Repository root: `C:\Users\ltdc9\OneDrive\Desktop\crushify`
- Origin: `https://github.com/ltdc9divine/Crushify.git`
- Branch: `main`
- HEAD: `c27136f3c18ef6c20698514b1490d6173830bcf5`
- Upstream: `origin/main`
- Current branch and `origin/main` point to the same locally known commit. No fetch was performed, so this does not establish the latest remote state.

`git status --short` at the start of this audit:

```text
 M src/platform/vercel.ts
 M src/scheduler.ts
 M tests/publications.test.ts
 M tests/scheduler.test.ts
?? docs/qa/ORDERS-2.50-FULFILLMENT-CRON-MIGRATION-REGRESSION-LEGACY-CLEANUP-REMEDIATION.md
```

- Staged tracked changes: none (`git diff --cached` is empty).
- Unstaged tracked changes: the four source/test files listed above.
- Untracked files: the ORDERS-2.50 QA report listed above.

`git log --oneline --decorate -12`:

```text
c27136f (HEAD -> main, origin/main, origin/HEAD) Remediate order lifecycle and upload recovery
2314879 (origin/orders-2.40-upload-delete-race-remediation, orders-2.40-upload-delete-race-remediation) feat: harden upload and design deletion concurrency
4f4aaa3 Harden staging isolation and variable hosting durations
84acc4c feat: enforce preview environment isolation
a81d578 Complete staging QA and Cloudinary isolation
5205f73 Refactor Say Yes template and enhance photo management features
0ac84ba Integrate order pricing and improve template flows
a2c3343 Harden hosting and local security boundaries
245a40f fix(local): isolate staging and mock customer workflows
f867f01 fix(database): create local SQLite parent directory
a86c50b fix(staging): isolate local staging credentials
f0322b4 fix(staging): restore secure Vercel staging ops
```

Locally available branches and relevant refs:

```text
backup/cloudflare-pre-turso-20261104                      e7cf1dd
main                                                      c27136f [origin/main]
orders-2.40-upload-delete-race-remediation                2314879 [origin/orders-2.40-upload-delete-race-remediation]
remotes/origin/HEAD                                       -> origin/main
remotes/origin/main                                       c27136f
remotes/origin/orders-2.40-upload-delete-race-remediation 2314879
```

## Provenance

The previously identified checkout, `C:\Users\ltdc9\OneDrive\Desktop\======WORK======\crushify`, does not exist at that path. Its branch, HEAD, status, refs, and file hashes therefore could not be inspected or compared. It is not possible to determine whether that directory was the same physical checkout, another clone with matching history, or a divergent project copy.

The current checkout identifies itself as `ltdc9divine/Crushify`. Its `main` HEAD is `c27136f`, whose parent is `2314879`; that commit is also present on the local and locally cached `origin/orders-2.40-upload-delete-race-remediation` ref. This establishes the current checkout's local repository identity and ancestry, but does not prove the missing directory's identity or explain the path change.

The ORDERS-2.50 report records the same current path, `main`, HEAD, and upstream, and records a clean starting worktree. The current modified paths match that report's change list. This supports attributing the current worktree changes to ORDERS-2.50, but the prior directory's absence prevents independent comparison against the earlier development checkout.

**Branch placement:** the four ORDERS-2.50 source/test changes are unstaged, uncommitted changes. They are present in the current `main` working copy, but are **not part of the `main` HEAD commit or any other branch commit**. Since the intended development branch cannot be confirmed from the missing checkout, this audit cannot verify that ORDERS-2.50 is on that intended branch in committed history.

## Independent verification of ORDERS-2.50

### 1. Configured Vercel Cron reaches fulfillment recovery

The configured `vercel.json` schedule invokes `/api/cron/publication-lifecycle` daily. [`api/cron/publication-lifecycle.ts`](../../api/cron/publication-lifecycle.ts) re-exports the catch-all handler. The route in [`src/platform/vercel.ts`](../../src/platform/vercel.ts) requires GET and a valid bearer `CRON_SECRET`, rejects non-Production runtimes, validates the environment/database configuration, then invokes the scheduler.

[`src/scheduler.ts`](../../src/scheduler.ts) invokes the existing `recoverPendingFulfillments` only when `resolvePaymentEnvironmentPolicy(env).fulfillmentEnabled` permits it. The limit defaults to 10 and is constrained to 1–100. The existing recovery implementation in [`src/publications.ts`](../../src/publications.ts) retains its verified-payment/webhook predicates and lease, attempt-limit, and idempotent fulfillment behavior; this task did not modify that file or add a second fulfillment mechanism.

The route regression in [`tests/publications.test.ts`](../../tests/publications.test.ts) exercises the handler with synthetic Production configuration and an injected local database adapter. It asserts that missing and invalid credentials return 401 without connecting or changing the pending job, and that an authorized request completes the due synthetic job. It does not call a real Vercel deployment or remote database.

### 2. Authentication, environment policy, and operation isolation

The Production Cron route remains bearer-authenticated and Production-only. Fulfillment remains gated by the existing environment policy; scheduler coverage in [`tests/scheduler.test.ts`](../../tests/scheduler.test.ts) verifies fulfillment is skipped under the staging policy while publication lifecycle and upload cleanup continue.

The scheduler runs fulfillment recovery, publication lifecycle, and upload cleanup as individually caught operations, records safe status/error categories, and continues through the remaining operations after an operation failure. The route returns 503 when an acquired run reports an operation failure. A regression injects a fulfillment-claim trigger failure and asserts that publication expiration and upload cleanup still complete, then verifies a later retry can recover the job. The database lease continues to fence overlapping scheduled runs.

### 3. Migration 0012 trigger coverage

The test named “enforces migration 0012 asset retention through the database trigger” in [`tests/publications.test.ts`](../../tests/publications.test.ts) applies migrations through 0011, creates publication references, applies the real 0012 migration, and sends raw SQL asset status updates through the local libSQL client. It asserts the installed trigger rejects `DELETION_PENDING` and `DELETED` for protected references, permits deletion after the retention deadline has elapsed, and permits deletion of an unrelated asset.

[`tests/database.test.ts`](../../tests/database.test.ts) separately verifies a fresh database applies migrations 0001–0012, a database at 0011 upgrades with 0012, and repeated migration initialization is a no-op. The trigger itself is defined in [`migrations/0012_lifecycle_retention_and_upload_recovery.sql`](../../migrations/0012_lifecycle_retention_and_upload_recovery.sql). No migration file was changed for ORDERS-2.50.

### 4. Legacy cleanup regression

The legacy cleanup test in [`tests/publications.test.ts`](../../tests/publications.test.ts) applies migrations through 0010, seeds an archived design with historical asset IDs, applies 0011, and verifies the normalized references created by its backfill. It then models an already-removed storage object with a test double and asserts the database rejects the prohibited asset transition. After applying 0012, the test exercises the application cleanup path while another retained publication protects an asset; it then releases retention, injects a storage deletion failure, and retries cleanup. Assertions cover retryability, idempotency, and preservation of payment/order/publication snapshots and entitlement state.

This is a local database plus deterministic in-memory storage test. It does not contact R2, Cloudinary, or any other external service.

### 5. Existing retention and fulfillment protections

The 0012 trigger still protects design references, qualifying order references, and active or retained publication references. The 2.50 test directly exercises the trigger and the cleanup state machine. Existing payment revalidation and fulfillment lease/fencing code is in files not changed by ORDERS-2.50; the configured route test proves the scheduler calls the existing recovery path, but it does not establish remote-provider or Production behavior.

### 6. D1 integration result correspondence

The ORDERS-2.50 report records `npm run test:integration` passing from this repository path and at the same branch/HEAD, after the changes, and reports the isolated local D1 result as PASS. The prior task execution record and the current change list are consistent with that claim. The audit did not rerun this potentially expensive integration test, and no hash-stamped test artifact or retained Wrangler log was available to independently bind the result to exact file contents. Therefore this is corroboration of the reported local run, not a fresh independent integration verification. The earlier SQLite I/O/connection-reset cause remains inconclusive, as the ORDERS-2.50 report states.

No evidence here verifies remote Turso/D1, an actual scheduled Vercel invocation, Production storage, or Production fulfillment.

## Exact ORDERS-2.50 change scope

Current unstaged tracked diff:

- [`src/scheduler.ts`](../../src/scheduler.ts) — bounded recovery invocation, per-operation result isolation, failure persistence.
- [`src/platform/vercel.ts`](../../src/platform/vercel.ts) — return 503 for acquired runs with failed operations.
- [`tests/publications.test.ts`](../../tests/publications.test.ts) — Cron route, authorization, failure isolation, batch/idempotency, migration trigger, and legacy backfill/cleanup regression coverage.
- [`tests/scheduler.test.ts`](../../tests/scheduler.test.ts) — scheduler result-shape and environment-policy expectations.

Untracked from ORDERS-2.50:

- [`ORDERS-2.50-FULFILLMENT-CRON-MIGRATION-REGRESSION-LEGACY-CLEANUP-REMEDIATION.md`](./ORDERS-2.50-FULFILLMENT-CRON-MIGRATION-REGRESSION-LEGACY-CLEANUP-REMEDIATION.md)

No staged changes. `vercel.json`, the Cron route re-export, migration 0012, database adapters, payment implementation, and publication recovery implementation are not modified. The ORDERS-2.50 report's clean-baseline record is the available evidence that these worktree changes were not pre-existing in this checkout; no attribution is made about files in the missing prior directory.

## Verification commands and result

No tests were rerun during this strict read-only audit. The ORDERS-2.50 report records:

- Focused configured-Cron tests: **PASS**, 3 tests, 0 failures.
- Focused migration-trigger and legacy-cleanup tests: **PASS**, 2 tests, 0 failures.
- Database and scheduler tests: **PASS**, 11 tests, 0 failures.
- `npm test`: **PASS**, 181 tests, 0 failures.
- `npm run typecheck`: **PASS**.
- `npm run test:integration`: **PASS**, local disposable D1 integration.
- `git diff --check`: **PASS**.

Those are reported results, not tests independently rerun for ORDERS-2.51.

## Final safety check

At the end of the audit, before adding this report:

- Branch remained `main`; HEAD remained `c27136f3c18ef6c20698514b1490d6173830bcf5`.
- Staged files: none.
- Modified tracked files remained the four ORDERS-2.50 source/test files listed above.
- The ORDERS-2.50 report remained untracked and unchanged.

This audit made no source, test, migration, configuration, or Git-history changes. Only this requested ORDERS-2.51 report was added. No branch switch, fetch, pull, commit, push, deployment, Production access, real payment, or external-storage operation occurred.

# ORDERS-2.55 — Independent Cross-Task Regression & Lifecycle Audit

**Overall verdict: NOT READY.** The checked-in application-level upload and database fencing is materially stronger and its local regression suite passes. However, publication-derivative cleanup is not fenced against concurrent publication operations, derivative provider operations have no durable reconciliation path for an unknown result, the configured Vercel schedule is daily rather than hourly, and no deployment/remote-provider behavior was verified. The local integration run in this audit ended with a loopback `ECONNRESET`, so it is inconclusive.

This is a read-only audit apart from creating this report. Prior reports were treated as claims, not proof.

## 1. Repository baseline and provenance

| Item | Observed value |
|---|---|
| Repository root | `C:\Users\ltdc9\OneDrive\Desktop\crushify` |
| Git common directory | `.git` under the repository root |
| Branch / upstream | `main` / `origin/main` |
| HEAD | `c27136f3c18ef6c20698514b1490d6173830bcf5` (`Remediate order lifecycle and upload recovery`) |
| Recent parent | `2314879` (`feat: harden upload and design deletion concurrency`) |
| Ahead/behind | 0 / 0 against the locally cached `origin/main`; no fetch was performed |
| Remote | `origin` fetch and push URL: `https://github.com/ltdc9divine/Crushify.git` |

Before this audit's report was created, the complete status was:

- No staged changes.
- Five pre-existing modified tracked files: `src/assets.ts`, `src/platform/vercel.ts`, `src/scheduler.ts`, `tests/publications.test.ts`, and `tests/scheduler.test.ts`.
- Five pre-existing untracked reports: ORDERS-2.50 through ORDERS-2.54 under `docs/qa/`.
- The existing tracked diff was 785 insertions and 82 deletions across those five files.

The tracked changes were not created or altered by ORDERS-2.55. They are the uncommitted ORDERS-2.50 scheduler/Cron and regression changes plus the ORDERS-2.54 upload orphan-recheck adjustment and test coverage. The report files are worktree evidence, not commits. `main` points to the reported HEAD; no claim is made about any unavailable checkout or remote deployment.

## 2. ORDERS-2.50–2.54 claims checked against source

| Claim area | Verdict | Direct evidence and limits |
|---|---|---|
| ORDERS-2.50: authenticated Vercel Cron invokes fulfillment recovery, lifecycle cleanup, and upload reconciliation | **FIXED locally** | `api/cron/publication-lifecycle.ts` re-exports the catch-all handler; `src/platform/vercel.ts` enforces Bearer `CRON_SECRET`, Production runtime, provider/database configuration, and invokes `runScheduledPublicationLifecycle`. Route tests use synthetic records. No actual Vercel invocation is evidenced. |
| ORDERS-2.50: one maintenance failure does not suppress independent operations; response reports outcomes | **FIXED locally, with monitoring caveat** | `src/scheduler.ts` isolates each operation and returns per-operation status/results; the Vercel route returns 503 for thrown operation failures. Item-level retries are recorded in result counters but do not set the top-level `failed` flag or run status to FAILED. Operators must inspect counters rather than only HTTP/run status. |
| ORDERS-2.50: migration 0012 and legacy cleanup regressions | **FIXED in local migration tests; remote compatibility PARTIAL** | `0011_asset_reference_and_upload_attempts.sql` and `0012_lifecycle_retention_and_upload_recovery.sql` implement backfill, triggers, and upload reconciliation state. Focused migration tests pass; the D1 integration attempt in this audit did not finish. No remote D1/Turso migration was run. |
| ORDERS-2.50: immutable paid-order snapshots and fulfillment recovery | **PARTIAL** | Source predicates, leases, unique order-linked fulfillment/publication state, and recovery tests support the claim. Reverse payment/deletion orderings and real provider/production execution are not all established. |
| ORDERS-2.51 / 2.52: provenance and intended-baseline conclusions | **PARTIAL / not a code guarantee** | Current branch and local ancestry were rechecked. The earlier conclusion that the intended development checkout was unavailable remains a worktree observation, not proof about another machine. No integration was performed. |
| ORDERS-2.53: the ORDERS-2.50 changes do not prove every prior race or remote behavior | **FIXED as an audit conclusion** | The source and test gaps below remain after direct inspection. Passing local tests do not establish deployment behavior. |
| ORDERS-2.54: upload-attempt application/database fencing and eventual orphan cleanup | **PARTIAL** | Unique per-attempt upload keys, persisted attempt rows, lease-token conditional attachment, cleanup leases, verification, retry/backoff, and deterministic A/B race tests are present. They prevent stale database attachment and same-key overwrite between upload attempts. Providers are not atomically fenced/cancelled, and cleanup depends on later scheduled reconciliation. |
| ORDERS-2.54: provider-operation fencing for every media operation | **OPEN for publication derivatives** | `publication_assets` records a derivative key/status, but derivative creation has no per-operation identity/lease or equivalent reconciliation. The derivative cleanup and publish races in Findings F-01/F-02 are not covered by the upload-attempt fencing. |

### Actual change inventory reviewed

- `src/scheduler.ts`: adds independently captured fulfillment-recovery, publication-lifecycle, and upload-cleanup results; validates a 1–100 batch limit (default 10); persists a failed run when an operation throws.
- `src/platform/vercel.ts`: returns 503 for an acquired maintenance run with an operation-level exception, rather than always returning 200.
- `src/assets.ts`: changes upload orphan verification from seven days to one hour. This changes a due timestamp; it does not schedule an hourly invocation or cancel a provider request.
- `tests/scheduler.test.ts`: asserts operation result shape and scheduled lease behavior.
- `tests/publications.test.ts`: adds Cron/failure-isolation/bounded recovery and migration/legacy cleanup cases, plus upload race, delayed provider completion, orphan recheck, and retention-trigger cases.

No source or test change in this range adds equivalent durable attempt fencing for `createPublishedDerivative` / `deletePublishedDerivative`.

## 3. Cron, scheduler, and fulfillment call chain

1. `vercel.json` declares `/api/cron/publication-lifecycle` with `0 3 * * *` (daily at 03:00 UTC in the repository configuration).
2. `api/cron/publication-lifecycle.ts` re-exports `config` and `default` from `api/[...path].ts`; the catch-all handler dispatches the matching path to `createVercelApiHandler`.
3. The Cron route accepts GET only, requires a configured Bearer secret of at least 32 characters, and rejects non-Production Vercel runtime. Database and storage configuration are validated before maintenance.
4. `runScheduledPublicationLifecycle` obtains a persistent five-minute lease, then invokes bounded fulfillment recovery, publication lifecycle, and upload cleanup. Each operation is independently caught and represented in the response/run record.
5. Fulfillment recovery is called, not merely imported. Local tests show bounded recovery and route wiring with synthetic data. The scheduler has no same-invocation continuation token: a later run picks up further due work. At the configured daily cadence, the default limit is 10 items per subsystem per invocation.
6. `/api/[...path].ts` sets `maxDuration: 60`. This is a platform configuration, not evidence that the actual Vercel runtime completes all work within 60 seconds. The five-minute database lease is not renewed during execution.

Cloudflare's worker entrypoint also contains a `scheduled()` handler that awaits maintenance operations sequentially. The tracked Wrangler configurations inspected here do not define a Cron trigger, and the scheduler test asserts that Vercel is the only repository-configured automatic lifecycle scheduler. No claim is made that an external Cloudflare or Vercel project has the same current configuration or is delivering jobs.

**Boundary:** repository schedule and unit route behavior are verified locally; Preview/Production deployment configuration, actual schedule delivery, invocation duration, durable remote storage/database, and real fulfillment are not verified. The Vercel Preview maintenance path is separately authenticated but fails closed when durable storage is unavailable; the current Vercel staging storage factory returns no storage.

## 4. Cross-task race and lifecycle matrix

| Interleaving | Source/test evidence | Verdict |
|---|---|---|
| Upload vs. design/asset deletion or archive | Conditional asset/session state, database triggers, and deterministic paused upload/deletion tests. | **FIXED at app/DB layer** |
| Upload attempt A vs. retry B; late A result | Each attempt has a distinct persisted key/token; attachment is conditional on current lease; tests exercise both completion orders and cleanup while a takeover is active. | **FIXED at app/DB layer; provider cancellation not provided** |
| Upload vs. cleanup; timeout-unknown upload | Attempt cleanup uses a cleanup lease, checks current asset ownership, deletes only the attempt key, verifies storage absence, and rechecks `CLEANED` rows. Fake-provider tests cover late success, failure/retry, and preservation of a referenced/current asset. | **PARTIAL** — eventual cleanup is schedule-dependent and may move to `MANUAL_REVIEW` after retry exhaustion |
| Design save/reference insertion vs. asset deletion | `design_asset_refs` plus migration triggers and database-batch race tests prevent a reference/deletion winner from silently invalidating the other. | **FIXED locally** |
| Paid order/snapshot vs. deletion | Immutable snapshots and order asset references preserve paid content; tests cover settlement/deletion and fulfillment/deletion interleavings. | **PARTIAL** — not every reverse transaction ordering is covered; no remote database behavior verified |
| Duplicate Cron / concurrent scheduled run | Persistent unique task lease test; item-level claims and conditional state updates support idempotent retries. | **PARTIAL** — actual platform overlap, lease expiry during execution, and production DB behavior untested |
| Fulfillment vs. publication expiry / renewal vs. retention cleanup | Recovery predicates, lifecycle exclusions for active orders/jobs, conditional renewal revision updates, and retention tests are present. | **PARTIAL** — local serialized DB tests do not prove all remote transaction interleavings |
| Publication derivative creation vs. unpublish/revoke/cleanup | `publish()` stages `PENDING`, calls the provider, then marks `READY`; `cleanupAssets()` selects only `READY` and `CLEANUP_PENDING`. No derivative attempt lease/token fences these operations. | **OPEN — F-01/F-02** |
| Publication cleanup vs. republish | Cleanup does not first claim the derivative row or fence on publication lifecycle revision. `publish()` can see `READY` and skip creation while cleanup is deleting the same key; cleanup later clears the key without checking whether the publication became active again. | **OPEN — F-01** |
| Publication provider timeout-unknown vs. orphan reconciliation | Cloudinary and R2 adapters expose no cancel/conditional-create contract. A derivative create failure leaves the row `PENDING`; cleanup ignores it. No derivative orphan scanner or metadata/list reconciliation exists. | **OPEN — F-02** |
| Cleanup retry vs. retention/source references | Lifecycle checks shared active/retained publication references and active orders/jobs; trigger tests and retry tests protect source assets. | **PARTIAL** — source references are stronger than provider-side derivative lifecycle fencing |

### F-01 — MEDIUM: derivative deletion is not fenced against republish

`cleanupAssets()` reads `READY`/`CLEANUP_PENDING` rows and deletes the provider object before updating the row to `DELETED`/null key. It does not first claim the row, acquire a per-derivative cleanup lease, or condition its final update on the publication still being unpublished/expired/revoked at the same lifecycle revision. `unpublishOrRevoke()` updates publication state and then calls this cleanup. Meanwhile, a publish request using the new lifecycle revision can observe the still-`READY` row, skip derivative creation, and mark the publication `PUBLISHED`. The cleanup can then delete and clear the derivative. The public-asset query requires `derivative_status='READY'`, so a successful republish can result in a missing image.

The code makes this ordering possible; the existing fake storage has a `beforeDerivative` gate, but no test uses it to pause derivative deletion and interleave a republish. This is a source-level race finding, not a claimed production incident.

### F-02 — MEDIUM: pending/unknown derivative operations are not reconciled

`publish()` persists a derivative key with status `PENDING` before calling `createPublishedDerivative`. If the call fails or times out after the provider accepted it, the handler returns 503 and leaves the row `PENDING`. `cleanupAssets()` never selects `PENDING`, including on a later unpublish/revoke cleanup. For consent revocation, the cleanup path can delete and null the recorded key while an uncertain provider request is still in flight; a late provider success can then recreate an object with no retained database key to reconcile. The upload-attempt cleanup logic does not cover derivative keys.

Cloudinary derivative uploads use `type: "upload"` and `overwrite: "true"`; R2 uses `bucket.put`. Neither adapter exposes a durable provider operation identity, conditional create, or guaranteed cancellation. The application public-asset route checks publication and consent state, so this audit does not claim that a revoked derivative is served through that route. A Cloudinary derivative is nevertheless provider-side public media if its URL/key becomes known, and untracked objects can outlive intended cleanup. No remote provider call or exposure was tested.

## 5. Migration and database compatibility

- The migration set is 0001–0012. Migrations 0010, 0011, and 0012 are ordered; the migration runner enforces consecutive versions/checksums. Test setup enables foreign keys.
- 0010 adds upload-session lifecycle status/expiry; 0011 adds durable references, immutable order snapshots, attempt records, legacy backfills, and reference triggers; 0012 adds reconciliation state, pending-upload backfill, retention-aware deletion protection, and stronger ready-source/reference triggers.
- Local migration tests cover the existing schema, repeat application, 0011-to-0012 upgrade, pending/finalized upload backfills, fulfillment schema preservation, checksums, and refusal to mutate a schema without a migration ledger. The focused run passed all six database tests.
- No down/rollback migration is present. Any real migration requires a tested backup/restore and deployment-specific forward-recovery plan; none was executed here.
- SQLite/libSQL tests are not proof of remote Turso or D1 behavior under their production configuration or concurrent workloads. The integration harness attempted local Wrangler/D1 execution but did not complete in this audit. No remote migration or database was touched.

## 6. Test evidence

All commands below were run in this checkout. Unit and migration tests use synthetic/in-memory/local fixtures. The integration harness was inspected: it starts Wrangler with `--local`, loopback `127.0.0.1`, temporary D1/R2 persistence, synthetic payment settings, and a loopback email sink. No production credentials or services were used.

| Command | Actual result |
|---|---|
| `node --experimental-strip-types --test tests/publications.test.ts tests/scheduler.test.ts tests/database.test.ts` | **PASS** — 56 tests, 0 failures |
| `npm test` | **PASS** — 182 tests, 0 failures |
| `npm run typecheck` | **PASS** — `tsc --noEmit`, exit code 0 |
| `npm run test:integration` | **INCONCLUSIVE / failed run** — Wrangler became ready on loopback and executed many contracts, then `fetch` failed with `ECONNRESET` in `tests/integration.mjs` at the design-delete request (line 1008 in this checkout). The command exited 1 before suite completion. This is not a PASS and no root cause was established. |
| `git diff --check` | Run after report creation as final worktree verification; result recorded below. |

Tests establish local code behavior only. The integration failure does not by itself establish an application defect or an environment-only cause.

## 7. Finding severity and remaining gaps

| ID | Severity | Finding | Status |
|---|---|---|---|
| F-01 | MEDIUM | Publication derivative cleanup can race with a republish and clear a derivative after publish succeeds. | **OPEN** |
| F-02 | MEDIUM | Derivative `PENDING`/timeout-unknown provider outcomes have no durable cleanup/reconciliation lifecycle. | **OPEN** |
| F-03 | MEDIUM | The one-hour upload orphan recheck is only a due timestamp; Vercel Cron is configured daily, and exhausted cleanup enters manual review. | **PARTIAL** — retry logic exists; no hourly execution or operational alert proof |
| F-04 | MEDIUM | Local integration/D1 contract suite did not complete in this audit. | **INCONCLUSIVE** |
| F-05 | MEDIUM | Remote D1/Turso migrations, Vercel schedule delivery, Preview isolation, durable storage, and real provider semantics are unverified. | **INCONCLUSIVE** |
| F-06 | LOW | Top-level scheduler success can coexist with item-level `retryable`/`manualReview` counts. | **PARTIAL** — response persists counters; operational monitoring must consume them |

No Critical finding was established in this source-only audit. That does not negate F-01/F-02 or the absence of remote verification.

## 8. Readiness matrix

| Area | Verdict | Evidence / boundary |
|---|---|---|
| Upload safety | **PARTIAL** | Strong per-attempt application/DB fencing and local deterministic race tests; provider cancellation remains unavailable and cleanup is scheduled. |
| Asset retention | **PARTIAL** | Reference tables/triggers and retention tests protect source objects; derivative state has the F-01/F-02 gaps. |
| Provider side-effect reconciliation | **NOT READY** | Upload attempts are reconciled locally, but provider operations are not atomically cancellable; publication derivatives lack attempt-level reconciliation. No real adapter/provider verification. |
| Fulfillment reliability | **PARTIAL** | Bounded local recovery, lease/idempotency logic, and synthetic tests; daily schedule, batch backlog, remote provider behavior, and deployment execution unverified. |
| Publication lifecycle | **NOT READY** | Retention and access guards exist, but unpublish/republish cleanup races and unknown derivative outcomes remain open. |
| Cron/scheduler reliability | **PARTIAL** | Repository route, authorization, isolation, batch bounds, and operation results are tested. Actual Vercel delivery is not. |
| Migration safety | **PARTIAL** | Local schema upgrades and trigger tests pass; integration did not finish; no remote D1/Turso compatibility or rollback evidence. |
| Payment-to-fulfillment consistency | **PARTIAL** | Verified predicates, immutable snapshots, and recovery tests exist; not every reverse race or remote payment/database behavior is established. |
| Preview readiness | **NOT READY for maintenance verification** | The Vercel staging lifecycle route fails closed without durable storage, and no deployed Preview database/storage/cron behavior was tested. |
| Production readiness | **NOT READY** | No Production deployment, live Cron, durable remote DB/storage, or provider behavior was verified; F-01/F-02 remain. |

## 9. Recommended next steps

1. Add durable derivative-operation identity and per-generation keys; fence database attachment on current consent and publication lifecycle revision.
2. Claim derivative cleanup in the database before provider deletion; prevent republish from reusing a key while cleanup is in flight. Preserve enough durable metadata to retry/reconcile unknown create and delete outcomes.
3. Add deterministic fake-provider tests for paused derivative creation vs. unpublish/revoke, timed-out late success, delete vs. republish, opposite completion orders, and cleanup failure/retry. Assert both database state and object state.
4. Decide and configure the intended maintenance cadence/capacity. Ensure `MANUAL_REVIEW` and per-item retry counters have an operator-visible alert path; do not describe the one-hour timestamp as an hourly job.
5. Resolve the local integration `ECONNRESET` and obtain a complete local D1 contract run. Separately verify migration compatibility and storage behavior in isolated Preview resources before considering Production. Do not infer this from unit tests.
6. Keep Production blocked until remote database/storage, scheduler execution, provider failure/timeout behavior, and remediation of F-01/F-02 are independently verified.

## 10. Final safety verification

After adding this report:

- Branch remains `main`; HEAD remains `c27136f3c18ef6c20698514b1490d6173830bcf5`.
- No source, test, migration, configuration, or package file was changed by ORDERS-2.55.
- The five pre-existing tracked modifications and five pre-existing untracked reports remain present and untouched.
- The only file added by this audit is `docs/qa/ORDERS-2.55-INDEPENDENT-CROSS-TASK-REGRESSION-AUDIT.md`.
- `git diff --check`: **PASS**; the new report also passed a trailing-whitespace scan.
- No branch switch, fetch, commit, push, deployment, remote database operation, Production access, real payment, customer email, or external provider operation was performed.

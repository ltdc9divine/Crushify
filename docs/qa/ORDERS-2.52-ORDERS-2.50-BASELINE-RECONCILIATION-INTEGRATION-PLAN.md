# ORDERS-2.52 — ORDERS-2.50 Baseline Reconciliation & Safe Integration Plan

## Verdict: PARTIAL — do not integrate ORDERS-2.50 yet

The current local `main` history contains the committed ORDERS-2.40 through ORDERS-2.49 source, migrations, tests, and reports. Both requested commits exist, and `2314879` is an ancestor of current HEAD `c27136f`. The ORDERS-2.50 changes are not committed: four tracked files are modified in the worktree and its QA report is untracked. Their required code and migration dependencies are present in current HEAD, and no duplicate recovery implementation or direct conflict was found.

However, the previously reported development checkout path is absent, and the historical reports identify different checkout paths and branches at different times. This audit cannot prove that the current `main` checkout is the intended integration target. **Recommendation D: do not integrate yet because provenance is insufficient.** This is a provenance gate, not a finding that the ORDERS-2.50 diff is incompatible with `c27136f`.

## 1. Repository identity and Git baseline

- Current working directory: `C:\Users\ltdc9\OneDrive\Desktop\crushify`
- Git repository root: `C:\Users\ltdc9\OneDrive\Desktop\crushify`
- Git common directory: `C:\Users\ltdc9\OneDrive\Desktop\crushify\.git`
- Branch: `main`
- HEAD: `c27136f3c18ef6c20698514b1490d6173830bcf5`
- Upstream: `origin/main`
- Remote: `origin` fetch/push URL `https://github.com/ltdc9divine/Crushify.git`

`git status --short` at the start of this task:

```text
 M src/platform/vercel.ts
 M src/scheduler.ts
 M tests/publications.test.ts
 M tests/scheduler.test.ts
?? docs/qa/ORDERS-2.50-FULFILLMENT-CRON-MIGRATION-REGRESSION-LEGACY-CLEANUP-REMEDIATION.md
?? docs/qa/ORDERS-2.51-REPOSITORY-PROVENANCE-ORDERS-2.50-VERIFICATION.md
```

- Staged changes: none.
- Unstaged tracked changes: the four source/test files above.
- Untracked files before this task: the ORDERS-2.50 and ORDERS-2.51 QA reports above.

Recent history (`git log --oneline --decorate -12`):

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
808a7bb chore(staging): remove temporary operations access
```

All local and cached remote branches:

```text
backup/cloudflare-pre-turso-20261104                      e7cf1dd
main                                                      c27136f [origin/main]
orders-2.40-upload-delete-race-remediation                2314879 [origin/orders-2.40-upload-delete-race-remediation]
remotes/origin/HEAD                                       -> origin/main
remotes/origin/main                                       c27136f
remotes/origin/orders-2.40-upload-delete-race-remediation 2314879
```

Commit verification:

- `2314879f492052e0fb24148358eef151595c03d3`: exists; ancestor of current HEAD.
- `c27136f3c18ef6c20698514b1490d6173830bcf5`: exists; equals current HEAD and is therefore an ancestor of itself.
- `2314879` is the parent in the current `main` line before `c27136f`; the cached ORDERS-2.40 feature branch points to `2314879`.
- No fetch was performed. Cached `origin/*` refs do not prove current remote state.

### Path provenance

The prior development checkout named in earlier requests, `C:\Users\ltdc9\OneDrive\Desktop\======WORK======\crushify`, does not exist now. Current repository details for that path cannot be read.

The reports themselves record an unresolved path transition:

- ORDERS-2.41B records a time when the `======WORK======\crushify` checkout existed and the plain `Desktop\crushify` path did not.
- ORDERS-2.44, 2.46, 2.48, and 2.49 record work in `======WORK======\crushify` on branch `orders-2.40-upload-delete-race-remediation` at `2314879`.
- ORDERS-2.50 and 2.51 record the current plain `Desktop\crushify` path on `main` at `c27136f`.

The current repository has the expected GitHub origin and the same local lineage through commit `2314879`, which supports shared repository history in this checkout. It does **not** prove whether the directories were the same checkout moved/renamed, separate clones, or whether the current branch was the intended development target. No such explanation is established by available Git evidence.

## 2. Remediation provenance matrix

“Committed” refers to the current local Git history, not remote freshness. Audit-only rows do not imply that the report itself introduced source code.

| Remediation | Report exists | Source implementation exists | Tests exist | Committed or uncommitted | Evidence / uncertainty |
|---|---|---|---|---|---|
| ORDERS-2.40 upload/delete race | [Report](./ORDERS-2.40-UPLOAD-DELETE-RACE-REMEDIATION.md) | Yes: upload session state/leases, conditional writes, design deletion guards | Yes: upload/delete interleavings and migration/integration tests | Committed in `2314879`, ancestor of HEAD | Report is PARTIAL: local database fencing is evidenced; delayed external storage operations and remote provider behavior remain unverified. |
| ORDERS-2.41 independent concurrency audit | [Report](./ORDERS-2.41-INDEPENDENT-UPLOAD-DELETE-CONCURRENCY-AUDIT.md) | Audit only; it inspected an older `main` tree lacking ORDERS-2.40 | It reviewed tests in that older tree and identified missing race coverage | Audit report committed in `c27136f`; no source change from the audit | Its FAIL verdict applies to the reported old checkout, not to the current `main` tree containing `2314879`. |
| ORDERS-2.41B provenance reconciliation | [Report](./ORDERS-2.41B-REPOSITORY-PROVENANCE-RECONCILIATION.md) | Not an implementation task | Not applicable | Report committed in `c27136f` | Identified `2314879` as a local candidate but could not verify cached remote authority. Its path observations differ from the current state; no remote query was made. |
| ORDERS-2.42 commit integrity audit | [Report](./ORDERS-2.42-CACHED-ORDERS-2.40-COMMIT-INTEGRITY-AUDIT.md) | Yes: inspected committed ORDERS-2.40 database-level behavior | Yes, but not all external-storage interleavings | Report committed in `c27136f`; implementation in `2314879` | PARTIAL: it explicitly does not establish provider-side fencing or complete end-to-end race prevention. |
| ORDERS-2.43 concurrency re-audit | [Report](./ORDERS-2.43-INDEPENDENT-ORDERS-2.40-CONCURRENCY-REAUDIT.md) | Audit only; it found reference/deletion and checkout/fulfillment gaps in `2314879` | It found missing deterministic coverage for those cases | Report committed in `c27136f`; later fixes are in subsequent committed code | FAIL applied to `2314879`; the code state later changed in ORDERS-2.44 and following work. |
| ORDERS-2.44 reference/checkout/storage remediation | [Report](./ORDERS-2.44-ASSET-REFERENCE-CHECKOUT-REVISION-STORAGE-RACE-REMEDIATION.md) | Yes: normalized asset refs, immutable checkout snapshots, attempt ownership fencing | Yes: reference/deletion and checkout/upload race tests | Source and report committed together in `c27136f` (not a separate 2.44 commit) | PARTIAL: local database behavior is tested; provider-accepted operations cannot be canceled/fenced by a DB lease. |
| ORDERS-2.45 independent audit | [Report](./ORDERS-2.45-INDEPENDENT-ORDERS-2.44-CONCURRENCY-AUDIT.md) | Audit only; found retention, abandoned-upload, paid-order deletion, and legacy cleanup gaps | It identified those gaps in the then-current working tree | Report committed in `c27136f`; later fixes are in 2.46/2.48 | FAIL reflected the inspected pre-fix state; does not by itself establish the later state. |
| ORDERS-2.46 lifecycle/fulfillment/upload remediation | [Report](./ORDERS-2.46-ASSET-LIFECYCLE-FULFILLMENT-UPLOAD-RECOVERY-REMEDIATION.md) | Yes: order/asset guards, cleanup reconciliation, retry and state handling | Yes: local lifecycle, stale upload, payment snapshot and cleanup regressions | Source and report committed together in `c27136f` | The report says PASS for its local scope; ORDERS-2.47 subsequently found incomplete retention and legacy proof, so that PASS was not a final verification of those claims. |
| ORDERS-2.47 independent claim audit | [Report](./ORDERS-2.47-INDEPENDENT-ORDERS-2.46-CLAIM-VERIFICATION.md) | Audit only; it found gaps in direct retention protection, reconciliation, and legacy backfill proof | It reported missing direct-trigger and historical-sequence tests | Report committed in `c27136f`; later remediation is committed in 2.48-era code/tests | FAIL reflected the earlier worktree state, before migration 0012 and its later tests. |
| ORDERS-2.48 retention/reconciliation/legacy remediation | [Report](./ORDERS-2.48-PUBLICATION-RETENTION-UPLOAD-RECONCILIATION-LEGACY-CLEANUP-REMEDIATION.md) | Yes: migration 0012, retained-publication predicates, upload reconciliation, cleanup ordering | Yes: associated local tests | Source, migration, tests, and report committed together in `c27136f` | PARTIAL: the report records the earlier local D1 integration failure as inconclusive; remote D1/Turso/provider behavior is unverified. |
| ORDERS-2.49 independent remediation audit | [Report](./ORDERS-2.49-INDEPENDENT-ORDERS-2.48-REMEDIATION-AUDIT.md) | Audit only; it identified missing Vercel fulfillment recovery and migration/legacy regressions | Audit found specific missing direct-trigger and historical-backfill coverage | Report committed in `c27136f`; its 2.50 remedies are not committed | PARTIAL: the report states current tests/typecheck passed but local integration did not complete; three identified gaps motivate ORDERS-2.50. |
| ORDERS-2.50 Cron/migration/legacy remediation | [Report](./ORDERS-2.50-FULFILLMENT-CRON-MIGRATION-REGRESSION-LEGACY-CLEANUP-REMEDIATION.md) | Yes, in the current worktree only | Yes, in the current worktree only | Uncommitted: four unstaged tracked files plus untracked report | Report verdict PARTIAL: targeted gaps are reported closed; latest local integration is reported PASS but prior failure cause remains inconclusive. No results were rerun in this audit. |

### Current implementation facts

The current HEAD contains migrations [0010](../../migrations/0010_asset_upload_leases.sql), [0011](../../migrations/0011_asset_reference_and_upload_attempts.sql), and [0012](../../migrations/0012_lifecycle_retention_and_upload_recovery.sql). The migration sequence provides upload leases, normalized design/order asset references, immutable order snapshots, attempt-level cleanup state, and the retained-publication asset deletion trigger.

The current committed [asset lifecycle](../../src/assets.ts) uses conditional session/attempt state transitions and cleanup ownership tokens. [Design updates/deletion](../../src/designs.ts) persist reference changes with conditional state checks and preserve protected order/publication data. [Checkout](../../src/payments.ts) writes immutable snapshots and asset pins. [Fulfillment recovery](../../src/publications.ts) uses verified SePay/processed-webhook predicates, attempt limits, and job lease tokens.

The Vercel Cron route and configuration already exist at HEAD, and the Cloudflare Worker scheduled handler already calls `recoverPendingFulfillments`. But HEAD's [`src/scheduler.ts`](../../src/scheduler.ts) only runs publication lifecycle and upload cleanup; HEAD's Vercel route calls that scheduler without fulfillment recovery. Thus the relevant ORDERS-2.50 behavior is not already present in the committed Vercel path.

## 3. ORDERS-2.50 comparison against current HEAD

Current unstaged diff: **4 tracked files, 681 insertions and 80 deletions**. No staged changes.

| File | Exact change inventory | Baseline dependency and conflict assessment |
|---|---|---|
| [`src/scheduler.ts`](../../src/scheduler.ts) | Adds bounded `limit` validation; uses existing `resolvePaymentEnvironmentPolicy` and `recoverPendingFulfillments`; runs recovery, publication lifecycle, and upload cleanup as isolated operations; emits fixed safe error categories and records per-operation outcomes/failure state. | Required recovery function, payment policy, DB lease tables, publication lifecycle, and upload reconciler exist in HEAD. HEAD lacks only the Vercel scheduler invocation. No second fulfillment mechanism is introduced. |
| [`src/platform/vercel.ts`](../../src/platform/vercel.ts) | Both staging-manual and Production scheduled responses now return HTTP 503 for an acquired result with a failed operation, rather than always returning 200. | The authenticated/configured route and scheduler call already exist. Change is consistent with the new `failed` result field; it does not alter auth or environment classification. |
| [`tests/publications.test.ts`](../../tests/publications.test.ts) | Adds a due-cleanup fixture; extends the route-to-scheduler test for paid fulfillment, no-auth/no-connect behavior, publication and upload cleanup, and repeat behavior; adds failure-isolation and batch/idempotency route tests; updates per-operation result assertions; replaces the legacy cleanup fixture with a 0010→0011 backfill and 0012 upgrade sequence plus retained-ledger assertions; adds direct raw SQL 0012 trigger coverage. | Existing local test helpers, migrations, adapters, storage doubles, recovery and cleanup code exist in HEAD. No migration or external-service dependency is added. Test behavior is uncommitted and therefore not part of branch HEAD. |
| [`tests/scheduler.test.ts`](../../tests/scheduler.test.ts) | Updates scheduler result assertions for per-operation outcomes and confirms fulfillment is skipped under the staging runtime policy. | Existing scheduler lease and environment policy are in HEAD. No dependency is missing. |

Untracked files before this audit:

- [`ORDERS-2.50-FULFILLMENT-CRON-MIGRATION-REGRESSION-LEGACY-CLEANUP-REMEDIATION.md`](./ORDERS-2.50-FULFILLMENT-CRON-MIGRATION-REGRESSION-LEGACY-CLEANUP-REMEDIATION.md) — ORDERS-2.50 report.
- [`ORDERS-2.51-REPOSITORY-PROVENANCE-ORDERS-2.50-VERIFICATION.md`](./ORDERS-2.51-REPOSITORY-PROVENANCE-ORDERS-2.50-VERIFICATION.md) — pre-existing audit report from the prior task.

No files were changed in [migration 0012](../../migrations/0012_lifecycle_retention_and_upload_recovery.sql), Vercel configuration, route re-export, database adapters, payment implementation, publication recovery implementation, upload/design lifecycle implementation, or the tagged [`templates/our-universe/index.html`](../../templates/our-universe/index.html).

### Baseline functionality versus ORDERS-2.50 additions

- **Already committed:** authenticated Production Vercel Cron route; daily Vercel configuration; scheduler lease; publication lifecycle; upload-attempt cleanup; `recoverPendingFulfillments` helper with payment validation and job leases; migration 0012 retention trigger and upload reconciliation schema; legacy archived cleanup ordering.
- **Missing from committed Vercel scheduler:** invocation of fulfillment recovery and per-operation failure isolation/status handling.
- **Added only in the ORDERS-2.50 worktree:** the Vercel scheduler wiring, failure reporting change, actual-route regression assertions, direct SQL trigger test, and migration-backfill legacy regression.
- **No dependency absent from HEAD:** all code symbols, migrations, tables, and test fixtures relied upon by the diff are available at `c27136f`.
- **No duplicate or direct conflict found:** the diff reuses the established recovery function and scheduled lease. The checked-in Vercel Cron is the configured lifecycle entry point; no new cron configuration or migration is introduced.

If `c27136f` is confirmed as the target baseline, the diff appears technically applicable to that baseline. This does not resolve whether that baseline/branch is the intended development target, and it does not authorize applying or committing the diff.

## 4. Test evidence and remaining uncertainty

No tests were run for ORDERS-2.52.

The existing ORDERS-2.50 report records the following results, which are historical report evidence rather than fresh verification in this task:

- Focused Cron tests: reported PASS, 3 tests.
- Focused migration-trigger and legacy-cleanup tests: reported PASS, 2 tests.
- Database and scheduler tests: reported PASS, 11 tests.
- `npm test`: reported PASS, 181 tests.
- `npm run typecheck`: reported PASS.
- `npm run test:integration`: reported PASS against disposable local Wrangler/D1 resources.
- `git diff --check`: reported PASS.

The ORDERS-2.50 report also leaves the cause of the earlier `SQLITE_IOERR_TRUNCATE`/`ECONNRESET` inconclusive. This audit did not reproduce or diagnose it. The direct migration-trigger test executes migration SQL via the local libSQL test adapter; it is not evidence of remote D1/Turso behavior. The Cron test invokes the handler with synthetic Production configuration and injected local adapters; it is not evidence that Vercel delivered a production Cron invocation. No remote services, production resources, payments, or storage were accessed.

## 5. Safest integration strategy

**Choice D — Do not integrate yet because provenance is insufficient.**

Reasons:

1. The expected prior development path is absent; the reports document more than one checkout path and branch history does not prove which is canonical.
2. The current branch is `main`, while several remediation reports describe work on `orders-2.40-upload-delete-race-remediation`. Although current `main` descends from that branch's `2314879` commit, the intended target branch has not been confirmed.
3. ORDERS-2.50 is only an unstaged worktree diff, not a commit or branch ref. The local `origin/main` ref is cached; it was not refreshed.
4. The diff is technically compatible with current HEAD based on inspected dependencies, but code compatibility is not a substitute for confirming the authorized checkout and target branch.

### Exact next safe steps, in order

1. Confirm with the repository owner which checkout path and branch are canonical for development. Do not infer this from repository name, remote URL, or cached refs.
2. If the intended checkout is elsewhere, locate it without copying, overwriting, or changing either checkout; capture its root, common Git directory, branch, HEAD, upstream, remotes, and complete status read-only.
3. Compare that checkout's HEAD and status with this report's `c27136f` baseline and the four-file ORDERS-2.50 diff. Confirm that no user work is missing or overlapping before planning any integration.
4. Obtain explicit authorization for the target branch and a non-destructive integration method. Keep the existing uncommitted changes and both existing untracked reports intact; do not stage or commit them as part of this audit.
5. Only after approval, prepare the change against the confirmed baseline in an authorized isolated integration environment, review the exact resulting diff, and run focused Cron, migration, legacy-cleanup, typecheck, unit, and disposable-local integration checks. Record any inconclusive local integration result separately from remote behavior.

No step above was performed beyond read-only inspection and creation of this report.

## 6. Final safety verification

After adding this report, branch and HEAD remained unchanged (`main`, `c27136f3c18ef6c20698514b1490d6173830bcf5`). No source, test, migration, configuration, package, or existing report was edited. The four pre-existing modified tracked files and the two pre-existing untracked reports remain preserved. This ORDERS-2.52 report is the only file added by this task.

No integration, staging, commit, push, fetch, pull, merge, rebase, cherry-pick, reset, stash, branch operation, deployment, payment/webhook operation, Production access, or remote database operation was performed.

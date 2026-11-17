# ORDERS-2.60 — Cleanup Completion and Late Provider Success Remediation

## Result

**Targeted local remediation: PASS. Preview readiness: NOT DECLARED. Production: NOT AUTHORIZED.**

Both reported blockers were reproduced before the implementation change. The new deterministic regressions pass after remediation. Local tests do not establish remote database or provider behavior, and a process crash after provider success but before the success marker is persisted remains an uncertain outcome.

## Repository baseline and final state

Repository: `C:\Users\ltdc9\OneDrive\Desktop\======WORK======\crushify`  
Branch: `main`  
HEAD: `1be81d555914a9a4f2dc794e96154f371c5cc841`  
Upstream: `origin/main`

The starting tree was already dirty. It had no staged changes, 11 modified tracked files, and five untracked ORDERS-2.56–2.59 reports plus migration 0013. The starting modified tracked files were `src/designs.ts`, `src/index.ts`, `src/logging.ts`, `src/platform/vercel.ts`, `src/publications.ts`, `src/scheduler.ts`, `tests/database-contract.test.ts`, `tests/database.test.ts`, `tests/publications.test.ts`, `tests/scheduler.test.ts`, and `tests/vercel.test.ts`.

At completion, the same 11 tracked files remain modified and unstaged. The pre-existing reports and migration 0013 remain untouched. This task added only:

- `migrations/0014_derivative_provider_success_reconciliation.sql`
- This ORDERS-2.60 report

No commit, push, merge, branch switch, deployment, remote migration, or remote provider/database access occurred.

## Blocker A — `COMPLETED` despite a future uncertain recheck

**Before:** `cleanupAssets()` excluded future `CLEANED` tombstone checks from reconciliation. When provider deletion had an uncertain result and its next recheck was scheduled for later, immediate cleanup could report `completed` even though cleanup work remained.

**Reproduction:** `reports deferred while an uncertain CLEANED tombstone awaits its next provider recheck` in `tests/publications.test.ts` constructs a `CLEANED` operation with no confirmed provider-success marker and a future recheck. Before the fix it failed with actual `completed`, expected `deferred`.

**After:** `cleanupAssets()` now uses the same reconciliation semantics as scheduled work (`src/publications.ts:430`). The due and deferred queries distinguish confirmed cleanup from unknown provider outcomes (`src/publications.ts:511`, `src/publications.ts:660`): an uncertain tombstone with a future recheck is reported as `deferred`; a successfully created and subsequently verified-deleted derivative does not schedule an unnecessary tombstone check. The scheduler route test now expects completion after confirmed cleanup.

Relevant regression tests:

- `reports deferred while an uncertain CLEANED tombstone awaits its next provider recheck`
- `avoids redundant tombstone rechecks after confirmed provider cleanup`
- `runs the authenticated Production Vercel Cron route against synthetic expiry and cleanup records`
- `reconciles a provider success after cleanup has reached manual review`
- `fences cleanup finalization when provider success arrives during deletion`

## Blocker B — provider success after `MANUAL_REVIEW`

**Before:** A derivative create request could remain in flight while cleanup exhausted retries and moved its journal row to `MANUAL_REVIEW`. If the provider later returned success, the row was not reliably made discoverable for cleanup.

**Reproduction:** `reconciles a provider success after cleanup has reached manual review` in `tests/publications.test.ts` pauses provider creation with a deferred promise, revokes consent, drives cleanup to `MANUAL_REVIEW`, and only then releases the provider success. Before the fix the test failed because reconciliation could not clean the late object.

**After:** Migration 0014 adds `provider_create_succeeded_at`. A returned provider success is recorded with `COALESCE` against the immutable operation ID/token; newly observed success requeues `MANUAL_REVIEW` or `CLEANED` rows for cleanup, resets the exhausted retry counter when reopening manual review, and makes the work immediately due (`src/publications.ts:1032`). The subsequent `READY` transition requires that marker (`src/publications.ts:1056`).

Cleanup claims, finalization, and failure handling compare the marker value observed by the claim (`src/publications.ts:552`, `src/publications.ts:598`, `src/publications.ts:620`). If a late success changes that value while a cleanup worker is active, the stale worker cannot finalize or overwrite the new state. The test separately verifies the late derivative is removed and a different active publication’s derivative remains.

`fences cleanup finalization when provider success arrives during deletion` adds a second deterministic ordering: provider deletion is paused after cleanup claims the operation, the create response then records success, and the stale cleanup resumes. The stale claim cannot mark the operation complete; a later reconciliation completes cleanup.

Migration backfill is deliberately conservative: only legacy `READY` operations prove provider creation succeeded. `CREATING`, `CLEANED`, and other ambiguous legacy states remain uncertain; an expired lease alone is not treated as proof of provider success (`migrations/0014_derivative_provider_success_reconciliation.sql:1`). The migration regression verifies those cases and repeat application.

## Changed files for this remediation

- `src/publications.ts` — truthful deferred/completed calculation, durable provider-success recording, and cleanup fencing.
- `migrations/0014_derivative_provider_success_reconciliation.sql` — success marker and conservative backfill.
- `tests/publications.test.ts` — deterministic blocker regressions and expectations for known versus uncertain tombstones.
- `tests/database.test.ts` — migration 0014 upgrade, backfill, and idempotence coverage.
- `tests/database-contract.test.ts` and `tests/vercel.test.ts` — expected migration version updated through 14.

No source or test files were created outside this list. Other tracked files were already modified before this task and were preserved.

## Validation

| Command | Result |
|---|---|
| `node --experimental-strip-types --test --test-name-pattern="(uncertain CLEANED tombstone|provider success after cleanup has reached manual review|fences cleanup finalization when provider success arrives during deletion)" tests/publications.test.ts` | PASS, 3/3 targeted regressions |
| `node --experimental-strip-types --test tests/database.test.ts tests/database-contract.test.ts` | PASS, 9/9 |
| `npm test` | PASS, 198/198 tests across 29 suites |
| `npm run typecheck` | PASS |
| `git diff --check` | PASS |
| `npm run test:integration` | PASS: `Local integration: passed (D1 API and payment contracts, legacy regression, constraints, and batch rollback).` |

Integration ran with Wrangler’s local D1 persistence, loopback HTTP, and synthetic test values. It did not contact remote D1/Turso, Cloudinary, SePay, Vercel, or Production.

## Remaining risks and limitations

- Local tests do not verify deployed migration behavior, remote D1/Turso transaction semantics, or provider consistency/latency.
- If the application process terminates after the provider creates an object but before the application persists `provider_create_succeeded_at`, the operation journal still retains its immutable key and uncertain cleanup state, but this change cannot prove that the provider succeeded or automatically reopen a terminal manual-review row without an observed success response.
- Existing scheduled cleanup cadence can delay future reconciliation; local scheduler tests do not prove actual Cron execution.
- No Preview or Production deployment was performed. Preview readiness is therefore not declared, and Production remains unauthorized.

## Final status

HEAD and branch are unchanged. No staged changes were introduced. The pre-existing dirty worktree was preserved; the only additional untracked files are migration 0014 and this report.

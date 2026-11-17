# ORDERS-2.56 — Publication Derivative Cleanup Race Remediation

## Verdict

**PARTIAL — both races were reproduced; F-01 is locally fixed with a deterministic regression, and F-02 is mitigated with durable reconciliation but retains provider/scheduler limitations. Preview is NOT READY; Production is NOT AUTHORIZED.**

## Repository baseline and final state

The initial repository state was recorded before inspection or edits:

| Item | Initial value |
|---|---|
| Root | `C:\Users\ltdc9\OneDrive\Desktop\======WORK======\crushify` |
| Branch / upstream | `main` / `origin/main` |
| HEAD | `1be81d555914a9a4f2dc794e96154f371c5cc841` |
| Working tree | Clean; no staged, unstaged, or untracked changes |

This observed HEAD differs from the historical `c27136f...` baseline in the request. The ORDERS-2.50 through ORDERS-2.55 reports were present and were not edited.

Final state:

- Branch, upstream, and HEAD are unchanged.
- No staged changes.
- Nine modified tracked files: `src/index.ts`, `src/logging.ts`, `src/publications.ts`, `src/scheduler.ts`, `tests/database-contract.test.ts`, `tests/database.test.ts`, `tests/publications.test.ts`, `tests/scheduler.test.ts`, and `tests/vercel.test.ts`.
- Two untracked files: `migrations/0013_publication_derivative_operations.sql` and this report.
- No earlier worktree modifications existed at baseline; no existing report was modified.
- No commit, push, merge, branch switch, remote migration, or deployment occurred.

## Findings and remediation

ORDERS-2.55 identified:

- **F-01:** derivative cleanup could delete a provider object while a concurrent republish reused the still-READY key, then clear the database reference after publishing succeeded.
- **F-02:** a derivative create could remain in flight while cleanup cleared its metadata; a later provider success then left an untracked object without a durable reconciliation record.

### F-01 — cleanup racing with republish

**Reproduced and fixed locally.**

`tests/publications.test.ts:1459`, **“does not delete a derivative when republish wins during unpublish cleanup”**, uses a deferred provider-delete barrier. It pauses unpublish after cleanup has claimed the derivative, attempts republish, verifies republish is rejected while cleanup owns the prior derivative, resumes deletion, and then verifies a retry publishes with a fresh key. It checks both the database row and provider objects. This is a deterministic interleaving, not sequential-call coverage.

The corrected flow in `src/publications.ts`:

1. `reconcilePublicationDerivativeCleanup` (line 427) transitions obsolete operations to `CLEANUP_PENDING`, claims each with a conditional cleanup token and lease, and rechecks that no published publication still references the exact READY key before provider deletion.
2. It verifies deletion with a provider read, finalizes only if the cleanup token still owns the operation, and clears only the matching derivative key/status.
3. `publish` (around lines 815–957) will not reuse a derivative unless its operation is READY. It stages a unique key and CREATING operation before provider work, and the final PUBLISHED update requires the attached derivative operation to remain READY.

The ordering is protected by persistent conditional state transitions and attempt-specific keys. The local SQLite/libSQL barrier test establishes the application-level behavior; it does not prove remote database isolation semantics.

### F-02 — late provider success after revoke/cleanup

**Reproduced and mitigated locally; residual provider limitation remains.**

`tests/publications.test.ts:1544`, **“retains and reconciles a timed-out derivative creation after consent revocation”**, blocks derivative creation, revokes consent and allows cleanup to finish, then releases the provider to create the object and simulate a timeout. It separately verifies revoked/cleared database state, retained operation tombstone, and provider object existence. It then invokes the scheduled lifecycle and verifies the late object is removed; repeated cleanup is also checked.

Migration 0013 creates a durable `publication_derivative_operations` journal and backfills existing keyed derivatives. The journal intentionally does not cascade with `publication_assets`: the derivative key and publication ID must survive pointer clearing/deletion to support recovery. Creation is recorded before the provider request; a stale creation cannot attach READY after consent or lifecycle state changes. Successful cleanup retains a CLEANED tombstone and schedules a one-hour recheck for late provider success.

`tests/publications.test.ts:1658`, **“counts exhausted derivative cleanup once and leaves it for manual review”**, verifies the eighth failed cleanup enters MANUAL_REVIEW, is counted once, and is no longer automatically retried.

Limitations:

- No provider cancellation or conditional-create guarantee was established. A provider request can complete after the application has moved on.
- A CLEANED tombstone is periodically rechecked, but the Vercel schedule in `vercel.json` is daily (`0 3 * * *`), not hourly. The one-hour timestamp is not an hourly execution guarantee.
- Once deletion failures exhaust retries and the operation reaches MANUAL_REVIEW, automated reconciliation stops. A provider success occurring after that state needs operator intervention. Consequently, F-02 is mitigated, not proven safe for arbitrary provider timing/failure.

## Migration, scheduler, and integration evidence

- Migration 0013 adds the derivative-operation journal, indexes cleanup/publication lookups, and backfills keyed legacy derivatives as READY, CREATING, or CLEANUP_PENDING according to their prior state.
- Migration coverage includes fresh application and safe reapplication in `tests/database.test.ts` (**“applies the existing schema, preserves constraints, and safely no-ops on repeat”**), upgrade through versions 12 and 13 from an 0011 schema, and an existing legacy archived/reference-backfill regression. In `tests/publications.test.ts:2052`, **“retries legacy archived cleanup after reference backfill without losing the source object”** asserts a keyed PENDING derivative is backfilled as CREATING before retrying cleanup. All migration tests are local.
- `runScheduledPublicationLifecycle` in `src/scheduler.ts:131` invokes derivative reconciliation and reports operation results. The authenticated Vercel Cron regression at `tests/publications.test.ts:792` exercises the route and asserts the operation completed. The Cloudflare `scheduled()` handler in `src/index.ts:173` also invokes reconciliation. The repository configures Vercel Cron; no Cloudflare Cron trigger is configured here.
- The prior ORDERS-2.55 `ECONNRESET` was reported at `tests/integration.mjs:1008`, during a loopback design-delete request. The harness uses local Wrangler/D1, a temporary persistence directory, and `127.0.0.1:8787`; the port was not listening before this run. The current single `npm run test:integration` run **passed** with exit code 0 (`Local integration: passed (D1 API and payment contracts, legacy regression, constraints, and batch rollback)`). Thus the earlier reset did not recur, but this evidence does not establish its original cause or prove it was fixed by this patch.
- No remote D1/Turso, R2/Cloudinary, Vercel Cron delivery, or Production behavior was exercised.

## Validation

| Command | Result |
|---|---|
| Deterministic F-01/F-02, cleanup, legacy, and scheduler regressions | PASS; 6 tests, 0 failures |
| Migration upgrade and authenticated Cron regressions | PASS; 3 tests, 0 failures |
| Derivative cleanup manual-review regression | PASS; 1 test, 0 failures |
| `npm test` | PASS; 185 tests, 29 suites, 0 failures |
| `npm run typecheck` | PASS |
| `npm run test:integration` | PASS; local Wrangler/D1 integration completed |
| `git diff --check` | PASS |

All automated tests ran against local/in-memory fixtures. The full suite does not establish remote concurrency or provider guarantees.

## Readiness

**Preview: NOT READY.** F-01 is deterministically fixed locally. F-02 has a durable tombstone and successful scheduled recovery test, but external provider completion cannot be cancelled or bounded by local evidence; manual-review exhaustion and daily Cron cadence leave a residual cleanup window. Remote database/storage behavior and actual scheduled delivery remain unverified.

**Production: NOT AUTHORIZED.**

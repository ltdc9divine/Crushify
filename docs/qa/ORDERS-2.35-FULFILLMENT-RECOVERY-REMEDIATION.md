# ORDERS-2.35 — Fulfillment Recovery Remediation

**Verdict: PARTIAL — REMOTE VERIFICATION REQUIRED**

Local fulfillment recovery is now durable, retryable, and covered by persisted-database tests. This is not a Production-readiness approval: migration 0009, deployed database state, and any operational recovery schedule remain unverified. No payment or deployment gate was enabled.

## Scope and baseline

The change addresses fulfillment failures after verified payment settlement. It does not enable checkout, SePay settlement, Preview fulfillment, a new operator endpoint, or a scheduler.

Initial Git baseline:

- Branch: `main`
- HEAD: `4f4aaa354893309dd8ed325882bfa461058aa9d3`
- Staged, modified, and untracked files: none

ORDERS-2.33 identified that payment settlement durably created a fulfillment job but failed fulfillment could remain in `FULFILLING` without bounded recovery; the configured Vercel Cron runs publication lifecycle only, and the Wrangler fulfillment Cron triggers were disabled. ORDERS-2.34 added variable hosting durations and renewal persistence, so recovery also had to avoid repeating an already-applied renewal.

## Remediation

### Durable job state

Migration `0009_fulfillment_recovery_leases.sql` rebuilds `fulfillment_jobs`, preserves existing job IDs, order references, statuses, attempt counts, error codes, and timestamps, and adds:

- `MANUAL_REVIEW` status.
- `next_attempt_at`, `lease_token`, `lease_expires_at`, and `last_failure_at`.
- A recovery index over status and retry/lease timestamps.

Existing `PROCESSING` jobs without lease metadata remain reclaimable. Migration 0009 is forward-only and was applied only to ephemeral local test databases; it was not run remotely.

### Eligibility, claims, retries, and finalization

`src/publications.ts` now:

- Rechecks that a job belongs to a `SELF_SERVICE` order with a successful SePay payment, matching processed webhook evidence, matching amount/currency, a payment ID and success time, and no payment review flags. Unpaid, failed, mismatched, or unverified orders are not selected or claimed for fulfillment.
- Claims jobs atomically with a five-minute lease and a per-claim random fencing token. Another worker cannot claim a live lease; expired or legacy tokenless claims can be reclaimed. Only the current token can record failure or complete the job.
- Retries failures using a 30-second exponential delay, capped at one hour, for at most eight attempts. Exhausted jobs become `MANUAL_REVIEW` and stop automatic retries.
- Persists fixed safe failure categories rather than raw exception messages. Payment success is not rolled back when fulfillment fails.
- Completes a job only after the order is fulfilled and its entitlement exists. Existing publication identity/URL is reused on retry; renewal entitlement persistence prevents extending the same renewal twice.
- Returns and logs manual-review counts. `src/index.ts` and `src/logging.ts` carry that count through the existing safe maintenance logging path.

The fencing token protects database state transitions; it does not prove that an arbitrary external storage operation is exactly-once. Publication uniqueness and reuse provide local idempotency for the tested flow, but provider-level behavior still requires deployment-specific verification.

## Files changed

- `src/publications.ts` — verified-payment eligibility, leased claims, bounded retries, manual review, and idempotent finalization.
- `migrations/0009_fulfillment_recovery_leases.sql` — forward schema migration preserving existing jobs.
- `src/index.ts`, `src/logging.ts` — safe manual-review count in existing maintenance logs.
- `tests/payment-contract.mjs`, `tests/vercel.test.ts` — replay, failed fulfillment, due/backoff handling, concurrent claims, active/expired lease, retry exhaustion, publication identity reuse, and renewal recovery scenarios.
- `tests/database.test.ts`, `tests/database-contract.test.ts` — migration preservation and version assertions.
- `docs/DATABASE_SCHEMA.md`, `docs/PAYMENT_FLOW.md` — schema and retry policy documentation.
- `docs/qa/ORDERS-2.35-FULFILLMENT-RECOVERY-REMEDIATION.md` — this report.

## Verification

Final local verification after implementation:

- `npm run typecheck` — passed.
- `npm test` — **141 passed, 0 failed**.
- `npm run test:integration` — passed; local Wrangler/D1 API and payment contracts, regression/constraint checks, and batch rollback.
- `git diff --check` — passed after report creation and its final edits.

The unit suite also runs the shared payment contract against an ephemeral local Turso/libSQL file database. All test data and provider behavior are synthetic/local. No remote migration or database was accessed.

## Operational status and remaining blockers

- Recovery code is present in the existing Worker maintenance handler, but the Wrangler Cron triggers remain disabled. The daily Vercel Cron remains publication-lifecycle-only; it does not invoke fulfillment recovery. No recovery scheduler or operator route was added or activated.
- Do not enable Production checkout/payment or schedule Production recovery as part of this local remediation. Before activation, the owner must approve a recovery mechanism and manual-review operating procedure; operators must verify deployed migration state, backup/recovery procedures, and monitoring in the intended environment.
- No migration rollback script is provided. If a deployed migration needs correction, preserve data and use a reviewed forward repair. Confirm the application/migration rollout and rollback procedure in a disposable environment before any deployed rollout.
- Existing deployment/payment gates and Cron configuration were not changed. The `fulfillmentEnabled` runtime policy was not broadened or altered.
- Remote schema state, provider behavior, scheduler execution, production resources, and deployment configuration remain unverified.

## Safety and final Git state

No remote provider, database, Production resource, real payment, email, deployment, or migration operation was performed. No commit, push, merge, or deployment was made.

Final Git state after creating this report:

- Branch: `main`
- HEAD: `4f4aaa354893309dd8ed325882bfa461058aa9d3`
- Expected worktree: 9 modified tracked files and 2 untracked files (the new migration and this report); no staged changes.


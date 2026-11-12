# ORDERS-2.18 — Pre-Staging Security Remediation

## Verdict

**PARTIAL — REMOTE VERIFICATION REQUIRED**

Local fail-closed guards and synthetic regression coverage are in place. This does not prove that Vercel Preview, Turso, Cloudinary, email, or SePay resources are isolated remotely. Do not configure or use Preview Cloudinary until an authorized owner verifies its account and cloud identity independently.

## Scope and safety

- No application Production, Vercel dashboard, Turso database, Cloudinary asset/account, or SePay provider was accessed or changed.
- No real email, payment, deployment, commit, push, or merge was performed.
- Tests use synthetic values, a local Turso file/D1 fixture, in-memory storage, and a loopback-only mail sink.
- No secret values were read or included in this report.

## Git state

At the ORDERS-2.18 baseline, the recorded worktree was on `main` at `5205f730fd0141fb9c8d0697787b700e4bda04ff`, with 26 modified tracked files and 9 untracked files. These pre-existing changes were preserved.

At completion, the branch and HEAD are unchanged. The worktree contains 36 modified tracked files and 13 untracked files, including the pre-existing QA reports and fixtures, ORDERS-2.18 code/tests, and this report. Nothing is staged. `git diff --check` passes.

The ORDERS-2.18 changes touch `src/platform/vercel.ts`, `src/auth.ts`, `src/types.ts`, `src/logging.ts`, related error-log call sites, `scripts/staging-config.ts`, `docs/VERCEL_STAGING.md`, and regression/integration test harnesses. Other worktree changes are not attributed to this task.

## Remediation and evidence

| Area | Result | Local finding and change | Remaining limitation |
|---|---|---|---|
| Cloudinary Preview isolation | **PARTIAL** | Preview Cloudinary initialization fails closed unless staging cloud identity and `CLOUDINARY_PRODUCTION_CLOUD_NAME` are present, differ case-insensitively, and the staging name is not the previously identified cloud. The local smoke-script guard follows the same rule. A self-declared isolation confirmation is no longer treated as evidence. Tests verify the storage factory is not called after the guard rejects. | Different configured names do not prove separate account ownership or credentials. Verify the Cloudinary account/cloud and API credential scope through an authorized, read-only owner check before configuring Preview or running any smoke upload. No provider calls were made. |
| Preview environment scope | **PASS — LOCAL IMPLEMENTATION** | Preview must use the staging environment marker and staging Turso variables. Production Turso, Cloudinary, mail, payment, SePay, and local-test credentials/flags are rejected in Preview. Local mail-sink URLs are rejected outside local development. Production rejects staging-only configuration. | Vercel Preview/Production variable assignments were not inspected or changed. |
| Logging and redaction | **PASS — LOCAL IMPLEMENTATION** | Application error/info logging is centralized. Records contain validated event/category/environment identifiers, request IDs, allowlisted error types, and bounded counters; raw error messages/stacks and arbitrary context are excluded. Regression tests use synthetic authorization, cookie, password, URL, webhook, magic-link, and user-content sentinels. | Remote log drains, retention, access controls, and provider-side redaction remain unverified. |
| Email and magic links | **PASS — LOCAL IMPLEMENTATION** | Preview can only use the explicit discard sink; without it, email is unavailable. Preview credentials cannot fall through to Resend. The discard sink logs neither recipient nor content and cannot deliver a usable interactive link. Local test mode accepts an injected callback or a fixed-path HTTP sink restricted to loopback. Integration/browser harnesses retrieve synthetic tokens through that sink instead of logs. Production Resend behavior remains covered by a mocked adapter test. | Preview interactive sign-in is not available with the discard sink. Any separate staging delivery mechanism requires a reviewed design and authorized configuration; none was enabled. |
| Database/provider boundary | **PASS — LOCAL IMPLEMENTATION** | Preview selects only `TURSO_STAGING_DATABASE_URL` / `TURSO_STAGING_AUTH_TOKEN`; Production uses generic Turso variables and rejects a staging database hostname. Missing configuration fails before connection. Existing D1 support remains unchanged. | No remote Turso identity, migration, backup, or recovery verification was performed. |
| Payments and lifecycle | **PASS — LOCAL CONTRACT ONLY** | Existing payment/lifecycle gates were retained; mock settlement remains local-only, and Cron authentication/environment checks remain protected. Synthetic payment and lifecycle tests run in the regression suites. Pricing, scheduler configuration, and provider contracts were not changed by this remediation. | No SePay staging callback, deployed Vercel Cron, Preview lifecycle schedule, or Production operation was exercised. |

### Environment variable names

Names only; no values are recorded here.

- Preview app/database: `ENVIRONMENT`, `DATABASE_PROVIDER`, `TURSO_STAGING_DATABASE_URL`, `TURSO_STAGING_AUTH_TOKEN`, `STORAGE_PROVIDER`, `APP_ORIGIN`.
- Cloudinary, only after owner verification: `CLOUDINARY_STAGING_CLOUD_NAME`, `CLOUDINARY_STAGING_API_KEY`, `CLOUDINARY_STAGING_API_SECRET`, `CLOUDINARY_PRODUCTION_CLOUD_NAME`.
- Preview email suppression: `PREVIEW_EMAIL_SINK`.
- Local test mail only: `LOCAL_TEST_MAIL_SINK_URL` (loopback only; rejected in Preview and Production).
- Payment/Cron names remain governed by existing local code and deployment policy; no remote values were inspected or changed.

## Regression results

| Command | Result |
|---|---|
| `node --experimental-strip-types --test tests/pre-staging-security.test.ts tests/staging-config.test.ts tests/vercel.test.ts tests/scheduler.test.ts tests/worker.test.ts` | PASS |
| `npm run typecheck` | PASS |
| `npm test` | PASS — 100 tests, 0 failures |
| `npm run test:integration` | PASS — local D1 API/payment contracts, legacy regression, constraints, and rollback fixture |
| `npm audit --omit=dev` | PASS — 0 production dependency vulnerabilities reported |
| `git diff --check` | PASS |

Tests ran against local synthetic fixtures. They are not evidence of remote provider or deployment readiness. The integration harness removed its isolated local data directory; no leftover matching directory was found.

## Required external verification before staging use

1. An authorized owner verifies the Vercel Preview project/environment and confirms it does not inherit Production credentials. Configure only approved Preview variables through the normal secret-management workflow.
2. Verify a dedicated Turso staging database and database-scoped token, migration state, backup, and recovery procedure. Do not run Preview migrations against Production.
3. Before Cloudinary is enabled, verify the staging account/cloud is separate from Production and that its credentials cannot write or delete Production assets. Only then consider a synthetic staging smoke test.
4. Keep Preview email on discard until an approved test-only delivery path exists. Keep real payment credentials absent; verify SePay Test Mode only in a separately authorized staging process.
5. Confirm the Production Cron schedule/secret and deployed execution through the approved release process. Preview has no automatic lifecycle scheduler in the current Vercel design.

These are external authorization and verification steps, not operations performed in ORDERS-2.18. No Production configuration or remote Cron was enabled.

## Rollback and worktree notes

- The new guards intentionally fail closed. If a local change must be reverted, review and revert only the ORDERS-2.18 hunks while preserving all pre-existing worktree changes; do not reset, clean, stash, or overwrite the repository.
- Do not work around the Cloudinary identity guard by reintroducing a self-attestation flag or using the previously identified cloud.
- The code, tests, and report are uncommitted. No deployment or remote side effect needs rollback.

# ORDERS-2.13 — Publication Lifecycle & Vercel Cron Resolution

**Review date:** 2026-11-12  
**Verdict: PASS — LOCAL LIFECYCLE AND CRON CONTRACT**

This verdict applies to the local lifecycle implementation and Vercel Cron handler contract only. It does **not** verify an installed Vercel Cron, Production or Preview deployment, provider credentials, or remote lifecycle execution.

## 1. Lifecycle behavior

### Expiry and public access

- `runPublicationLifecycle` selects `PUBLISHED` rows whose finite `expires_at` is at or before the run time, marks them `EXPIRED`, marks matching active entitlements expired, and sets `retention_delete_after_at`. Exact-boundary expiry is covered by local tests.
- Public publication reads check `status` and `expires_at` at request time. If an expired publication is still marked `PUBLISHED` because scheduled work has not run, the request marks it expired and returns HTTP 410. Later reads return unavailable/410 behavior.
- Public asset reads require `PUBLISHED` and `expires_at IS NULL OR expires_at > now`; expired original or derivative assets are not made public by delayed cleanup.
- Lifetime entitlements are excluded from expiry and retention erasure. Retention cleanup is also deferred while a Design has an active paid/fulfilling or unexpired awaiting-payment order.

**Result: VERIFIED PASS — local API/database tests.** Public access denial is not contingent on Cron having run.

### Cleanup and retries

- After the configured retention period (default 30 days; accepted range 1–3650), the runner claims eligible expired/revoked publication data, cleans published derivatives, then private source assets, archives the Design, erases snapshots/revisions and revokes previews.
- Per-asset cleanup failures are reported as retryable. The publication remains eligible for a later lifecycle run; deletion operations and database state updates are designed to tolerate retries. Local tests inject derivative and source deletion failures and verify eventual completion.
- An active order or another still-usable publication prevents premature Design archival/deletion.
- The lifecycle runner is bounded (default 50 rows; Vercel scheduled wrapper currently requests 10), so backlogs are drained over multiple invocations. The daily Vercel cadence is not a guarantee of immediate physical erasure; public access is denied independently at expiry.

**Result: VERIFIED PASS — local synthetic lifecycle tests.** Provider-side deletion success and actual schedule timing remain unverified remotely.

### Idempotency and overlapping invocations

- A persistent `scheduled_task_leases` row provides an exclusive five-minute lease for the lifecycle task.
- Each acquired run is recorded in `scheduled_task_runs` as `RUNNING`, then `COMPLETED` or `FAILED`. A competing invocation that cannot acquire the lease returns `{ acquired: false }` (HTTP 202 from the Vercel handler).
- Repeated lifecycle executions do not re-expire already expired rows or re-erase completed retention data. Cleanup failures remain retryable and later runs complete them.

**Result: VERIFIED PASS — local lease, repeated-run, and cleanup tests.**

## 2. Vercel Cron authority and route compatibility

| Item | Finding |
|---|---|
| Authoritative scheduler | Vercel Cron for the Vercel-centered Production deployment. |
| Exact route | `GET /api/cron/publication-lifecycle`. `api/cron/publication-lifecycle.ts` re-exports the existing catch-all API handler. |
| Configuration | `vercel.json` declares `{ "path": "/api/cron/publication-lifecycle", "schedule": "0 3 * * *" }` (daily at 03:00 UTC under Vercel Cron schedule semantics). |
| Authentication | `Authorization: Bearer <CRON_SECRET>`; missing/invalid credentials are rejected before database access. The secret must exist and be at least 32 characters. Vercel Cron is expected to send the configured secret as bearer authorization; this was not verified against a deployed project. |
| Environment checks | Handler accepts only `ENVIRONMENT=production` with `VERCEL_ENV=production`, or `ENVIRONMENT=staging` with `VERCEL_ENV=preview`. It rejects mismatched scope and cross-environment database/storage credentials. |
| Provider requirements | Vercel lifecycle requires `DATABASE_PROVIDER=turso` with environment-scoped Turso URL/token, plus correctly scoped Cloudinary configuration. Missing/invalid DB or storage configuration fails closed; no database lifecycle work occurs. |
| Route compatibility | Local tests invoke `createVercelApiHandler` at the Cron path and the Vercel catch-all adapter exposes that handler. `vercel.json` configures the API function with included migrations. This verifies repository routing/code contracts, not a deployed Vercel route. |
| Schedule conflict | Neither current `wrangler.jsonc` nor `wrangler.staging.jsonc` contains an automatic `triggers.crons` entry. There is no configured duplicate Cloudflare schedule in the inspected repository configuration. |
| Legacy Worker code | `src/index.ts` still contains a Cloudflare `scheduled()` implementation that performs fulfillment recovery and publication lifecycle work. It is not automatically scheduled by the current Wrangler configs. Do not remove or re-enable it as part of this review. |
| Preview limitation | Vercel Cron is Production-only. Preview has no automatic lifecycle runner in this architecture. The code can accept a correctly scoped Preview request for local/authorized invocation, but that does not make Vercel schedule Preview jobs. |

### Authority and future retirement

Vercel Production Cron is the sole configured automatic publication-lifecycle scheduler. The Cloudflare `scheduled()` handler is retained as legacy/rollback code, but has no active trigger in either Wrangler config. No scheduler configuration was silently enabled or removed in this task.

After an owner confirms successful Vercel Production operation and closes the rollback window, a separate reviewed change may retire the unused Cloudflare `scheduled()` implementation. If Cloudflare scheduled triggers are ever proposed again, first decide whether they are replacing Vercel Cron; do not activate both lifecycle schedulers without an explicit dual-run/lease and operational plan. The missing Preview scheduler requires an explicit future staging policy, not an implicit Production Cron workaround.

## 3. Authentication, configuration, and environment tests

Local test evidence includes:

- Missing and invalid bearer authentication return HTTP 401 without opening the database.
- A valid local synthetic secret authorizes the route.
- An absent/too-short secret cannot authorize a request.
- Missing database provider/URL returns a configuration error before database connection.
- Missing storage provider returns a configuration error before database connection.
- Production and Preview environment mismatch is rejected; Preview cannot use Production credentials.
- A valid synthetic Production configuration processes expired and active records, handles cleanup retries, and is idempotent on a repeated run.
- A valid synthetic Preview handler contract is covered, but no Preview Cron is installed or claimed.
- Public reads return HTTP 410 for expired publications, including when scheduled expiry processing has not yet run.

No secret values, cookies, credentials, or session data were printed, inspected from the user environment, or persisted. Synthetic secret literals used in tests are non-production fixtures.

## 4. Defects and source changes

**Confirmed lifecycle or Cron implementation defect: none found.** Expiry access control, retry behavior, idempotency, route authorization, environment scoping, and the Production route contract have local evidence. No runtime source, deployment configuration, or provider configuration was changed.

One test coverage gap was found: the existing Cron tests covered missing/invalid authorization headers but did not explicitly assert an authenticated request against an environment with no `CRON_SECRET`. Added a scheduler regression test that verifies fail-closed handling for missing Cron secret, database configuration, and storage configuration. This changes tests only; the lifecycle implementation remains unchanged.

## 5. Regression gates

Rerun against the current worktree on 2026-11-12:

| Command | Result | Evidence |
|---|---|---|
| `npm run typecheck` | PASS | `tsc --noEmit`; exit code 0. |
| `npm test` | PASS | 91 tests passed; 0 failed, cancelled, or skipped. |
| `npm run test:integration` | PASS | `Local integration: passed (D1 API and payment contracts, legacy regression, constraints, and batch rollback).` Uses isolated local synthetic D1 and generated webhook fixtures. |
| `npm audit --omit=dev` | PASS | `found 0 vulnerabilities`. |
| `node --experimental-strip-types --test tests/scheduler.test.ts tests/publications.test.ts tests/vercel.test.ts` | PASS | 16 tests passed; 0 failed. Includes Cron auth/config guards, route processing, exact expiry, cleanup retry, public denial, and idempotence. |
| `node --experimental-strip-types --test tests/security-headers.test.ts` | PASS | 4 tests passed; 0 failed. |
| `git diff --check` | PASS | Exit 0; no output. |

The test fixtures use in-memory SQLite, test adapters, or the integration harness's isolated local Wrangler D1. No test contacted a real provider or remote database.

## 6. Remaining external verification

These are **NOT TESTED** or **BLOCKED BY EXTERNAL PROVIDER**, not local implementation failures:

- Vercel project linkage, Production environment selection, build output/function routing, and the first actual Cron invocation.
- Presence and correct Production scope of `CRON_SECRET`, Turso URL/token, Cloudinary credentials, `DATABASE_PROVIDER`, `STORAGE_PROVIDER`, and retention configuration. Secret values must remain undisclosed.
- Production Turso schema/migration state and runtime connectivity.
- Cloudinary's real authenticated asset deletion, derivative cleanup, provider-side retry semantics, retention, and account separation.
- Preview/staging automatic expiry and cleanup; Vercel Cron does not schedule Preview and no alternative is configured.
- The actual runtime cadence/backlog behavior under production load. Daily execution and bounded batches can delay physical cleanup; public requests still deny expired content.
- A deployed Cron's behavior on transient failure and whether the platform retries it. The next configured schedule is the local design's expected retry opportunity; platform retry behavior was not verified.
- Any production payment/fulfillment recovery. Vercel's lifecycle route performs publication lifecycle work, not the legacy Cloudflare handler's pending-fulfillment recovery.

## 7. Authorized Production configuration steps (not performed)

Only an authorized project owner/release operator may perform these steps, in the approved release process:

1. Confirm the Vercel Production project and route deployment are the intended Crushify project and target.
2. Verify required variable **names and presence** in the correct Vercel environment without copying values into chat, repository files, or logs. Confirm `ENVIRONMENT=production`, `DATABASE_PROVIDER=turso`, Production Turso credentials, `STORAGE_PROVIDER=cloudinary`, Production Cloudinary credentials, valid retention policy if overridden, and a strong `CRON_SECRET` of at least 32 characters.
3. Confirm Turso and Cloudinary resources are Production-owned, correctly scoped, and not shared with Preview; verify migration state through the authorized release procedure.
4. Confirm the `0 3 * * *` Cron schedule is attached to the Production deployment and observe its first authorized execution/result without exposing the bearer secret.
5. Monitor expiry counts, retryable cleanup counts, failed task rows, provider errors, and retention deletion outcomes. Establish an operational alert/runbook for repeated failures and cleanup backlog.
6. Separately decide whether Preview needs manual lifecycle execution or an approved non-production scheduler. Do not activate a second scheduler or touch Production while making that decision.
7. Retire legacy Cloudflare scheduler code only after Production Cron operation and rollback policy are explicitly accepted. No Cloudflare trigger should be enabled in parallel by default.

These are instructions for a later authorized release operation, not permission to access or change Production.

## 8. Final worktree and cleanup

- Branch: `main`
- HEAD: `5205f730fd0141fb9c8d0697787b700e4bda04ff`
- Existing modifications and untracked files were preserved.
- Task changes: test-only assertions in `tests/scheduler.test.ts` and this report.
- No source/runtime/config change, remote operation, deployment, commit, push, or merge.
- Integration port 8787 was no longer listening after the test; the pre-existing local service on port 8799 remained untouched.
- The integration fixture's isolated D1 directory was absent after the run. No additional fixture or test data was left behind.
- `session.json` was not accessed.

Final `git status --short --untracked-files=all`:

```text
 M _headers
 M docs/HOSTING_MIGRATION.md
 M docs/PAYMENT_FLOW.md
 M docs/PRODUCT_ARCHITECTURE.md
 M docs/PUBLICATION_AND_DELIVERY.md
 M docs/STAGING_DEPLOYMENT.md
 M docs/VERCEL_STAGING.md
 M shared/customer-editor.js
 M src/platform/vercel.ts
 M templates/distance-means-nothing/index.html
 M templates/love-letter/index.html
 M templates/our-memories/index.html
 M templates/our-memories/our-memories.js
 M templates/our-universe/index.html
 M templates/say-yes/index.html
 M templates/say-yes/say-yes.css
 M templates/say-yes/say-yes.js
 M tests/browser-love-letter.mjs
 M tests/integration.mjs
 M tests/payment-contract.mjs
 M tests/publications.test.ts
 M tests/scheduler.test.ts
 M tests/template-registry.test.ts
 M vercel.json
 M wrangler.jsonc
 M wrangler.staging.jsonc
?? docs/qa/ORDERS-2.11C-FIVE-TEMPLATE-CHECKOUT.md
?? docs/qa/ORDERS-2.12-CONSOLIDATED-RELEASE-REVIEW.md
?? docs/qa/ORDERS-2.13-LIFECYCLE-CRON-RESOLUTION.md
?? docs/qa/ORDERS-2.3-2.6-FINAL-QA-REPORT.md
?? tests/orders-2-10-browser-fixture.mjs
```

## 9. Verdict

# PASS — LOCAL LIFECYCLE AND CRON CONTRACT

The local lifecycle and Vercel Cron handler contract pass, including fail-closed authentication/configuration, expiry access denial, cleanup retries, repeated execution, and Production/Preview scope guards. This is not a claim that deployed Vercel Cron has run or that Production/Preview providers are configured. Those external checks remain outstanding.

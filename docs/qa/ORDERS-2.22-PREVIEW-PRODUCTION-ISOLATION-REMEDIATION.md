# ORDERS-2.22 — Preview / Production Environment Isolation Remediation

## Verdict

**PASS — LOCAL ENVIRONMENT ISOLATION CONTRACT**

Local code and synthetic tests confirm that Vercel Preview requires an explicitly
paired staging marker and its current deployment URL, with no Production-origin
fallback. Unknown Vercel and Worker environments fail closed. Legacy Worker
staging execution is disabled because its runtime cannot verify D1/R2 resource
identity; the approved staging execution path remains Vercel Preview.

This verdict is limited to the checked-in local contract. It does not verify
deployed Vercel variables, remote resource identities, or Production behavior.

## 1. Git baseline and preservation

Initial state, captured before editing:

| Item | State |
|---|---|
| Branch | `main` |
| HEAD | `a81d5788069751ed10a52a980add3b4f3c291f39` |
| Staged changes | None |
| Modified tracked files | None |
| Tracked file count | 138 |
| Untracked files | Three pre-existing QA reports: ORDERS-2.19, ORDERS-2.20, and ORDERS-2.21 |

All three pre-existing reports were preserved. No reset, checkout, clean, stash,
or other destructive Git operation was performed.

## 2. Baseline implementation and risks

- Vercel classification could fall through to `local` for unknown markers.
  Preview origin resolution preferred `APP_ORIGIN`, then
  `VERCEL_PROJECT_PRODUCTION_URL`, then `VERCEL_URL`; it did not bind the
  Preview origin to the current deployment.
- The Vercel API adapter created requests on an internal sentinel origin,
  while publication URLs and dashboard public URLs could be built from the
  request URL rather than the validated application origin.
- Vercel local development could accept remote Turso credentials and
  Production Cloudinary configuration.
- The legacy Worker API had no environment gate. Its scheduled handler checked
  D1 selection but not an explicit deployment scope. Missing `ENVIRONMENT`
  could satisfy local-only authentication/publication checks.
- The checked-in default Wrangler configuration has no explicit environment
  marker; the staging configuration is a legacy Worker configuration. No
  remote deployment or binding identity was inspected.

## 3. Remediation

### Environment classification and origin resolution

- Added shared classification and origin validation in
  [`src/platform/environment.ts`](../../src/platform/environment.ts).
- Vercel `VERCEL_ENV=development` is the trusted local signal; a missing
  `VERCEL_ENV` or an unknown value is not local. Preview requires
  `ENVIRONMENT=staging`. Production accepts only the trusted Production marker
  with an absent or matching `ENVIRONMENT`; conflicting markers fail closed.
- Preview requires a syntactically valid `VERCEL_URL`. It does not use
  `VERCEL_PROJECT_PRODUCTION_URL`. A configured `APP_ORIGIN` must equal the
  current Preview deployment origin; malformed, Production-identical, or
  ambiguous values fail closed.
- Production retains the existing `APP_ORIGIN` and
  `VERCEL_PROJECT_PRODUCTION_URL` resolution and mismatch protection.
  Local origins are limited to explicit local configuration or a validated
  loopback request origin.
- URL validation rejects malformed hosts, credentials, paths, query strings,
  fragments, and unsafe schemes. Local Vercel database access requires a
  file-backed database; local runtime rejects remote mail/storage credentials
  and Production Cloudinary selection.
- The Vercel Node adapter now builds its request URL from the validated
  deployment origin. Magic-link callback construction and publication/public
  dashboard links use the validated application origin.

### Legacy Cloudflare Worker

- Worker requests now require an explicit supported environment and a
  validated origin. Missing/unknown markers fail closed; local requests require
  `ENVIRONMENT=local` and a loopback URL. Local-only flags cannot activate
  local behavior on a Production Worker.
- Worker staging API/public requests are rejected before database or storage
  initialization. Staging lifecycle work must use the Vercel Preview path;
  Worker staging remains disabled until its resource identity can be verified.
- The Worker scheduled handler requires explicit Production scope and rejects
  local, staging, unknown, or mixed test/staging configuration. No Cron trigger
  was added.
- `npm run dev` now invokes Wrangler with `--local --var ENVIRONMENT:local`,
  retaining explicit local Worker development without changing remote
  environment settings.
- Local test mode and publication/authentication gates no longer treat a
  missing `ENVIRONMENT` as local.

### Files changed

| File | Change |
|---|---|
| [`src/platform/environment.ts`](../../src/platform/environment.ts) | Shared environment classification and origin validation |
| [`src/platform/vercel.ts`](../../src/platform/vercel.ts) | Fail-closed Vercel scope/origin checks and local resource restrictions |
| [`api/[...path].ts`](../../api/%5B...path%5D.ts) | Construct request URLs from validated origins |
| [`src/index.ts`](../../src/index.ts) | Guard Worker requests and scheduled execution |
| [`src/auth.ts`](../../src/auth.ts) | Require explicit local auth mode and validated callback origins |
| [`src/publications.ts`](../../src/publications.ts) | Build publication links from the validated application origin |
| [`package.json`](../../package.json) | Make Worker dev execution explicitly local |
| [`tests/environment-isolation.test.ts`](../../tests/environment-isolation.test.ts) | Add synthetic Vercel origin/scope and publication URL regressions |
| [`tests/worker.test.ts`](../../tests/worker.test.ts) | Cover missing/unknown/local/Production/Worker staging/scheduler behavior |
| [`tests/vercel.test.ts`](../../tests/vercel.test.ts) | Update Preview URL and local-only fixtures |
| [`tests/pre-staging-security.test.ts`](../../tests/pre-staging-security.test.ts) | Add current Preview URL to safe fixtures |
| [`tests/scheduler.test.ts`](../../tests/scheduler.test.ts) | Add explicit deployment URLs to synthetic fixtures |
| [`docs/VERCEL_STAGING.md`](../VERCEL_STAGING.md) | Document the origin contract and disabled Worker staging path |

No payment behavior, database provisioning/migrations, Cloudinary staging
configuration, Preview authentication, lifecycle-trigger implementation,
Cron configuration, or Production deployment configuration was changed.

## 4. Verification

| Check | Result |
|---|---|
| `npm run typecheck` | PASS — exit code 0 |
| Focused environment, Worker, Vercel, scheduler, publication, and pre-staging tests | PASS — 49 tests, 0 failures across 11 suites |
| `node_modules\\.bin\\wrangler.cmd dev --local --var ENVIRONMENT:local --help` | PASS — Wrangler accepted the local-mode flags; no server was started |
| `git diff --check` | PASS |

The focused tests use synthetic environment objects and local/in-memory or
temporary database fixtures. No provider request was made.

Not run:

- `npm test` full suite and `npm run test:integration`: the focused runtime and
  publication suites cover this change; broader suites were not needed for this
  isolation contract.
- `npm audit --omit=dev`: no dependency manifest or dependency version changed.
- Remote/deployed verification: explicitly prohibited for this task.

## 5. Remaining risks and required verification

- Actual Vercel Preview and Production environment assignments, current Preview
  URL, and deployment behavior were not inspected. The local code requires the
  Vercel-provided Preview URL, but no deployed request was made.
- Turso and Cloudinary account/resource ownership, credentials, and separation
  remain unverified. Local origin tests do not prove remote database or storage
  identity.
- The default Wrangler configuration still has no environment marker. A legacy
  Worker using it now fails closed; any continued Production Worker use needs
  separately authorized explicit scope and binding verification. Worker
  staging is intentionally unavailable under the approved Vercel Preview
  architecture.
- Production behavior was checked only with synthetic local tests. No
  Production configuration or resource was accessed or changed.
- Preview authentication remains disabled, staging payments remain unchanged,
  and no Preview scheduler or manual lifecycle mechanism was implemented.

Before ORDERS-2.23 relies on a deployed Preview, an authorized owner must verify
the Preview environment assignment and deployment URL, separately scoped
staging database/storage identities, and whether any legacy Worker deployment
is still relied upon. ORDERS-2.23 was not started.

## 6. Final Git and safety state

- Branch: `main`
- HEAD: `a81d5788069751ed10a52a980add3b4f3c291f39` (unchanged)
- No staged changes.
- Modified tracked files (11):
  `api/[...path].ts`, `docs/VERCEL_STAGING.md`, `package.json`,
  `src/auth.ts`, `src/index.ts`, `src/platform/vercel.ts`,
  `src/publications.ts`, `tests/pre-staging-security.test.ts`,
  `tests/scheduler.test.ts`, `tests/vercel.test.ts`, and
  `tests/worker.test.ts`.
- Untracked files (6):
  `docs/qa/ORDERS-2.19-STAGING-INFRASTRUCTURE-READINESS.md`,
  `docs/qa/ORDERS-2.20-STAGING-BLOCKER-RESOLUTION-PLAN.md`,
  `docs/qa/ORDERS-2.21-INDEPENDENT-STAGING-ARCHITECTURE-REVIEW.md`,
  this ORDERS-2.22 report, `src/platform/environment.ts`, and
  `tests/environment-isolation.test.ts`.
- The first three untracked QA reports were present at baseline and remain
  unchanged. The two new source/test files and this report are ORDERS-2.22
  additions.

No secrets were read or printed. No remote provider, database, Production
resource, email, payment, deployment, migration, or Cron operation was
performed. No commit, push, merge, or Production change was made.

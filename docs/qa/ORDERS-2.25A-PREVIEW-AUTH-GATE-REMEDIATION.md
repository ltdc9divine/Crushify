# ORDERS-2.25A — Preview Authentication Gate Remediation

## Result

**PASS — PREVIEW AUTH GATE (LOCAL CONTRACT)**

Local synthetic tests show that Preview/staging and unknown environments
cannot create, consume, accept, or refresh customer authentication state.
Production and local authentication flows remain functional in synthetic tests.
No deployed Preview or Production authentication request was made.

## 1. Original finding and root cause

The earlier ORDERS-2.25 inspection found that the session endpoints were
dispatched without an environment gate:

- `POST /api/v1/customers/session` could rate-limit, create a customer, create
  a login token, and invoke the configured email service.
- `POST /api/v1/customers/session/verify` could consume a login token, create
  a customer session, and set session/CSRF cookies.
- `getSession()` could hash a presented cookie, look up a session in the
  selected database, and update `last_used_at`.

The root cause was the lack of a shared authentication environment policy in
[`src/auth.ts`](../../src/auth.ts). Preview email being discard-only did not
prevent token or session creation.

## 2. Central guard and runtime trust

`src/auth.ts` now has one environment policy: authentication is enabled only
when the already-normalized `Env.ENVIRONMENT` is `local` or `production`.
All other values, including `staging`, missing, and unknown values, fail
closed with HTTP `503`, code `AUTH_UNAVAILABLE`, and the generic message
“Authentication is unavailable in this environment”.

Vercel's existing trusted classifier maps `VERCEL_ENV=preview` plus
`ENVIRONMENT=staging` to the normalized staging runtime before constructing
the application `Env`. The Worker validates its explicit environment before
dispatch; Worker staging remains blocked before API initialization. The auth
guard does not inspect request headers, query parameters, cookies, or body
fields to identify the environment.

## 3. Protected paths and behavior

| Path/function | Preview / staging | Local and Production |
|---|---|---|
| `POST /api/v1/customers/session` | Rejected before body parsing, DB access, rate limiting, customer/login-token writes, token generation, or email service invocation | Existing flow preserved |
| `POST /api/v1/customers/session/verify` | Rejected before body parsing, token lookup/consumption, session creation, or cookie setting | Existing flow preserved |
| `GET /api/v1/customers/me` | Rejected with `AUTH_UNAVAILABLE` before session lookup | Existing authenticated response preserved |
| `getSession()` | Returns `null` before cookie hashing or database reads/updates, even when a matching row exists | Existing validation and `last_used_at` behavior preserved |
| `requireSession()` and other protected handlers | Fails closed before session/database access | Existing authorization behavior preserved |
| `DELETE /api/v1/customers/session` | Safe logout: expires session and CSRF browser cookies only; does not look up, update, or delete session records | Existing authenticated, CSRF-protected session revocation preserved |

`requireSession()` is shared by design, asset, payment/order, and publication
handlers, so those protected operations cannot accept a Preview cookie either.
Public non-authentication routes are not covered by the gate.

## 4. Authentication entry points discovered

- Customer login and implicit registration share `POST
  /api/v1/customers/session`; there is no separate signup/registration route.
- Magic-link consumption is `POST /api/v1/customers/session/verify`.
- Session profile/read is `GET /api/v1/customers/me`.
- Logout is `DELETE /api/v1/customers/session`.
- No session renewal/refresh, password reset/recovery, OAuth, or admin
  authentication route is implemented in the inspected application.
- Template sign-in UI in Our Universe and the shared customer editor calls
  these same guarded API paths; it has no separate authentication backend.
  Preview's API errors are not success-shaped login responses.
- Legacy Worker staging is rejected by its existing runtime boundary before
  `handleApiRequest`; the central auth guard also protects direct staging
  invocation and unknown runtimes.

## 5. Environment policy matrix

| Runtime | Authentication policy |
|---|---|
| Vercel Production | Enabled; existing email/session behavior preserved |
| Vercel Preview (`staging`) | Disabled; all authentication/session acceptance is rejected |
| Local development (`local`) | Existing local test/email-sink authentication remains enabled |
| Unknown, missing, or ambiguous | Fail closed with `AUTH_UNAVAILABLE` |
| Legacy Worker staging | Existing Worker-level staging block remains in force |

## 6. Tests and side-effect evidence

| Check | Result |
|---|---|
| Focused auth/runtime/publication tests | PASS — 52 tests, 0 failures |
| `npm run typecheck` | PASS |
| `npm test` | PASS — 134 tests, 27 suites, 0 failures |
| `git diff --check` | PASS |

The new [`auth-environment.test.ts`](../../tests/auth-environment.test.ts)
contains five focused cases. Preview/unknown tests use only synthetic values
and mocked dependencies. Spies/assertions verify:

- zero database statements or batches;
- zero `crypto.getRandomValues` token-generation calls;
- zero mocked mail-provider/local sink calls and no Preview discard-email
  invocation;
- no `Set-Cookie` on rejected login, verification, or profile requests;
- a matching synthetic session row is never queried or refreshed in Preview;
- spoofed environment headers/body fields do not change the result;
- Preview logout only expires browser cookies and performs no database work;
- a public read-only health endpoint remains available.

The Production and local compatibility test executes the full synthetic
magic-link request, verification, session-cookie creation, and authenticated
profile read against an in-memory fake database. Production uses a mocked
Worker mail binding; local uses a callback sink. No actual email or provider
request is made. The complete suite also includes publication read/lifecycle,
Vercel and Worker runtime, and existing local auth contract tests.

An initial focused run found one pre-existing Worker test expecting `401` for
an unclassified environment. Because unknown authentication scopes now
intentionally fail closed with `503`, its expected status was updated; the
focused suite and full suite then passed.

## 7. Files changed by ORDERS-2.25A

| File | Change |
|---|---|
| [`src/auth.ts`](../../src/auth.ts) | Adds the shared auth gate, blocks Preview/unknown session acceptance, and permits cookie-only logout cleanup |
| [`tests/auth-environment.test.ts`](../../tests/auth-environment.test.ts) | Adds synthetic side-effect, stale-cookie, logout, public-route, local, and Production tests |
| [`tests/worker.test.ts`](../../tests/worker.test.ts) | Updates the unknown-environment auth status expectation |
| [`docs/VERCEL_STAGING.md`](../../docs/VERCEL_STAGING.md) | Documents the Preview auth boundary and local verification command |
| [`docs/SECURITY_PLAN.md`](../../docs/SECURITY_PLAN.md) | Records the deployed-runtime policy contract |
| [`docs/qa/ORDERS-2.25A-PREVIEW-AUTH-GATE-REMEDIATION.md`](ORDERS-2.25A-PREVIEW-AUTH-GATE-REMEDIATION.md) | Adds this report |

Other modified/untracked work was present before ORDERS-2.25A and was
preserved. The Worker test file already contained unrelated staging-storage
tests; only the directly coupled expected status was changed.

## 8. Remaining unverified behavior and safety

- No real Vercel Preview or Production deployment was contacted; deployed
  environment assignments and hosted routing remain unverified.
- No remote Turso, Cloudinary, SePay, email, OAuth, Vercel API, or Production
  resource was accessed.
- No real email, external authentication, session, migration, or deployment
  was performed. Tests create only synthetic in-memory session state.
- No integration runner was executed. `package.json` identifies it as a
  separate Wrangler local-D1 process; the required full unit suite and focused
  runtime tests passed without starting that runner.
- The legacy Worker staging path remains unavailable by design.

## 9. Git baseline and final inventory

| Item | Initial | Final |
|---|---|---|
| Branch | `main` | `main` |
| HEAD | `84acc4c19a143805830495671e076bbc395db3e3` | `84acc4c19a143805830495671e076bbc395db3e3` |
| `origin/main` | `84acc4c19a143805830495671e076bbc395db3e3` | `84acc4c19a143805830495671e076bbc395db3e3` |
| Staged paths | None | None |
| Modified tracked paths | 16 pre-existing | 18 |
| Untracked paths | Two pre-existing QA reports | Four |
| `git diff --check` | PASS | PASS |

Final modified tracked paths:

- `.env.example`
- `README.md`
- `docs/API_SPECIFICATION.md`
- `docs/DATABASE_SCHEMA.md`
- `docs/HOSTING_MIGRATION.md`
- `docs/SECURITY_PLAN.md`
- `docs/VERCEL_STAGING.md`
- `scripts/staging-config.ts`
- `scripts/staging-turso.ts`
- `src/auth.ts`
- `src/platform/vercel.ts`
- `src/storage/cloudinary-policy.ts`
- `tests/database-contract.test.ts`
- `tests/pre-staging-security.test.ts`
- `tests/staging-config.test.ts`
- `tests/storage.test.ts`
- `tests/vercel.test.ts`
- `tests/worker.test.ts`

Final untracked paths:

- `docs/qa/ORDERS-2.23-TURSO-STAGING-DATABASE-ISOLATION.md`
- `docs/qa/ORDERS-2.24-CLOUDINARY-STAGING-ISOLATION.md`
- `docs/qa/ORDERS-2.25A-PREVIEW-AUTH-GATE-REMEDIATION.md`
- `tests/auth-environment.test.ts`

No pre-existing file was reset, checked out, cleaned, stashed, or overwritten.

# Crushify staging environment

## Environment separation

- **Vercel Preview** is the intended staging deployment scope. Configure it with `ENVIRONMENT=staging` and staging-prefixed credentials only. The runtime requires the current deployment's `VERCEL_URL`; it never falls back to `VERCEL_PROJECT_PRODUCTION_URL`. If `APP_ORIGIN` is set, it must exactly match that Preview deployment origin. Do not attach staging to the production domain.
- **Vercel Production** is reserved for production application configuration. Never use its environment pull, database URL/token, or storage credentials for staging operations. Production must not contain `TURSO_STAGING_TARGET`, `TURSO_CONFIRM_DATABASE`, `TURSO_CONFIRM_GROUP`, `TURSO_CONFIRM_REGION`, `TURSO_SMOKE_TEST`, or `CLOUDINARY_SMOKE_TEST`.
- Preview must explicitly set `ENVIRONMENT=staging`; its database runtime uses only `TURSO_STAGING_DATABASE_URL` and `TURSO_STAGING_AUTH_TOKEN`. It does not fall back to `TURSO_DATABASE_URL` or `TURSO_AUTH_TOKEN`. Production continues to use only the generic Turso variables and rejects a database hostname matching the staging database.
- Vercel runtime classification fails closed for missing or unknown `VERCEL_ENV` values and mismatched `ENVIRONMENT` markers. Production keeps its existing `APP_ORIGIN` / `VERCEL_PROJECT_PRODUCTION_URL` resolution, with malformed or conflicting origins rejected. Local Vercel development requires the trusted `VERCEL_ENV=development` signal; local database connections must use a file database.
- Both normal API requests and protected lifecycle handlers reject cross-scope database or Cloudinary credentials. Vercel Cron runs only against the Production deployment; no Preview lifecycle scheduler is configured.
- Cloudinary is disabled for all staging runtimes, including Vercel Preview and the legacy Cloudflare Worker, and is also disabled for local development. Cloud-name comparisons, variable names containing `STAGING`, and self-asserted flags cannot establish separate account ownership. Vercel Preview has no storage provider until a separate durable staging provider is approved and configured; `STORAGE_PROVIDER=mock` is not instantiated there. There is no automatic fallback from a rejected Cloudinary configuration. The legacy Worker rejects staging requests and staging scheduled execution because its runtime cannot verify D1/R2 resource identity. The guarded Cloudinary smoke script refuses staging before adapter construction.
- Local migration scripts use `TURSO_STAGING_*` from a separate file stored outside this repository. The Cloudinary smoke script is intentionally blocked for staging. Local application tests use `STORAGE_PROVIDER=mock` with in-memory storage and do not require Cloudinary credentials. Mock storage is for local/test use only. Preview uploads and other operations requiring durable media fail with `STORAGE_UNAVAILABLE`, and public media reads return not-found until an approved durable provider exists. The `npm run dev` Worker script explicitly sets `ENVIRONMENT=local` and uses Wrangler local bindings; Worker local requests are accepted only on loopback origins.
- Local staging migration commands require `CRUSHIFY_STAGING_PROFILE=local`, `ENVIRONMENT=staging`, staging-specific Turso credentials, and exact database/group/region/hostname confirmations. They reject Production credentials and conflicting Vercel deployment scopes. Migrations additionally require `TURSO_MIGRATE_CONFIRM=I_CONFIRM_APPLY_STAGING_MIGRATIONS`; smoke tests require explicit synthetic-data opt-in.
- The Vercel Cron in `vercel.json` targets the Production deployment. `GET /api/cron/publication-lifecycle` accepts only the matching Production runtime and remains bearer-token protected. Preview has no automatic lifecycle schedule.
- A separate `POST /api/ops/staging/publication-lifecycle` is authorized only when trusted runtime classification is exactly Vercel Preview/staging. It requires a bearer `STAGING_LIFECYCLE_SECRET` consisting of exactly 64 hexadecimal characters; `CRON_SECRET` alone is never accepted. The handler validates the dedicated staging database configuration and then returns `STORAGE_UNAVAILABLE` before database access while Preview has no approved durable storage provider. It accepts no body or query parameters. No Preview lifecycle mutation is performed until durable media storage is approved and configured. The removed generic `/api/ops/staging` mutation route remains unavailable.
- Generate `STAGING_LIFECYCLE_SECRET` independently from Production secrets (for example, a cryptographically random 32-byte value encoded as hex) and configure it only in Vercel's Preview environment. Do not copy Production `CRON_SECRET` or reuse its value. Its current presence and deployed route behavior have not been verified. Local synthetic tests exercise authentication, scope rejection, expiry, retry, and cleanup; no deployed lifecycle operation was run.

### Preview authentication gate

- Production authentication remains enabled, and explicitly local Vercel development keeps its existing synthetic/local email flow. Vercel Preview maps through the trusted runtime classifier to `ENVIRONMENT=staging`; the authentication code does not infer deployment scope from request headers, query strings, cookies, or body fields.
- Preview and unknown/ambiguous environments reject customer authentication with HTTP `503` and `AUTH_UNAVAILABLE` before reading the request body, accessing the database, generating login/session tokens, or invoking an email service. This covers `POST /api/v1/customers/session`, `POST /api/v1/customers/session/verify`, `GET /api/v1/customers/me`, and every protected route that calls `requireSession`.
- Preview `getSession()` returns unauthenticated before hashing or querying a presented cookie. A Production session cookie cannot authenticate against Preview, even if a matching row exists in the selected database. No session records are removed.
- `DELETE /api/v1/customers/session` remains available in Preview only to clear the browser's session and CSRF cookies; it does not read or revoke a server-side session. Local and Production retain the existing authenticated/CSRF-protected revocation behavior.
- No separate signup, password recovery, OAuth, session renewal, or admin-authentication implementation is present. The customer editor and Our Universe sign-in UI call the same guarded routes; Preview responses are explicit errors, not login-success responses. Public templates, publication reads, and non-authentication APIs are not disabled by the authentication guard.
- Verify locally with `node --experimental-strip-types --test tests/auth-environment.test.ts`. These synthetic tests cover blocked Preview/unknown requests, zero database/random-token/email side effects, stale-cookie rejection, safe logout cleanup, a public read-only health route, and working synthetic local/Production magic-link flows. No deployed Preview behavior has been tested; keep real email/OAuth credentials out of Preview.

### Payment isolation

- The payment policy uses the trusted runtime classification: Production retains the SePay provider identity, Vercel Preview/staging selects `MOCK`, explicit local test mode retains its existing `mock` / `sepay-test` behavior, and unknown runtimes have no provider.
- Do not configure `PAYMENT_MODE` or any `SEPAY_*` variable in Preview. Runtime selects mock mode in code and never forwards SePay configuration. The Preview order route is blocked by the disabled-auth guard before payment-table reads or writes; it returns `AUTH_UNAVAILABLE`.
- Preview's SePay webhook returns `MOCK_SETTLEMENT_UNAVAILABLE` before reading the body, verifying a signature, or accessing payment tables. SePay webhook recovery and all staging fulfillment/recovery are disabled. No Preview mock-confirmation route exists, so Preview cannot settle or publish a mock order. Do not re-enable customer authentication or reuse SePay's webhook for mock confirmation.
- A future staging settlement needs a separately approved operator-only capability, isolated to the Preview database, and must use only a distinct `MOCK` payment state. No such capability or route is currently implemented.
- Important compatibility finding: this repository currently disables Production checkout and SePay webhook processing; only local `mock` / `sepay-test` modes are enabled. The Production policy still identifies SePay, but this is not a live payment integration. Do not infer that Production checkout is available or enable it as part of staging changes.
- Local mock continues to support synthetic signed-webhook integration tests; local settings and this behavior are not passed into Preview. No payment provider account, network call, or transaction was used for local validation.

## Configuration inventory (read-only audit)

Only variable names and presence were inspected; no Vercel values were displayed, pulled, or reused.

| Service | Required configuration | Current status | Action |
|---|---|---|---|
| Vercel | Linked `crushify` project, Preview environment, protected deployments | Read-only `vercel env ls preview` reported no environment variables. SSO protection reports `all_except_custom_domains`; Git-fork protection is enabled. | Keep protections enabled. Production branch was not exposed by the read-only CLI output and remains unverified. |
| Turso | `DATABASE_PROVIDER`, `TURSO_STAGING_DATABASE_URL`, `TURSO_STAGING_AUTH_TOKEN` in Preview; dedicated DB and database-scoped token | Turso CLI is not installed. Account/database status is **UNKNOWN**. The owner-identified `crushify-staging` candidate is not confirmed or compared with Production. Preview has no variables configured. | In the owner dashboard, verify the free plan, organization, exact database identity/location, and that it is separate from Production. Do not create a duplicate; never reuse an exposed token. |
| Storage | Production uses only `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` when Cloudinary is selected. Preview has no approved durable storage provider; `STORAGE_PROVIDER=mock` is not instantiated. | Preview media operations fail closed; no Preview storage provider is configured or verified. Cloudinary calls were not made. | Keep Preview storage unavailable until a separate durable staging provider is approved and configured. Do not use Production credentials. |
| Application | `ENVIRONMENT=staging`, Vercel `VERCEL_URL`; optional matching `APP_ORIGIN` | Preview has no environment variables configured. | Configure the explicit staging marker and keep `APP_ORIGIN` absent or equal to the current Preview deployment URL. |
| Email/magic links | `PREVIEW_EMAIL_SINK=discard` (optional; no provider credentials) | Preview has no outbound email configuration. The discard sink cannot deliver interactive sign-in links. | Keep real mail credentials out of Preview. Use the discard sink only for safe API contract checks; interactive Preview sign-in requires a separately approved test-only delivery design. |
| Payment | Preview selects mock only; no live provider | `PAYMENT_MODE` and audited `SEPAY_*` names are absent in Preview and Production. Preview customer authentication is disabled, so order creation and settlement remain unavailable. | Keep payment variables absent; do not configure real SePay credentials or enable a mock-confirmation route without a separate reviewed operator-auth design. |
| Lifecycle operator | `CRON_SECRET` for Production Cron; independently generated `STAGING_LIFECYCLE_SECRET` for the Preview-only manual route | The repository declares one daily Production Cron and one Preview-only manual route. Deployment, Preview secret presence, and invocation were not verified. Preview has no scheduled invocation. | Configure the 64-hex-character staging secret only in Vercel Preview through the approved owner workflow. Do not copy or reuse Production secrets or call a deployed lifecycle route during local QA. |

The historical read-only Preview listing reported no environment variables; it was not repeated for ORDERS-2.9, ORDERS-2.27, or ORDERS-2.28. A database-backed Preview requires `ENVIRONMENT=staging`, `DATABASE_PROVIDER=turso`, `TURSO_STAGING_DATABASE_URL`, and `TURSO_STAGING_AUTH_TOKEN`. Do not configure `STORAGE_PROVIDER=mock` in Preview; the adapter deliberately does not instantiate it. Durable media operations and the manual lifecycle operation remain unavailable until a separate staging storage provider is approved and configured. `STAGING_LIFECYCLE_SECRET` must be configured independently in Preview only if/when that operation is approved; it does not enable storage or a Preview scheduler. Cloudinary staging variables are intentionally not enabled. `MAIL_PROVIDER`, `MAIL_API_KEY`, and `MAIL_FROM_EMAIL` must remain absent. `PREVIEW_EMAIL_SINK=discard` suppresses outbound mail but cannot deliver interactive sign-in links. Payment variables are intentionally absent.

Vercel CLI access is authenticated. The project lists `https://crushify-one.vercel.app` as its Production alias; it currently resolves to `https://crushify-1mswrm351-ltdc9divine-5816s-projects.vercel.app`. The inspected deployment metadata did not expose a source commit SHA. Project metadata did not expose the Production branch. Deployment protection was inspected without accessing or bypassing protected routes.

The historical local `.env.local` inspection found a non-empty `VERCEL_OIDC_TOKEN` assignment; its value and validity were not inspected or rechecked during ORDERS-2.9. No `.dev.vars` file was present when the ORDERS-2.9 integration gate was attempted. Treat any OIDC value as sensitive; do not paste it into chat or use it as a staging API credential.

### Cloudinary Preview gate (currently disabled)

The approved future architecture calls for a dedicated staging Cloudinary
account, but this repository has no independent way to verify a configured
account's owner or account identity. Preview Cloudinary therefore remains
disabled even if an operator supplies staging-named variables. Do not configure
Cloudinary credentials in Preview now. Preview also does not instantiate
`STORAGE_PROVIDER=mock`; mock storage is restricted to local/test use. No
durable Preview media provider is currently approved or configured.

The following is a **planning-only placeholder**, not an enablement procedure.
It must not be added to Vercel until a later security-reviewed code change
establishes a safe identity contract:

```dotenv
ENVIRONMENT=staging
STORAGE_PROVIDER=cloudinary
CLOUDINARY_STAGING_CLOUD_NAME=<owner-verified-staging-cloud-name>
CLOUDINARY_STAGING_API_KEY=<credential-issued-by-staging-account>
CLOUDINARY_STAGING_API_SECRET=<credential-issued-by-staging-account>
```

`VERCEL_ENV=preview` is supplied by Vercel and must not be simulated by a
local confirmation variable. The placeholders do not prove account isolation
and the current code rejects this configuration before storage is initialized.
A distinct Cloud Name is not proof: Cloud Names identify cloud instances, not
the legal/account ownership boundary. A variable named `CLOUDINARY_STAGING_*`
is likewise only a label.

Before any later enablement, the account owner must verify the separate account
directly in the Cloudinary account console, confirm its owner/account identity
is distinct from Production, and confirm the credentials were issued only
within that account. A security reviewer must independently review the
evidence and the credential scope. Record only non-secret verification
evidence in the approved owner-controlled record; never copy credentials or
signatures into this repository. Then make a separate code change with
negative tests for Production/local/mismatched identity and mocked upload,
delete, delivery, and derivative operations. Do not remove the staging guard
or rely on a boolean/string environment attestation alone.

### Credential rotation and least privilege

- Previously shared Turso tokens are compromised and must not be reused. An authorized owner should rotate/revoke affected tokens only after determining what active environment still depends on them.
- Only after account/plan and database existence are verified, consider a dedicated `crushify-staging` database if it does not already exist and the account remains free. It must have its own **database-scoped auth token**, separate from Production. Do not use a Turso Platform API token.
- Do not create or use Cloudinary credentials for staging while only the potentially-Production cloud is available. A separate free account dedicated to staging is a future option requiring owner approval and separate credentials.
- Populate Vercel **Preview** variables through the Vercel dashboard or approved secret manager. Do not use Production `env pull`, copy Production values, or store secrets in Git-tracked files.
- The local OIDC variable has not been classified as a Vercel API token or deployment runtime token because its value was not inspected. Its owner should establish its purpose/expiry through the approved local credential-management workflow.

## Local staging environment file

Store the file outside the repository, for example:

```powershell
$envFile = Join-Path $env:LOCALAPPDATA "Crushify\staging.env"
```

Populate it through the approved secret-management workflow. Do not put credential values in chat, command-line arguments, shell history, source control, or this file in the repository. The file should contain the applicable variables below:

```dotenv
ENVIRONMENT=staging
CRUSHIFY_STAGING_PROFILE=local
DATABASE_PROVIDER=turso
TURSO_STAGING_DATABASE_URL=<confirmed staging libsql URL>
TURSO_STAGING_AUTH_TOKEN=<staging-only database token>
TURSO_CONFIRM_DATABASE=crushify-staging
TURSO_CONFIRM_GROUP=crushify-staging-sg
TURSO_CONFIRM_REGION=Singapore
TURSO_CONFIRM_HOSTNAME=<exact owner-confirmed staging Turso hostname>
STORAGE_PROVIDER=mock
```

`TURSO_CONFIRM_HOSTNAME` must exactly match the hostname in
`TURSO_STAGING_DATABASE_URL`. This pin catches accidental target mismatches;
it does not prove Turso account ownership, database ownership, token scope, or
separation from Production. An authorized owner must independently verify
those facts before any remote connection or migration.

For local authentication integration tests, the harness starts an in-memory HTTP sink bound only to `127.0.0.1` and passes its URL through `LOCAL_TEST_MAIL_SINK_URL`. Do not configure this variable for Preview or Production; runtime validation rejects it outside local development.

For a read-only migration preflight:

```powershell
node "--env-file=$envFile" --experimental-strip-types scripts/staging-turso.ts --preflight
```

This is the only supported remote migration preflight for the Vercel
Preview/Turso database. It makes a read-only connection to the configured
remote staging database and verifies migration ordering/checksums, the
existing migration ledger, foreign keys, and schema objects. It is not a
local dry run and must not be executed until the owner has independently
verified the target and approved the read-only connection. The explicit
hostname pin is not a substitute for provider-side identity verification.
The generic `npm run db:migrate:turso` command is local SQLite-file-only;
`npm run db:apply:staging` targets the legacy Worker/D1 configuration and is
not the Vercel Preview migration path.

After the owner approves the remote preflight and reviews its result, the
separate write command requires an explicit migration confirmation:

```powershell
$env:TURSO_MIGRATE_CONFIRM = "I_CONFIRM_APPLY_STAGING_MIGRATIONS"
node "--env-file=$envFile" --experimental-strip-types scripts/staging-turso.ts --migrate
Remove-Item Env:\TURSO_MIGRATE_CONFIRM
```

The migration command rechecks migration checksums, foreign keys, tables, and indexes after applying. A failed check exits non-zero. It never seeds customer data.

Turso synthetic remote writes require an explicit opt-in in the local staging file or process:

```dotenv
TURSO_SMOKE_TEST=I_CONFIRM_SYNTHETIC_DATA
```

Do not run the Cloudinary smoke test in staging. Its shared policy rejects staging before adapter creation because local code cannot verify Cloudinary account ownership or credential separation. No Cloudinary staging upload/delete path is supported by the current local contract.

The Turso test can be run only after owner verification of a dedicated staging database and credentials:

```powershell
node "--env-file=$envFile" --experimental-strip-types scripts/smoke-turso-staging.ts
```

It uses a unique temporary table and synthetic row, then removes them. Do not run until the database account, plan, database identity, and token are owner-verified.

## Operational boundaries

- Do not run these commands against Vercel Production environment files. The local profile marker and exact staging confirmations are required; scripts also reject `VERCEL_ENV=production`.
- The Turso scripts require the exact database, group, region, provider, and staging hostname. Error messages do not include URLs or tokens. The local machine has no Turso CLI; the owner-identified `crushify-staging` candidate remains unverified and has not been compared with Production.
- Staging database scripts use only `TURSO_STAGING_*` credentials. The Cloudinary staging smoke script fails before adapter construction and does not fall back to production credentials.
- Cloudinary remains disabled for staging regardless of configured cloud name or credentials. Re-enablement requires a separately reviewed account and credential isolation design plus owner verification; no remote asset operations were performed.
- `vercel.json` defines one daily publication lifecycle Cron, which Vercel sends to Production. The route requires a matching Production environment for that invocation; Vercel does not schedule Preview deployments, so Preview data has no automatic expiry/cleanup runner. The Cloudflare Worker cron triggers are disabled to prevent duplicate automatic lifecycle runs.
- The app's in-memory `MemoryStorageAdapter` supports local API/integration tests only. Vercel Preview does not construct it: uploads and operations requiring durable media return `STORAGE_UNAVAILABLE`, and public media retrieval returns not-found. Preview durable media storage remains unavailable until a separate staging provider is approved and configured; remote storage configuration has not been verified. Vercel Preview suppresses mail-provider credentials, selects the mock payment provider, and keeps checkout, settlement, webhook processing, and fulfillment unavailable.
- Local tests and a successful environment-file parse do not prove remote connectivity. No remote migration, CRUD operation, or Cloudinary upload should be reported as successful until the corresponding remote smoke script actually completes.

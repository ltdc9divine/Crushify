# Crushify staging environment

## Environment separation

- **Vercel Preview** is the intended staging deployment scope. Configure it with `ENVIRONMENT=staging` and staging-prefixed credentials only. The runtime requires the current deployment's `VERCEL_URL`; it never falls back to `VERCEL_PROJECT_PRODUCTION_URL`. If `APP_ORIGIN` is set, it must exactly match that Preview deployment origin. Do not attach staging to the production domain.
- **Vercel Production** is reserved for production application configuration. Never use its environment pull, database URL/token, or storage credentials for staging operations. Production must not contain `TURSO_STAGING_TARGET`, `TURSO_CONFIRM_DATABASE`, `TURSO_CONFIRM_GROUP`, `TURSO_CONFIRM_REGION`, `TURSO_SMOKE_TEST`, or `CLOUDINARY_SMOKE_TEST`.
- Preview must explicitly set `ENVIRONMENT=staging`; its database runtime uses only `TURSO_STAGING_DATABASE_URL` and `TURSO_STAGING_AUTH_TOKEN`. It does not fall back to `TURSO_DATABASE_URL` or `TURSO_AUTH_TOKEN`. Production continues to use only the generic Turso variables and rejects a database hostname matching the staging database.
- Vercel runtime classification fails closed for missing or unknown `VERCEL_ENV` values and mismatched `ENVIRONMENT` markers. Production keeps its existing `APP_ORIGIN` / `VERCEL_PROJECT_PRODUCTION_URL` resolution, with malformed or conflicting origins rejected. Local Vercel development requires the trusted `VERCEL_ENV=development` signal; local database connections must use a file database.
- Both normal API requests and the protected lifecycle handler reject cross-scope database or Cloudinary credentials. Vercel Cron runs only against the Production deployment; no Preview lifecycle scheduler is configured.
- Cloudinary is disabled for all staging runtimes, including Vercel Preview and the legacy Cloudflare Worker. Cloud-name or credential variable names cannot establish separate account ownership, and no local flag can prove the remote account boundary. Keep Preview on `STORAGE_PROVIDER=mock`. The legacy Worker rejects staging requests and staging scheduled execution because its runtime cannot verify D1/R2 resource identity; explicit R2 selection in the adapter factory does not enable a Worker staging deployment. The guarded Cloudinary smoke script also refuses staging until account isolation is independently verified and support is deliberately re-enabled.
- Local migration scripts use `TURSO_STAGING_*` from a separate file stored outside this repository. The Cloudinary smoke script is intentionally blocked for staging. Local application tests and Vercel Preview can use `STORAGE_PROVIDER=mock` with in-memory storage and do not require Cloudinary credentials. Preview mock storage is ephemeral and is not suitable for durable media. The `npm run dev` Worker script explicitly sets `ENVIRONMENT=local` and uses Wrangler local bindings; Worker local requests are accepted only on loopback origins.
- Local migration and smoke scripts require `CRUSHIFY_STAGING_PROFILE=local`, exact database/group/region confirmations, and reject Vercel Production. Migrations additionally require `TURSO_MIGRATE_CONFIRM=I_CONFIRM_APPLY_STAGING_MIGRATIONS`; smoke tests require explicit synthetic-data opt-in.
- The Vercel Cron in `vercel.json` targets the Production deployment and the protected lifecycle handler accepts only matching `ENVIRONMENT=production` / `VERCEL_ENV=production` or `ENVIRONMENT=staging` / `VERCEL_ENV=preview` pairs. Because Vercel does not invoke Cron jobs on Preview deployments, this schedule is for Production only; staging expiry and cleanup have no automatic scheduler. The route was tested only with local synthetic data, not a deployed Cron.
- The temporary `/api/ops/staging` privileged route has been removed. Production cron authentication remains bearer-token protected.

## Configuration inventory (read-only audit)

Only variable names and presence were inspected; no Vercel values were displayed, pulled, or reused.

| Service | Required configuration | Current status | Action |
|---|---|---|---|
| Vercel | Linked `crushify` project, Preview environment, protected deployments | Read-only `vercel env ls preview` reported no environment variables. SSO protection reports `all_except_custom_domains`; Git-fork protection is enabled. | Keep protections enabled. Production branch was not exposed by the read-only CLI output and remains unverified. |
| Turso | `DATABASE_PROVIDER`, `TURSO_STAGING_DATABASE_URL`, `TURSO_STAGING_AUTH_TOKEN` in Preview; dedicated DB and database-scoped token | Turso CLI is not installed. Account/database status is **UNKNOWN**. The owner-identified `crushify-staging` candidate is not confirmed or compared with Production. Preview has no variables configured. | In the owner dashboard, verify the free plan, organization, exact database identity/location, and that it is separate from Production. Do not create a duplicate; never reuse an exposed token. |
| Cloudinary | No staging Cloudinary variables are accepted while staging support is disabled. Production continues to use `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`. | Staging Cloudinary is rejected before adapter initialization in Vercel and Worker runtimes. No Cloudinary calls were made. | Keep Cloudinary disabled in staging. Re-enablement requires an independently reviewed account/credential isolation contract; local cloud-name comparisons or confirmations are insufficient. |
| Application | `ENVIRONMENT=staging`, Vercel `VERCEL_URL`; optional matching `APP_ORIGIN` | Preview has no environment variables configured. | Configure the explicit staging marker and keep `APP_ORIGIN` absent or equal to the current Preview deployment URL. |
| Email/magic links | `PREVIEW_EMAIL_SINK=discard` (optional; no provider credentials) | Preview has no outbound email configuration. The discard sink cannot deliver interactive sign-in links. | Keep real mail credentials out of Preview. Use the discard sink only for safe API contract checks; interactive Preview sign-in requires a separately approved test-only delivery design. |
| Payment | Mock/test only; no live provider | `PAYMENT_MODE` and audited `SEPAY_*` names are absent in Preview and Production. Runtime disables mock/test settlement outside local development. | Leave payment disabled in Preview; no real SePay credentials. |
| Cron | `CRON_SECRET` for the protected Production Cron route | The repository declares one daily Production Cron; actual deployment and invocation were not verified. Preview has no scheduled invocation. Environment-variable names/presence were not inspected during this task. | Configure and verify the secret only through the approved Production release process; never copy it to Preview or call the Production endpoint during local QA. |

The historical read-only Preview listing reported no environment variables; it was not repeated for ORDERS-2.9. Names needed for a database-backed Preview using mock storage include `ENVIRONMENT=staging`, `DATABASE_PROVIDER=turso`, `TURSO_STAGING_DATABASE_URL`, `TURSO_STAGING_AUTH_TOKEN`, and `STORAGE_PROVIDER=mock`. Cloudinary staging variables are intentionally not needed while storage remains mock. `MAIL_PROVIDER`, `MAIL_API_KEY`, and `MAIL_FROM_EMAIL` must remain absent. `PREVIEW_EMAIL_SINK=discard` suppresses outbound mail but cannot deliver interactive sign-in links. `CRON_SECRET` is not used by a Preview scheduler; payment variables are intentionally absent.

Vercel CLI access is authenticated. The project lists `https://crushify-one.vercel.app` as its Production alias; it currently resolves to `https://crushify-1mswrm351-ltdc9divine-5816s-projects.vercel.app`. The inspected deployment metadata did not expose a source commit SHA. Project metadata did not expose the Production branch. Deployment protection was inspected without accessing or bypassing protected routes.

The historical local `.env.local` inspection found a non-empty `VERCEL_OIDC_TOKEN` assignment; its value and validity were not inspected or rechecked during ORDERS-2.9. No `.dev.vars` file was present when the ORDERS-2.9 integration gate was attempted. Treat any OIDC value as sensitive; do not paste it into chat or use it as a staging API credential.

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
STORAGE_PROVIDER=mock
```

For local authentication integration tests, the harness starts an in-memory HTTP sink bound only to `127.0.0.1` and passes its URL through `LOCAL_TEST_MAIL_SINK_URL`. Do not configure this variable for Preview or Production; runtime validation rejects it outside local development.

For a read-only migration preflight:

```powershell
node "--env-file=$envFile" --experimental-strip-types scripts/staging-turso.ts --preflight
```

The read-only preflight verifies migration ordering/checksums and the schema objects corresponding to migrations already applied. Only after independently verifying the database identity and reviewing preflight results, migrations may be applied with a separate explicit confirmation:

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
- The app's in-memory `MemoryStorageAdapter` supports local API/integration tests and Vercel Preview without Cloudinary credentials. Preview storage is ephemeral; it is not suitable for durable media. Vercel Preview suppresses mail-provider credentials and mock/test payment settlement remains disabled outside local development.
- Local tests and a successful environment-file parse do not prove remote connectivity. No remote migration, CRUD operation, or Cloudinary upload should be reported as successful until the corresponding remote smoke script actually completes.

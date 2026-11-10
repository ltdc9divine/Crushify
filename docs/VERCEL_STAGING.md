# Crushify staging environment

## Environment separation

- **Vercel Preview** is the intended staging deployment scope. Configure it with `ENVIRONMENT=staging` and staging-prefixed credentials only. Do not attach staging to the production domain.
- **Vercel Production** is reserved for production application configuration. Never use its environment pull, database URL/token, or storage credentials for staging operations. Production must not contain `TURSO_STAGING_TARGET`, `TURSO_CONFIRM_DATABASE`, `TURSO_CONFIRM_GROUP`, `TURSO_CONFIRM_REGION`, `TURSO_SMOKE_TEST`, or `CLOUDINARY_SMOKE_TEST`.
- Preview must explicitly set `ENVIRONMENT=staging`; its database runtime uses only `TURSO_STAGING_DATABASE_URL` and `TURSO_STAGING_AUTH_TOKEN`. It does not fall back to `TURSO_DATABASE_URL` or `TURSO_AUTH_TOKEN`. Production continues to use only the generic Turso variables and rejects a database hostname matching the staging database.
- Both normal API requests and the protected lifecycle handler reject cross-scope database or Cloudinary credentials. No Preview lifecycle scheduler is configured.
- Preview Cloudinary configuration uses only `CLOUDINARY_STAGING_CLOUD_NAME`, `CLOUDINARY_STAGING_API_KEY`, and `CLOUDINARY_STAGING_API_SECRET`. It requires `CLOUDINARY_STAGING_ISOLATED_ACCOUNT=I_CONFIRM_SEPARATE_FREE_CLOUD` and rejects the previously assumed cloud `hgtcizux`. The owner reported that only one cloud is currently available; treat it as potentially Production. Do not use Cloudinary from staging until a separate free account/cloud is owner-verified.
- Local migration and smoke scripts use `TURSO_STAGING_*` and `CLOUDINARY_STAGING_*` from a separate file stored outside this repository. Local application tests and Vercel Preview can use `STORAGE_PROVIDER=mock` with in-memory storage and do not require Cloudinary credentials. Preview mock storage is ephemeral and is not suitable for durable media.
- Local migration and smoke scripts require `CRUSHIFY_STAGING_PROFILE=local`, exact database/group/region confirmations, and reject Vercel Production. Migrations additionally require `TURSO_MIGRATE_CONFIRM=I_CONFIRM_APPLY_STAGING_MIGRATIONS`; smoke tests require explicit synthetic-data opt-in.
- Vercel scheduled requests target the Production deployment. The staging lifecycle endpoint requires `ENVIRONMENT=staging` and `VERCEL_ENV=preview`; a Production cron invocation cannot enter the staging lifecycle. No staging scheduler is configured, so staging publication expiry and cleanup are not certified.
- The temporary `/api/ops/staging` privileged route has been removed. Production cron authentication remains bearer-token protected.

## Configuration inventory (read-only audit)

Only variable names and presence were inspected; no Vercel values were displayed, pulled, or reused.

| Service | Required configuration | Current status | Action |
|---|---|---|---|
| Vercel | Linked `crushify` project, Preview environment, protected deployments | Read-only `vercel env ls preview` reported no environment variables. SSO protection reports `all_except_custom_domains`; Git-fork protection is enabled. | Keep protections enabled. Production branch was not exposed by the read-only CLI output and remains unverified. |
| Turso | `DATABASE_PROVIDER`, `TURSO_STAGING_DATABASE_URL`, `TURSO_STAGING_AUTH_TOKEN` in Preview; dedicated DB and database-scoped token | Turso CLI is not installed. Account/database status is **UNKNOWN**. The owner-identified `crushify-staging` candidate is not confirmed or compared with Production. Preview has no variables configured. | In the owner dashboard, verify the free plan, organization, exact database identity/location, and that it is separate from Production. Do not create a duplicate; never reuse an exposed token. |
| Cloudinary | `STORAGE_PROVIDER`, `CLOUDINARY_STAGING_CLOUD_NAME`, `CLOUDINARY_STAGING_API_KEY`, `CLOUDINARY_STAGING_API_SECRET`, `CLOUDINARY_STAGING_ISOLATED_ACCOUNT` | Owner identified `hgtcizux`, previously observed as the existing Crushify cloud. Its isolation is unverified and it is rejected for staging. Preview has no variables configured. No Cloudinary calls were made. | Do not use `hgtcizux` for staging. Owner must provide a cloud name from a newly created separate free account; it must differ from the Production cloud. |
| Application | `ENVIRONMENT=staging`, `APP_ORIGIN` or Vercel-provided Preview URL | Preview has no environment variables configured. | Configure the explicit staging marker. Vercel deployment URL can supply the origin if otherwise valid. |
| Email/magic links | `MAIL_PROVIDER`, `MAIL_API_KEY`, `MAIL_FROM_EMAIL` | These variable names are absent in Preview. | Staging remote authentication needs an approved free/test email path; do not initiate real email delivery in this phase. |
| Payment | Mock/test only; no live provider | `PAYMENT_MODE` and audited `SEPAY_*` names are absent in Preview and Production. Runtime disables mock/test settlement outside local development. | Leave payment disabled in Preview; no real SePay credentials. |
| Cron | `CRON_SECRET` only if a Preview-safe scheduler is later approved | `CRON_SECRET` is absent in Preview and present in Production scope; values were not inspected. No Preview scheduler is configured. | Do not copy Production secret or schedule. |

The read-only Preview listing returned no environment variables. Names needed for a database-backed Preview using mock storage include `ENVIRONMENT`, `DATABASE_PROVIDER`, `TURSO_STAGING_DATABASE_URL`, `TURSO_STAGING_AUTH_TOKEN`, and `STORAGE_PROVIDER`. Cloudinary staging variables are intentionally not needed while storage remains mock. `MAIL_PROVIDER`, `MAIL_API_KEY`, and `MAIL_FROM_EMAIL` are intentionally not configured; Vercel Preview does not pass mail credentials to the application. `APP_ORIGIN` and `CRON_SECRET` are also absent, but are not required for the currently configured Preview path; payment variables are intentionally absent.

Vercel CLI access is authenticated. The project lists `https://crushify-one.vercel.app` as its Production alias; it currently resolves to `https://crushify-1mswrm351-ltdc9divine-5816s-projects.vercel.app`. The inspected deployment metadata did not expose a source commit SHA. Project metadata did not expose the Production branch. Deployment protection was inspected without accessing or bypassing protected routes.

The current local `.env.local` contains a non-empty `VERCEL_OIDC_TOKEN` assignment; its value and validity were not inspected. `.dev.vars` contains no service credential variable names. Treat the OIDC value as sensitive and leave it untouched; do not paste it into chat or use it as a staging API credential.

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

Do not run the Cloudinary smoke test against the only current cloud. The code blocks the previously assumed cloud `hgtcizux`; a separately approved free staging account would require its own credentials plus `CLOUDINARY_STAGING_ISOLATED_ACCOUNT=I_CONFIRM_SEPARATE_FREE_CLOUD` before that smoke script can run.

The Turso test can be run only after owner verification of a dedicated staging database and credentials:

```powershell
node "--env-file=$envFile" --experimental-strip-types scripts/smoke-turso-staging.ts
```

It uses a unique temporary table and synthetic row, then removes them. Do not run until the database account, plan, database identity, and token are owner-verified.

## Operational boundaries

- Do not run these commands against Vercel Production environment files. The local profile marker and exact staging confirmations are required; scripts also reject `VERCEL_ENV=production`.
- The Turso scripts require the exact database, group, region, provider, and staging hostname. Error messages do not include URLs or tokens. The local machine has no Turso CLI; the owner-identified `crushify-staging` candidate remains unverified and has not been compared with Production.
- Staging scripts use only `TURSO_STAGING_*` and `CLOUDINARY_STAGING_*` credentials. They never fall back to the generic production credential names.
- Cloudinary's `hgtcizux` cloud is treated as potentially Production and is rejected for staging. The owner must provide a cloud name from a separate free account that differs from Production. No remote asset operations were performed.
- `vercel.json` defines a publication lifecycle cron, but Vercel sends scheduled requests to Production. The endpoint rejects staging in Production, so it will not clean up Preview data; no Preview schedule or replacement scheduler has been configured.
- The app's in-memory `MemoryStorageAdapter` supports local API/integration tests and Vercel Preview without Cloudinary credentials. Preview storage is ephemeral; it is not suitable for durable media. Vercel Preview suppresses mail-provider credentials and mock/test payment settlement remains disabled outside local development.
- Local tests and a successful environment-file parse do not prove remote connectivity. No remote migration, CRUD operation, or Cloudinary upload should be reported as successful until the corresponding remote smoke script actually completes.

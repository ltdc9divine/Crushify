# Crushify staging environment

## Environment separation

- **Vercel Preview** is the staging deployment scope. Configure it with `ENVIRONMENT=staging` and credentials dedicated to the staging Turso database and Cloudinary Test cloud. Do not attach staging to the production domain.
- **Vercel Production** is reserved for production application configuration. Never use its environment pull, database URL/token, or storage credentials for staging operations. Production must not contain `TURSO_STAGING_TARGET`, `TURSO_CONFIRM_DATABASE`, `TURSO_CONFIRM_GROUP`, `TURSO_CONFIRM_REGION`, `TURSO_SMOKE_TEST`, or `CLOUDINARY_SMOKE_TEST`.
- The local migration and smoke scripts are for direct staging-service checks. They require a separate staging-only environment file stored outside this repository, marked with `CRUSHIFY_STAGING_PROFILE=local`. They reject `VERCEL_ENV=production`, require explicit target confirmations, and require synthetic-data opt-in for smoke tests.
- The temporary `/api/ops/staging` privileged route has been removed. The permanent publication cron route and its bearer authentication are unchanged.

## Credential availability

The current Vercel CLI account can list environment variable names but does not expose their values. `vercel env pull` returned `[SENSITIVE]` placeholders for Production variables. Preview currently lists only `ENVIRONMENT` among the audited provider and staging variables; it does not provide usable Turso or Cloudinary credentials. Do not try to recover or substitute the placeholders.

Before remote staging checks can run, a project/service owner must provision:

1. A Turso token scoped to the confirmed `crushify-staging` database in group `crushify-staging-sg`, Singapore.
2. API credentials for the Cloudinary Test cloud `hgtcizux`.
3. A secure delivery method for those credentials to an operator, or authorized access to populate a local secret file.

The owner should configure dedicated staging values in Vercel Preview if the staging deployment needs the providers, and separately provide the credentials through the approved secret manager for local smoke scripts. Do not copy Production credentials into Preview or a local file. Production credentials hidden by Vercel must be verified or rotated by an authorized owner before they can be certified as production-only.

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
STORAGE_PROVIDER=cloudinary
CLOUDINARY_STAGING_CLOUD_NAME=hgtcizux
CLOUDINARY_STAGING_API_KEY=<Cloudinary Test API key>
CLOUDINARY_STAGING_API_SECRET=<Cloudinary Test API secret>
```

For a read-only migration preflight:

```powershell
node "--env-file=$envFile" --experimental-strip-types scripts/staging-turso.ts --preflight
```

Only after independently verifying the database identity and reviewing preflight results, migrations may be applied with:

```powershell
node "--env-file=$envFile" --experimental-strip-types scripts/staging-turso.ts --migrate
```

Synthetic remote writes require an explicit opt-in in the local staging file or process:

```dotenv
TURSO_SMOKE_TEST=I_CONFIRM_SYNTHETIC_DATA
CLOUDINARY_SMOKE_TEST=I_CONFIRM_SYNTHETIC_DATA
```

Run the scripts only when needed:

```powershell
node "--env-file=$envFile" --experimental-strip-types scripts/smoke-turso-staging.ts
node "--env-file=$envFile" --experimental-strip-types scripts/smoke-cloudinary-staging.ts
```

The Turso smoke test uses a unique temporary table and synthetic row, then removes them. The Cloudinary smoke test uses a synthetic one-pixel image and verifies cleanup. If cleanup reports a failure, inspect only the specific synthetic object named by the script. Neither test should use customer data.

## Operational boundaries

- Do not run these commands against Vercel Production environment files. The local profile marker and exact staging confirmations are required; scripts also reject `VERCEL_ENV=production`.
- The Turso scripts require the exact database, group, region, provider, and staging hostname. Error messages do not include URLs or tokens.
- Staging scripts use only `TURSO_STAGING_*` and `CLOUDINARY_STAGING_*` credentials. They never fall back to the generic production credential names.
- Cloudinary smoke testing requires `STORAGE_PROVIDER=cloudinary`, the confirmed Test cloud, staging-specific credentials, and explicit synthetic-data opt-in. Production execution is rejected.
- `vercel.json` still defines the permanent publication cron schedule. Its route remains bearer-authenticated; this staging-configuration change does not alter cron behavior.
- Local tests and a successful environment-file parse do not prove remote connectivity. No remote migration, CRUD operation, or Cloudinary upload should be reported as successful until the corresponding remote smoke script actually completes.

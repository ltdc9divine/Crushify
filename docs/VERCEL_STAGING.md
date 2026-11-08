# Vercel and Turso staging readiness

## Status and boundaries

This repository contains code-side preparation only. No Vercel project has been linked or deployed from this worktree, and no remote Turso or Cloudinary request, migration, or smoke test has run. The local Vercel CLI project-link status previously observed was empty; verify the GitHub-connected Vercel project in its dashboard rather than assuming this checkout is linked.

The staging deployment must use synthetic fixtures only. Do not map the production custom domain to a staging environment, import production records, configure payment/SePay credentials, or deploy before confirming Vercel project, branch, environment scope, domain, and secrets. Set Vercel `ENVIRONMENT=staging` even if Vercel reports `VERCEL_ENV=production`; the runtime rejects unsupported environment overrides and only accepts this combination for Preview/Production channels.

## Vercel server-side variables

Configure these only in the Vercel secret/environment settings, never in browser-visible variables:

- `ENVIRONMENT=staging`
- `DATABASE_PROVIDER=turso`
- `TURSO_DATABASE_URL` for the confirmed `crushify-staging` database
- `TURSO_AUTH_TOKEN` scoped to that database
- `STORAGE_PROVIDER=cloudinary`
- `CLOUDINARY_CLOUD_NAME=hgtcizux` (the supplied Cloudinary Test cloud)
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `APP_ORIGIN` set to the exact HTTPS staging origin with no trailing slash
- `CRON_SECRET`, generated randomly and at least 32 characters
- Optionally `DATA_RETENTION_DAYS` from 1 through 3650; default is 30

Do not set `LOCAL_TEST_MODE`, `PAYMENT_MODE`, or any `SEPAY_*` variable in staging. Configure only staging mail credentials if email testing is needed. The lifecycle endpoint refuses non-staging app environments, non-staging Turso hostnames, missing database auth, and a Cloudinary cloud name other than `hgtcizux`.

`vercel.json` defines one daily Vercel Cron invocation at 03:00 UTC. Vercel sends `CRON_SECRET` as a bearer authorization header. A checked-in schedule is not evidence that a deployment, schedule, or successful invocation exists. Verify it in Vercel after an explicitly approved deployment. The endpoint processes a bounded batch and stores an exclusive lease/run history in migration 0008. Recipient reads already check exact expiration timestamps, so public content and media are denied at the expiry boundary even before the daily cleanup runner changes stored status.

## Confirm and preflight the Turso destination

Before any remote request, inspect the Turso dashboard and confirm all three values: database `crushify-staging`, group `crushify-staging-sg`, and region `Singapore`. The URL hostname must be `crushify-staging-<organization>.turso.io`. The CLI cannot independently discover or prove the dashboard group or region; its confirmation variables are an operator attestation, not provider metadata.

In a dedicated PowerShell window, provide values locally without pasting tokens into chat or command history. Do not use a production URL/token:

```powershell
$env:ENVIRONMENT = "staging"
$env:DATABASE_PROVIDER = "turso"
$env:TURSO_DATABASE_URL = "<confirmed libsql URL>"
$env:TURSO_AUTH_TOKEN = "<staging database token>"
$env:TURSO_CONFIRM_DATABASE = "crushify-staging"
$env:TURSO_CONFIRM_GROUP = "crushify-staging-sg"
$env:TURSO_CONFIRM_REGION = "Singapore"
npm run db:preflight:turso:staging
```

The preflight is read-only. It checks the explicit operator confirmations, URL identity/protocol, migration ordering/checksums, and foreign-key integrity. For a database without a migration ledger it refuses any pre-existing application tables. It does not create, drop, or alter tables. Do not proceed if the database identity or current ledger differs from expectations.

Only after reviewing the preflight output and separately confirming the database is the intended disposable staging target, run:

```powershell
npm run db:migrate:turso:staging
```

This applies only checked-in numbered schema migrations transactionally; it does not transfer D1 data. The staging migration command is intentionally separate from the generic local-file migration script. Migration 0008 adds the persistent lifecycle lease and run history; migrations 0001–0007 remain unchanged.

## Synthetic remote smoke tests

These are opt-in, explicit remote writes. Run them only against the verified staging targets, with no production/customer data:

```powershell
$env:TURSO_SMOKE_TEST = "I_CONFIRM_SYNTHETIC_DATA"
npm run smoke:turso:staging
```

The Turso check creates a uniquely named temporary table, writes a synthetic row, reads/updates it through another connection, deletes the row, and drops the table in cleanup. If cleanup reports failure, remove only the named `crushify_smoke_<random>` table after verifying its identity.

For the Cloudinary Test cloud:

```powershell
$env:ENVIRONMENT = "staging"
$env:STORAGE_PROVIDER = "cloudinary"
$env:CLOUDINARY_CLOUD_NAME = "hgtcizux"
$env:CLOUDINARY_API_KEY = "<Cloudinary Test API key>"
$env:CLOUDINARY_API_SECRET = "<Cloudinary Test API secret>"
$env:CLOUDINARY_SMOKE_TEST = "I_CONFIRM_SYNTHETIC_DATA"
npm run smoke:cloudinary:staging
```

This uploads a synthetic one-pixel PNG as a private authenticated asset, verifies the private read and public derivative bytes, then deletes both in `finally`. A derivative is briefly publicly addressable during the test; use only the supplied Test cloud. If cleanup fails, the script reports which synthetic object class remains, without logging credentials or signed URLs.

## Post-deployment verification and limitations

After an explicitly approved deployment and migrations, verify:

- The deployment is attached to the intended Vercel project/branch and only a staging URL is exposed.
- `/api/v1/health/ready` and static homepage/template paths work at the configured origin.
- Vercel environment values select staging/Turso/Cloudinary and payment functionality remains disabled.
- `GET /api/cron/publication-lifecycle` rejects missing or invalid bearer credentials and succeeds only with `CRON_SECRET`.
- The Cron configuration appears in Vercel and an actual scheduled invocation completes; inspect logs without exposing credentials.
- Synthetic authentication/design read-write behavior, Cloudinary private reads, publication image consent/revocation, expiry denial, mobile browser behavior, and cleanup are tested on the real deployed URL before any broader use.

Local unit/integration tests and mocked Cloudinary tests are not evidence of remote connectivity. The smoke scripts exercise the database/storage adapters directly; they do not prove Vercel deployment behavior, email delivery, publication consent UX, or production scheduling. No scheduler is considered active until the deployment and invocation are observed.

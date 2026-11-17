# Hosting and Backend Migration

## Status and safety boundary

This is an architecture/migration note, not a deployment record. Vercel is the intended primary hosting platform; the custom domain remains postponed until the website is complete. Current project linkage, deployment state, remote resources, and provider configuration are **NOT VERIFIED**. Cloudflare was abandoned as the primary hosting/database direction.

- The Vercel Node Function adapter uses the shared API router and has Turso/Cloudinary integration paths in source. This does not establish that a Vercel project, Preview deployment, credentials, or remote resources are configured.
- The Cloudflare Worker/D1/R2 material below is retained as legacy/local compatibility history, not an approved deployment or rollback target. Do not execute Wrangler staging scripts without separate owner approval.
- Local test code covers the shared API contract and database adapters with synthetic/local resources. Tests were not run in this documentation batch; no external provider or remote deployment was exercised here.
- Local order/webhook tests use synthetic data. Preview SePay Test mode exists only behind the explicit Preview customer-flow gate and full isolated configuration. Preview configuration and any SePay Sandbox transaction are **NOT VERIFIED**. Production checkout/webhook settlement is **NOT ENABLED**, and Production is **NOT PRODUCTION READY**.
- Historical Phase 4 browser checks from 2026-11-05 are local-only records; they do not prove current routes, hosted behavior, or deployment state.

## Phase 6 local publication validation

The historical local Worker integration/browser checks cover template publication paths, synthetic paid-order eligibility, media derivatives, revocation, and cleanup. They do not represent a current Vercel deployment, remote database/storage, or real payment, and were not rerun in this documentation batch.

Do not run a remote migration until the destination identity, current D1 data state, export/import plan, backup, restore test, and migration window are explicitly verified. The CLI intentionally refuses untracked existing database schemas.

## Local development

Requirements: Node.js 22.6 or newer and npm.

```powershell
npm ci
npm run typecheck
npm test
```

The existing Cloudflare app remains locally runnable with Wrangler:

```powershell
Copy-Item .dev.vars.example .dev.vars
npm run db:apply:local
npm run dev
```

Payment tests are local-only. The checked-in `.dev.vars.example` does not contain a webhook secret or bank credentials. For development, set `PAYMENT_MODE=mock` and generate a random `SEPAY_WEBHOOK_SECRET` in the ignored `.dev.vars`; do not use a secret from any live account. `mock` never creates a QR. `sepay-test` additionally requires Test mode bank code/account configured in the SePay dashboard; do not copy Live bank settings. The checkout UI is `/checkout/?design_id=<owned-draft-id>` and requires a signed-in local session plus an active test price. Migration `0003` intentionally seeds no prices; test runners seed synthetic VND 50,000 prices only into disposable databases.

The local SePay callback path is `POST /api/v1/payments/sepay/webhook`. To test against SePay's actual Test mode, create a Test mode bank account and webhook in its dashboard, select HMAC-SHA256, set the callback URL to a publicly reachable HTTPS test endpoint, and simulate an incoming transfer. This needs SePay account access and explicit isolated Test mode credentials; no such account was used during this implementation. Do not point Test mode at a Live endpoint or use a Live account for development.

The Turso adapter and migration CLI can be exercised against an isolated local SQLite file; do not use a production URL for tests:

```powershell
$env:TURSO_DATABASE_URL = "file:crushify-local.db"
$env:TURSO_AUTH_TOKEN = ""
npm run db:migrate:turso
```

The command runs the numbered SQL files in `migrations/`, verifies SHA-256 migration checksums, applies each migration atomically, and runs a foreign-key check. Re-running it against the same schema is a no-op. It fails if application tables exist without a migration ledger or if an applied migration differs from its recorded checksum. Local database files are ignored by Git.

`.env.example` is a placeholder inventory only. The migration CLI reads process environment variables; it does not automatically load `.env`.

## Vercel Development and Preview

The Node Function at `api/[...path].ts` forwards HTTP requests to the shared `handleApiRequest` router. It buffers only bounded bodies, preserves multi-value `Set-Cookie`, imposes a 30-second request-body read timeout, supports only explicit methods, and keeps API responses private. Static root and `/templates/<id>/` paths are served directly by Vercel; no SPA fallback or API rewrite is configured. CORS preflight is limited to the exact configured `APP_ORIGIN` (or Vercel's deployment URL for a Preview if no override is set); credentialed requests never receive wildcard CORS.

Current Vercel plan/commercial eligibility and project linkage are **NOT VERIFIED**; the owner must check current terms and settings through an authorized account before deployment or commercial use. `vercel.json` declares a daily lifecycle Cron in source, but no deployed schedule or invocation is verified.

For Vercel local development:

1. Install/use Vercel CLI and create the ignored `.local` directory.
2. Copy `.env.example` to `.env.local` only if a user-owned `.env.local` does not already exist. The example uses `file:.local/crushify-vercel.db`, `STORAGE_PROVIDER=mock`, `LOCAL_TEST_MODE=true`, `PAYMENT_MODE=mock`, and `APP_ORIGIN=http://localhost:3000`.
3. Start `npm run dev:email-sink` in a separate terminal and open its loopback inbox. Its URL must match `LOCAL_TEST_MAIL_SINK_URL` in `.env.local`; the sink stores synthetic sign-in links in memory and sends no email.
4. Run `node --env-file=.env.local --experimental-strip-types scripts/migrate-turso.ts` against the local file database, then run `vercel dev`. The migration script rejects remote URLs and non-empty auth tokens. Local `mock` storage and payment are accepted only with local test mode; do not deploy those values. The mock checkout has no public “mark paid” action; synthetic payment settlement is covered by the local integration test.
5. The Vercel function limit is set to 4 MiB for images, below Vercel's documented 4.5 MB function request/response payload limit; the Cloudflare Worker retains its existing 5 MiB limit. The create-upload response advertises the runtime's actual limit. See [Vercel Function limits](https://vercel.com/docs/functions/limitations#request-body-size).

For Vercel Preview staging:

1. Use a dedicated, verified non-production Turso database. Vercel serverless filesystems are ephemeral and must not be used for persistent databases.
2. Database-only checks use `ENVIRONMENT=staging`, `DATABASE_PROVIDER=turso`, `TURSO_STAGING_DATABASE_URL`, and `TURSO_STAGING_AUTH_TOKEN`. For the complete opt-in customer flow, configure every isolated Preview variable listed in [SETUP-API-CREDENTIALS.md](./SETUP-API-CREDENTIALS.md), including dedicated Cloudinary, Resend, SePay Test mode, exact-email allowlist, and `STAGING_LIFECYCLE_SECRET`. The gate rejects incomplete or Production-scoped settings. Never configure `STORAGE_PROVIDER=mock` or generic Production credentials in Preview.
3. Keep `LOCAL_TEST_MODE` and all `LOCAL_TEST_*` values out of Preview. Do not configure SePay Live credentials or a mock mark-paid route. Customer checkout in Preview is limited to the configured SePay Test-mode integration.
4. Vercel Cron invokes the Production deployment only. The handler requires matching `ENVIRONMENT=production` and `VERCEL_ENV=production` for scheduled production cleanup. Preview has a protected manual lifecycle operation but no automatic schedule. `CRON_SECRET` is required in the Vercel Production environment before an approved release. No production endpoint was invoked during this work.
5. Do not use production customer data or real-money payment. See [Vercel staging setup](./VERCEL_STAGING.md) for migration controls and outstanding provider verification.

Conventional `api/` routing creates the Node Function, `api/cron/publication-lifecycle.ts` maps the Cron URL to the shared handler, and root static hosting preserves direct template paths. `vercel.json` declares one daily lifecycle Cron at 03:00 UTC. The schedule's runtime behavior is not verified until an authorized Production release process confirms its environment, required providers, secret, and first scheduled execution. Legacy Cloudflare `scheduled()` code remains in the repository; its presence does not establish an approved rollback target or deployment path.

## Turso/libSQL configuration

Required server-side variables:

- `DATABASE_PROVIDER=turso`
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN` (omit only for an isolated local `file:` database)

The generic migration command is for isolated local database files:

```powershell
npm run db:migrate:turso
```

Do not use the generic command against a remote database. For the Vercel staging target, follow [Vercel staging setup](./VERCEL_STAGING.md), including the read-only preflight, exact Turso dashboard confirmations, and a separate explicit migration command.

Before using a remote database:

1. Confirm the exact Turso organization/database and environment with the account owner.
2. Confirm whether it is empty. Do not infer this from repository config.
3. Back up the source and destination, verify the backup, and rehearse restoring into a separate test database.
4. Export/import existing D1 records only through a separately reviewed data migration; this CLI migrates schema only.
5. Apply migrations to a fresh or verified empty target, run `PRAGMA foreign_key_check`, and compare table/index/constraint inventories.
6. Store credentials in the selected host's secret manager and limit token scope/rotation. Current remote credential/database configuration is **NOT VERIFIED**; this documentation update performed no remote connection.

The current Turso account's point-in-time recovery (PITR) availability, retention, eligible plan, and restore procedure are **NOT VERIFIED**. Do not treat PITR as an available recovery path until the owner confirms it for this account. If the provider-supported PITR workflow is available, restoring to a timestamp creates a **new database**; it does not overwrite the current database. PITR of an existing database is distinct from recovery of a database that was deleted, which may require a separate provider-specific undelete or a retained export and is not confirmed here.

Before migration, pause application writes, record the target identity and pre-migration point, create an encrypted backup/export outside the repository, verify it, and rehearse restoring it into a separate database. After migration, verify the migration ledger, checksums, foreign keys, schema, and application behavior before any approved traffic switch; retain the original database and recovery point. If a migration fails, stop and inspect the ledger before retrying. If recovery is needed, restore the verified pre-migration point into a new database, validate that database, then switch configuration only with separate approval. The repository does not automate or validate Turso backup, PITR, restore, or database-deletion recovery.

## D1 data export/import procedure (not executed)

The migration command above changes schema only. There is no reviewed D1-to-Turso data importer, and no data migration has been run. Do not treat a successful schema migration or an empty foreign-key check as evidence that customer data was copied.

Before any real transfer, obtain explicit authorization and use a separately verified staging target:

1. Inventory the exact source D1 database, destination Turso database, owners, data classifications, and cutover/rollback window. Confirm both identities without inferring that a database is empty.
2. Decide which records are durable business data versus ephemeral/security capabilities. In particular, do not transfer sessions, login tokens, rate-limit state, upload capabilities, or preview tokens unless a reviewed requirement explicitly calls for it. Preserve design, customer, revision, and asset metadata only according to the approved retention and storage plan.
3. Freeze writes for the rehearsal (and for a later approved cutover), take and verify an encrypted source backup, and record its checksum and restore owner. Keep all exports outside the repository.
4. For a future approved remote export, review the exact Wrangler database name and use an explicit remote flag and output path; the command shape is:

   ```powershell
   npx wrangler d1 export <verified-d1-name> --remote --output "$env:TEMP\crushify-d1-export.sql"
   ```

   For local-only practice, substitute `--local` and a dedicated local D1 database. `wrangler d1 export --help` documents `--table`, `--no-schema`, and `--no-data`; select the precise table set and data-only/schema-only mode only after the migration plan is reviewed. Do not run the remote form as part of this phase.
5. Apply the numbered schema migrations to a fresh, isolated Turso target. Reconcile the export against that schema and transform it using a separately reviewed importer; do not blindly execute the D1 dump or re-import `schema_migrations`. The importer must use parameterized writes, preserve foreign-key ordering and IDs, report rejected rows, and handle sensitive/ephemeral tables as approved.
6. Compare per-table counts and representative checksums/relationships, verify unique constraints and `PRAGMA foreign_key_check`, test application reads/writes against the target, and rehearse restoring both source and destination backups. Investigate every mismatch before approving cutover.
7. Keep D1 authoritative and untouched until an approved cutover. Rollback means pausing writes and restoring/routing to the verified source; never attempt an unreviewed reverse import or delete either database.

**Historical stage result:** the earlier migration stage recorded schema migrations and tests against disposable local databases, with no importer or data movement. Current remote connection/export state is **NOT VERIFIED**; no remote operation was performed in this documentation update.

## Database contract test results

The same API contract runner is used for local D1 integration and the local Turso/libSQL file test. It checks magic-link/session lifecycle, replay rejection, customer ownership, design create/read/update/reload, stale revision `409`, preview bearer access, asset metadata/storage/read/delete, and asset ownership. D1 integration additionally verifies unique/foreign-key rejection and uses a forced revision-write failure to verify that an update batch rolls back. Local Turso adapter tests also verify migrations/checksums, foreign-key and unique constraints, atomic batch rollback, `RETURNING`, insert metadata, and normalized/null parameters. Run `npm test` for the unit/adapter and Turso local-file tests; run `npm run test:integration` for D1/R2, the shared API contract, and D1 constraint/rollback coverage. No remote service is contacted by either test.

## Historical alternative: Netlify (not selected)

Netlify was considered as an alternative and is not the selected hosting direction. Do not configure it as part of this batch:

1. Verify current Netlify plan terms and account eligibility for the intended commercial template sales model.
2. Implement and test a Netlify Functions adapter that calls the shared API/business layer; do not duplicate business logic.
3. Configure static routes and function routing without changing template-owned HTML/CSS/JavaScript.
4. Add only production-candidate server-side Turso/Cloudinary/SePay secrets after separate security review. Do not activate live payments or publish customer designs as part of this database stage.
5. Confirm logs, limits, regional/data terms, rate limits, backups, restore, monitoring, and rollback ownership.

No `netlify.toml` or Netlify Function is added in this phase because routing and API adapters have not been implemented.

## Cloudinary

The server-side adapter has Cloudflare Worker legacy-compatibility and Vercel integration paths in source. The opt-in Vercel Preview path can use separate Cloudinary staging settings. These source paths do not verify account setup or remote behavior. The API secret is not returned to the browser.

The generic server-side values below are reserved for the existing Production configuration (never `VITE_*` or other browser-exposed variables):

- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`

Vercel Production uses `STORAGE_PROVIDER=cloudinary` with generic Production credentials in its Production-only secret store. Preview requires `STORAGE_PROVIDER=cloudinary`, `CLOUDINARY_STAGING_CLOUD_NAME`, `CLOUDINARY_STAGING_API_KEY`, `CLOUDINARY_STAGING_API_SECRET`, and `CLOUDINARY_PRODUCTION_CLOUD_NAME`; it rejects generic Production credentials and matching cloud names. Local development rejects Cloudinary and uses mock storage. The legacy Worker rejects staging scope, rejects Cloudinary configuration in local scope, and in Production rejects staging Cloudinary variables before storage use. No implicit fallback to another account or provider occurs.

The Preview values must come from a dedicated staging account. The distinct configured Production cloud name is only a comparison value; it does not prove account ownership. The owner and reviewer must verify account separation and credential provenance before configuring Preview:

```dotenv
ENVIRONMENT=staging
STORAGE_PROVIDER=cloudinary
CLOUDINARY_STAGING_CLOUD_NAME=<owner-verified-staging-cloud-name>
CLOUDINARY_STAGING_API_KEY=<credential-issued-by-staging-account>
CLOUDINARY_STAGING_API_SECRET=<credential-issued-by-staging-account>
```

`PREVIEW_CUSTOMER_FLOW_ENABLED=true` is required in addition to the complete provider configuration. Cloud names, variable names, and a self-declared flag cannot prove separate account ownership. The owner must verify the staging account directly with the provider before configuration. Cloudinary account/configuration and remote operations are **NOT VERIFIED**.

Do not switch an environment containing R2-backed asset rows by changing only the variable: storage providers do not share binaries. Plan and test a separate inventory/copy/verification/cutover procedure first. R2 references below describe legacy Worker compatibility only and do not establish an approved rollback path. Vercel Preview mock storage is not persistent. Reverting after Cloudinary writes also requires transferring or otherwise reconciling those binaries. No implicit fallback is used.

Provider plan limits, pricing, commercial eligibility, data-region/privacy terms, retention, and feature availability are **NOT VERIFIED**. The owner must check current Cloudinary terms directly before selecting or configuring a production service.

## SePay local prototype and production gate

Local test mode supports `PAYMENT_MODE=mock|sepay-test`. The opt-in Preview flow uses `PREVIEW_PAYMENT_MODE=sepay-test` with `PREVIEW_SEPAY_WEBHOOK_SECRET`, `PREVIEW_SEPAY_BANK_CODE`, `PREVIEW_SEPAY_BANK_ACCOUNT`, and optional `PREVIEW_SEPAY_ACCOUNT_NAME`. Values are server-side only. Webhooks are signature-verified, and the protected lifecycle runner can retry persisted events and fulfillment. Local and Preview synthetic tests do not represent provider sandbox verification.

SePay Live mode, Production webhooks/checkout, and real-money settlement are not implemented. Do not enable live checkout or send/receive actual money. See [SEPAY_SETUP.md](SEPAY_SETUP.md) for Test mode steps and [SEPAY_PRICING_AND_PROMOTIONS.md](SEPAY_PRICING_AND_PROMOTIONS.md) for the sourced pricing snapshot and eligibility caveats.

## Migration/rollback boundary

1. Vercel is the intended host; the custom domain is postponed. No deployment or rollback target is verified by this document.
2. Do not assume the legacy Cloudflare Worker/D1/R2 path is an available rollback target. The owner must separately approve any use of its Wrangler staging scripts.
3. Do not switch database or storage providers by changing a variable. Any future data transfer requires an owner-approved inventory, backup/restore test, reconciliation, and cutover plan.
4. Preserve migration history/checksums and record the reason, operator, and restore point for any later approved migration.
5. Production checkout and webhook settlement remain disabled. Preview Test mode is limited to the explicit, fully configured Preview gate; neither local tests nor Preview configuration establish Production readiness.

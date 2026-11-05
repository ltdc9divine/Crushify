# Hosting and Backend Migration

## Status and safety boundary

This is a staged migration guide, not a production deployment record.

- The Cloudflare Worker remains available with D1/R2 for rollback. A Vercel Node Functions catch-all now uses the shared API router with Turso and Cloudinary adapters.
- The shared SQL contract and Turso/libSQL adapter are implemented. The same API contract tests run against local Wrangler D1 and an ephemeral local Turso/libSQL file database; the migration CLI is tested locally.
- No remote Turso database has been connected, and no existing D1 data has been exported or imported.
- The Vercel adapter additionally passes the shared API contract over a local Node HTTP server using a local Turso file and in-memory media. It has not been deployed or tested on Vercel. Cloudinary HTTP is mock-tested only; no Cloudinary account, credentials, upload, or real-account compatibility check is configured.
- The local-only order/SePay webhook prototype is tested with generated HMAC secrets, synthetic prices and account fixtures against local D1 and Turso. It does not connect to SePay, collect money, activate prices, grant entitlements, publish designs, or support production. Vercel Preview/Production forcibly omit the payment settings.
- Phase 4 browser checks on 2026-11-05 covered the homepage and all five template paths at 1366×768, 1440×900, 390×844, and 375×812 through the local Worker/static server. All routes returned 200, had no horizontal overflow, and showed their canvas; Distance Means Nothing also showed its designed two-planet fallback with WebGL disabled. The unauthenticated Our Universe editor's `GET /customers/me` returns the expected 401 and presents sign-in. Vercel CLI is authenticated but this repository is not linked to a Vercel project, so `vercel dev` and Preview deployment were not run. Remote Turso and Cloudinary credentials and the remote-test safety flag are absent.
- The local rollback branch `backup/cloudflare-pre-turso-20261104` points to the pre-migration commit. It has not been pushed.

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

## Vercel Development and Hobby Preview

The Node Function at `api/[...path].ts` forwards HTTP requests to the shared `handleApiRequest` router. It buffers only bounded bodies, preserves multi-value `Set-Cookie`, imposes a 30-second request-body read timeout, supports only explicit methods, and keeps API responses private. Static root and `/templates/<id>/` paths are served directly by Vercel; no SPA fallback or API rewrite is configured. CORS preflight is limited to the exact configured `APP_ORIGIN` (or Vercel's deployment URL for a Preview if no override is set); credentialed requests never receive wildcard CORS.

Vercel Hobby is only for personal development, previews, and synthetic test data. Its terms and account eligibility must be checked before use; it must not be used for commercial sales, live checkout, or payment collection. The CLI account is authenticated, but this repository has no `.vercel` project link and no deployment was performed.

For Vercel local development:

1. Install/use Vercel CLI and create the ignored `.local` directory.
2. Copy `.env.example` to `.env.local` only if a user-owned `.env.local` does not already exist. The example uses `file:.local/crushify-vercel.db`, `STORAGE_PROVIDER=mock`, `LOCAL_TEST_MODE=true`, and `APP_ORIGIN=http://localhost:3000`.
3. Run `npm run db:migrate:turso` against that local file database, then run `vercel dev`. Local `mock` storage is accepted only with local test mode; do not deploy those values.
4. The Vercel function limit is set to 4 MiB for images, below Vercel's documented 4.5 MB function request/response payload limit; the Cloudflare Worker retains its existing 5 MiB limit. The create-upload response advertises the runtime's actual limit. See [Vercel Function limits](https://vercel.com/docs/functions/limitations#request-body-size).

For a Vercel Preview:

1. Use a dedicated, non-production Turso test database and a separate Cloudinary test account/folder; Vercel serverless filesystems are ephemeral and must not be used for persistent databases.
2. Set server-only `DATABASE_PROVIDER=turso`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `STORAGE_PROVIDER=cloudinary`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`.
3. Configure `APP_ORIGIN` to the exact preview origin if using a stable alias. Otherwise the adapter derives the deployment origin from Vercel's server-provided `VERCEL_URL`. Never use browser-visible prefixes such as `NEXT_PUBLIC_` or `VITE_`.
4. Keep `LOCAL_TEST_MODE` disabled in Preview/Production. Set an appropriate Resend test sender if magic-link email is required; the Cloudflare-only `MAILER` binding is not used by Vercel.
5. Do not add production customer data or enable checkout. The adapter does not pass payment mode or SePay secrets in Preview/Production. Cloudinary adapter behavior is not verified against a real account.

No `vercel.json` is required: conventional `api/` routing creates the function, and root static hosting preserves direct template paths without rewriting those routes to HTML.

## Turso/libSQL configuration

Required server-side variables:

- `DATABASE_PROVIDER=turso`
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN` (omit only for an isolated local `file:` database)

The migration command is:

```powershell
npm run db:migrate:turso
```

Before using a remote database:

1. Confirm the exact Turso organization/database and environment with the account owner.
2. Confirm whether it is empty. Do not infer this from repository config.
3. Back up the source and destination, verify the backup, and rehearse restoring into a separate test database.
4. Export/import existing D1 records only through a separately reviewed data migration; this CLI migrates schema only.
5. Apply migrations to a fresh or verified empty target, run `PRAGMA foreign_key_check`, and compare table/index/constraint inventories.
6. Store credentials in the selected host's secret manager and limit token scope/rotation. No remote credential or database has been provided for this stage.

For backups, use the currently supported Turso export/backup workflow for the account and version in use, store encrypted copies outside the repository, record retention/restore ownership, and perform a restore drill before launch. The repository does not yet automate or validate remote backup/restore.

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

**Current stage result:** only schema migrations and tests against disposable local databases have run. There is no importer, no remote export, no remote Turso connection, and no data movement.

## Database contract test results

The same API contract runner is used for local D1 integration and the local Turso/libSQL file test. It checks magic-link/session lifecycle, replay rejection, customer ownership, design create/read/update/reload, stale revision `409`, preview bearer access, asset metadata/storage/read/delete, and asset ownership. D1 integration additionally verifies unique/foreign-key rejection and uses a forced revision-write failure to verify that an update batch rolls back. Local Turso adapter tests also verify migrations/checksums, foreign-key and unique constraints, atomic batch rollback, `RETURNING`, insert metadata, and normalized/null parameters. Run `npm test` for the unit/adapter and Turso local-file tests; run `npm run test:integration` for D1/R2, the shared API contract, and D1 constraint/rollback coverage. No remote service is contacted by either test.

## Netlify production candidate

Netlify is only a candidate, not an approved production host. Before configuring it:

1. Verify current Netlify plan terms and account eligibility for the intended commercial template sales model.
2. Implement and test a Netlify Functions adapter that calls the shared API/business layer; do not duplicate business logic.
3. Configure static routes and function routing without changing template-owned HTML/CSS/JavaScript.
4. Add only production-candidate server-side Turso/Cloudinary/SePay secrets after separate security review. Do not activate live payments or publish customer designs as part of this database stage.
5. Confirm logs, limits, regional/data terms, rate limits, backups, restore, monitoring, and rollback ownership.

No `netlify.toml` or Netlify Function is added in this phase because routing and API adapters have not been implemented.

## Cloudinary

The server-side adapter is implemented for both the Cloudflare Worker and Vercel runtime. It uses signed authenticated image uploads, server-generated private IDs, bounded short-lived private downloads, and authenticated deletion. The API secret is never returned to the browser. Both runtimes proxy image bytes and retain the current API response shape.

To select Cloudinary for an isolated test environment, set these server-side values (never `VITE_*` or other browser-exposed variables):

- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`

Set `STORAGE_PROVIDER=cloudinary` and add the three credentials through the host's secret manager. Both Vercel and Worker runtime selectors fail closed if configuration is missing and do not fall back to R2. `.dev.vars.example` and Wrangler configs explicitly select R2; `.env.example` selects in-memory mock only for local Vercel development. Local Cloudinary adapter tests use mocked HTTP only. No account credentials were supplied, and no Cloudinary request, real upload, asset migration, or deployment has been run.

Do not switch an environment containing R2-backed asset rows by changing only the variable: storage providers do not share binaries. Plan and test a separate inventory/copy/verification/cutover procedure first. R2 remains available as the configured local/staging provider and rollback adapter; reverting after Cloudinary writes also requires transferring or otherwise reconciling those binaries. No implicit fallback is used.

Cloudinary currently advertises 25 monthly credits on its Free plan; credits are shared across managed storage, image bandwidth and transformations (the exact conversion and feature availability depend on current plan terms). This is not a guaranteed quota or commercial eligibility statement. Check the [current Cloudinary pricing and plan terms](https://cloudinary.com/pricing), authenticated-asset delivery features, account limits, regional/privacy terms, retention, and intended commercial use directly with Cloudinary before selecting it for production. Track credit usage and set upload quotas/alerts.

## SePay local prototype and production gate

The code currently supports only `PAYMENT_MODE=mock|sepay-test` in a local runtime with `LOCAL_TEST_MODE=true`. Server-only variables are `SEPAY_WEBHOOK_SECRET`, `SEPAY_BANK_CODE`, `SEPAY_BANK_ACCOUNT`, and `SEPAY_ACCOUNT_NAME`; no values belong in source control or browser variables. `sepay-test` constructs a VietQR image URL only when local Test mode bank settings exist. `mock` produces no QR. The migration adds an empty price catalog, not real prices.

Not implemented: SePay Live mode, production webhooks, admin reconciliation, refunds, scheduled retry/reconciliation jobs, entitlement, fulfillment, publication, custom deposit/balance payments, or price management UI. Do not enable live checkout or send/receive actual money. See [SEPAY_SETUP.md](SEPAY_SETUP.md) for Test mode steps and [SEPAY_PRICING_AND_PROMOTIONS.md](SEPAY_PRICING_AND_PROMOTIONS.md) for the sourced pricing snapshot and eligibility caveats.

## Rollback checklist

1. Keep Cloudflare Worker/D1/R2 configuration and migrations intact until a deliberate cutover is approved.
2. The current Worker continues to use the D1 adapter; no runtime switch to Turso has been made.
3. Keep `STORAGE_PROVIDER=r2` until a reviewed Cloudinary account test and an explicit asset migration/cutover plan are complete. Changing this variable alone is not rollback or migration.
4. If a later API-adapter release fails, route traffic back to the last verified Cloudflare Worker release. Do not delete or overwrite either database or storage.
5. If data has been written to both systems, pause writes and reconcile from a verified backup before choosing an authoritative copy. Do not perform an automatic reverse migration.
6. Preserve migration logs/checksums and record the reason, operator, and restore point.
7. Keep checkout/payment disabled outside local tests. Enable any future production purchase or publication only after a separate release review; no commercial flow is approved.

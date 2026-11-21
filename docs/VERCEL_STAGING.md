# Crushify staging environment

## Environment separation

- **Vercel Preview** is the intended staging deployment scope. Configure it with `ENVIRONMENT=staging` and staging-prefixed credentials only. The runtime requires the current deployment's `VERCEL_URL`; it never falls back to `VERCEL_PROJECT_PRODUCTION_URL`. If `APP_ORIGIN` is set, it must exactly match that Preview deployment origin. Do not attach staging to the production domain.
- **Vercel Production** is reserved for production application configuration. Never use its environment pull, database URL/token, or storage credentials for staging operations. Production must not contain `TURSO_STAGING_TARGET`, `TURSO_CONFIRM_DATABASE`, `TURSO_CONFIRM_GROUP`, `TURSO_CONFIRM_REGION`, `TURSO_SMOKE_TEST`, or `CLOUDINARY_SMOKE_TEST`.
- Preview must explicitly set `ENVIRONMENT=staging`; its database runtime uses only `TURSO_STAGING_DATABASE_URL` and `TURSO_STAGING_AUTH_TOKEN`. It does not fall back to `TURSO_DATABASE_URL` or `TURSO_AUTH_TOKEN`. Production continues to use only the generic Turso variables and rejects a database hostname matching the staging database.
- Vercel runtime classification fails closed for missing or unknown `VERCEL_ENV` values and mismatched `ENVIRONMENT` markers. Production keeps its existing `APP_ORIGIN` / `VERCEL_PROJECT_PRODUCTION_URL` resolution, with malformed or conflicting origins rejected. Local Vercel development requires the trusted `VERCEL_ENV=development` signal; local database connections must use a file database.
- Both normal API requests and protected lifecycle handlers reject cross-scope database or Cloudinary credentials. Vercel Cron runs only against the Production deployment; Preview has a protected manual lifecycle route and no automatic Preview schedule.
- The Vercel runtime accepts the existing staging Turso hostname pattern `crushify-staging[optional-suffix].turso.io` and one exact Preview hostname: `crushify-preview-crushify.aws-ap-southeast-1.turso.io`. It does not accept arbitrary `*.turso.io` hosts. The exact Preview hostname is classified as staging and rejected if supplied through Production database configuration. This is a hostname allowlist only; it does not verify database ownership, group, region, account, or token scope.
- The owner-reported Preview Turso identity is database `crushify-preview`, group `crushify-preview`, region `Singapore`, hostname `crushify-preview-crushify.aws-ap-southeast-1.turso.io`. The migration validator checks these exact name/group/region values and allows only this exact hostname. This is the supplied identity, not independent provider verification.
- Runtime hostname validation and migration validation are separate. Runtime retains its staging hostname rule plus the exact Preview hostname above. Migration tooling is restricted to that one Preview hostname and exact identity confirmations; it does not accept arbitrary `*.turso.io` hosts. These checks do not prove provider account ownership, database ID, token scope, or separation from Production. No migration has been run, and the remote database identity and ledger have not been independently verified.
- Cloudinary remains disabled in local development and the legacy Cloudflare Worker. The opt-in Vercel Preview flow can use only dedicated staging credentials (`CLOUDINARY_STAGING_*`) plus a distinct configured Production cloud name; this comparison does not prove account ownership, which the owner must verify independently. `STORAGE_PROVIDER=mock` is not instantiated in Preview and no fallback occurs. The legacy Worker rejects staging requests and staging scheduled execution because its runtime cannot verify D1/R2 resource identity. The guarded Cloudinary smoke script refuses staging before adapter construction.
- Local migration scripts use `TURSO_STAGING_*` from a separate file stored outside this repository. The Cloudinary smoke script is intentionally blocked for staging. Local application tests use `STORAGE_PROVIDER=mock` with in-memory storage and do not require Cloudinary credentials. Mock storage is for local/test use only. Preview uploads fail closed unless the opt-in customer flow is enabled with dedicated durable Cloudinary credentials; remote storage has not been verified. The `npm run dev` Worker script explicitly sets `ENVIRONMENT=local` and uses Wrangler local bindings; Worker local requests are accepted only on loopback origins.
- Local staging migration commands require `CRUSHIFY_STAGING_PROFILE=local`, `ENVIRONMENT=staging`, staging-specific Turso credentials, and exact database/group/region/hostname confirmations. They reject Production credentials and conflicting Vercel deployment scopes. Migrations additionally require `TURSO_MIGRATE_CONFIRM=I_CONFIRM_APPLY_STAGING_MIGRATIONS`; smoke tests require explicit synthetic-data opt-in.
- The Vercel Cron in `vercel.json` targets the Production deployment. `GET /api/cron/publication-lifecycle` accepts only the matching Production runtime and remains bearer-token protected. Preview has no automatic lifecycle schedule.
- A separate `POST /api/ops/staging/publication-lifecycle` is authorized only when trusted runtime classification is exactly Vercel Preview/staging. It requires a bearer `STAGING_LIFECYCLE_SECRET` consisting of exactly 64 hexadecimal characters; `CRON_SECRET` alone is never accepted. With the opt-in Preview flow fully configured, it runs bounded lifecycle, upload/derivative cleanup, pending SePay webhook recovery, and fulfillment recovery. It accepts no body or query parameters. The removed generic `/api/ops/staging` mutation route remains unavailable.
- Generate `STAGING_LIFECYCLE_SECRET` independently from Production secrets (for example, a cryptographically random 32-byte value encoded as hex) and configure it only in Vercel's Preview environment. Do not copy Production `CRON_SECRET` or reuse its value. Its current presence and deployed route behavior have not been verified. Local synthetic tests exercise authentication, scope rejection, expiry, retry, and cleanup; no deployed lifecycle operation was run.

### Preview authentication gate

- Production authentication remains enabled, and explicitly local Vercel development keeps its existing synthetic/local email flow. Vercel Preview maps through the trusted runtime classifier to `ENVIRONMENT=staging`; deployment scope is not inferred from request-controlled values.
- Preview authentication is disabled by default. Setting `PREVIEW_CUSTOMER_FLOW_ENABLED=true` opts into the customer flow only after the runtime validates the exact-email allowlist, isolated Turso, dedicated Cloudinary, Preview mail mode, exactly one payment mode, and lifecycle secret. An incomplete or conflicting configuration fails closed.
- The Preview allowlist is `PREVIEW_AUTH_ALLOWED_EMAILS`; unlisted recipients receive the same generic response without database, email, or token-generation side effects. Sign-in tokens remain one-time and expire after 15 minutes. Preview cookies are Secure. Production session cookies do not authenticate Preview.
- Preview can explicitly discard mail with `PREVIEW_EMAIL_SINK=discard`, or deliver through a dedicated `PREVIEW_MAIL_PROVIDER=resend`, `PREVIEW_MAIL_API_KEY`, and `PREVIEW_MAIL_FROM_EMAIL` configuration. The modes are mutually exclusive. Production `MAIL_*` values are rejected in Preview; Preview-specific mail values are rejected in Production. Delivery is restricted to `PREVIEW_AUTH_ALLOWED_EMAILS`, and administrators must additionally match `ADMIN_EMAILS`.
- `PREVIEW_TEST_EMAIL_SINK` is an injected test callback, not a Vercel variable. It captures synthetic messages only in tests. Preview Resend credentials and actual delivery have not been remotely configured or verified.
- No separate signup, password recovery, OAuth, session renewal, or admin-authentication implementation is present. Verify locally with `node --experimental-strip-types --test tests/auth-environment.test.ts`; this does not verify Resend delivery or deployed Preview behavior.

### Public Guest Preview

The five template editors support an explicit `?guest=1` mode for static
sample-based exploration. It keeps edits in page memory, skips publication and
customer-editor initialization APIs, disables server save/share/order actions,
and does not create drafts, sessions, uploads, or database records. Local image
previews use temporary browser object URLs that are revoked after decoding.
Closing or resetting the page discards guest edits.

Guest Preview does not repair or bypass the Preview runtime configuration
guard. Authenticated customer flows still require the isolated Preview
database, migrations, dedicated storage, email mode and allowlist, one chosen
Preview payment mode, lifecycle secret, and matching deployment origin
described above. Keep `PREVIEW_CUSTOMER_FLOW_ENABLED` disabled until those
requirements are independently verified and configured; no Vercel settings or
remote resources are changed by Guest Preview.

The homepage may render its verified public template names, descriptions, and
approved prices from `shared/catalog-pricing.js` when `/api/v1/catalog` is
unavailable. The fallback is display-only, keeps checkout disabled, and is
regression-tested against `src/product-catalog.ts`; it does not change the
runtime guard or make customer APIs public. The Preview request-wide guard can
return `RUNTIME_CONFIGURATION_ERROR` before the catalog route runs.

Vercel's injected feedback overlay may emit CSP-blocked console warnings in
Preview. Do not weaken Crushify's CSP for that overlay; change policy only if
an actual Crushify application resource is confirmed blocked.

### Payment isolation

- The payment policy uses trusted Vercel runtime classification. Preview defaults to disabled. It selects SePay Test mode only with `PREVIEW_PAYMENT_MODE=sepay-test` and the complete SePay configuration, or manual bank transfer only with `PREVIEW_PAYMENT_MODE=manual-bank-transfer` and a complete separate manual bank-details tuple. Both require the rest of the Preview customer-flow configuration. Otherwise checkout and fulfillment remain disabled. Production checkout and settlement remain disabled.
- Preview accepts mode-specific `PREVIEW_SEPAY_*` or `PREVIEW_MANUAL_BANK_*` settings; the two modes cannot be combined, and generic `PAYMENT_MODE`/`SEPAY_*` values are rejected. SePay requires a signed webhook. Manual transfer requires an allowlisted admin, CSRF, the exact order amount and a unique optional transaction reference; the operator must verify funds in the bank independently. Neither mode has a public mark-paid bypass.
- The protected Preview lifecycle operation retries persisted signed webhook events and pending fulfillment, in bounded batches. This is manual in Preview; Vercel Cron is Production-only. Local regression tests verify the recovery runner's policy and persisted-event handling, not a SePay sandbox transaction.
- SePay Live and Production checkout remain unimplemented/disabled. Do not infer that Production payment is available or configure Live payment credentials.

## Configuration inventory (status NOT VERIFIED)

This is a documentation inventory, not evidence of current settings. No Vercel settings or values were accessed or changed for this update; current project linkage, variable presence, and deployment state are **NOT VERIFIED**.

| Service | Required configuration | Current status | Action |
|---|---|---|---|
| Vercel | Linked project, Preview environment, protected deployments | Not inspected during this implementation; deployment status and current variables are **UNKNOWN**. | Owner confirms project linkage/protection and checks current values in the dashboard without copying Production secrets. |
| Turso | `DATABASE_PROVIDER`, `TURSO_STAGING_DATABASE_URL`, `TURSO_STAGING_AUTH_TOKEN` in Preview; dedicated DB and database-scoped token | Remote account/database identity and variable presence were not checked; status is **UNKNOWN**. | Verify dedicated database, account, plan, identity/location, and separation from Production; approve remote migration separately. |
| Storage | Production `CLOUDINARY_*`; Preview `CLOUDINARY_STAGING_*` plus `CLOUDINARY_PRODUCTION_CLOUD_NAME` when the opt-in flow is enabled | No Cloudinary account or Preview storage request was verified. | Create and independently verify a separate staging account/cloud and credentials; do not use Production keys. |
| Application | `ENVIRONMENT=staging`, Vercel-provided `VERCEL_URL`; optional matching `APP_ORIGIN` | No deployed Preview configuration was checked. | Set exact runtime marker and keep `APP_ORIGIN` unset or equal to the deployment origin. |
| Email/magic links | Choose `PREVIEW_EMAIL_SINK=discard` or the complete `PREVIEW_MAIL_*` tuple; `PREVIEW_AUTH_ALLOWED_EMAILS` | Preview Resend requires a separately scoped key and verified sender. Tests use mocked HTTP/capture; no actual delivery was performed. | Keep Preview and Production credentials isolated and maintain a restricted exact-email allowlist. |
| Payment | Preview `PREVIEW_PAYMENT_MODE=sepay-test` with `PREVIEW_SEPAY_*`, or `manual-bank-transfer` with `PREVIEW_MANUAL_BANK_*` | Both paths are locally tested; no Preview transfer, SePay sandbox account, or transaction was used. | Choose one mode. For manual transfer, verify the receiving account and have an authorized admin check actual funds before confirming. Do not copy Live settings or describe manual confirmation as automatic payment. |
| Lifecycle operator | Production `CRON_SECRET`; Preview `STAGING_LIFECYCLE_SECRET` | Source provides a daily Production Cron and a protected manual Preview route; neither deployed invocation was verified. | Keep secrets independently generated and scoped. Preview has no automatic Cron. |

Historical Vercel CLI, deployment, and environment observations are not current configuration evidence. Vercel project linkage, deployment status, plan eligibility, and environment-variable presence are **NOT VERIFIED** by this documentation update. Do not copy deployment aliases, local credential metadata, or secret-presence observations from historical notes into release material. Current source supports Preview authentication, Cloudinary media, and either SePay Test or manual bank transfer only through the complete opt-in configuration described here and in [SETUP-API-CREDENTIALS.md](SETUP-API-CREDENTIALS.md). `STORAGE_PROVIDER=mock` is not available in Preview. Remote Turso migrations and all provider operations remain owner-gated and were not performed.

### Cloudinary Preview configuration

The opt-in Preview flow supports the normal Cloudinary adapter only when
`STORAGE_PROVIDER=cloudinary` and all of `CLOUDINARY_STAGING_CLOUD_NAME`,
`CLOUDINARY_STAGING_API_KEY`, and `CLOUDINARY_STAGING_API_SECRET` are present.
It also requires `CLOUDINARY_PRODUCTION_CLOUD_NAME` and rejects a matching
cloud name. Production Cloudinary API credentials are rejected in Preview;
local mock storage is not used as a fallback.

This runtime check is a guard against accidental same-cloud configuration,
not proof of account ownership. Before adding credentials to Vercel Preview,
the owner must verify directly in Cloudinary Console that the staging account
and credential provenance are separate from Production, then have the
separation reviewed. Configure only in Vercel Preview. No Cloudinary account,
upload, deletion, retrieval, derivative operation, durability, or deployed
isolation test was performed during this implementation. Do not run the
Cloudinary staging smoke script: it intentionally refuses staging.

### Credential rotation and least privilege

- Previously shared Turso tokens are compromised and must not be reused. An authorized owner should rotate/revoke affected tokens only after determining what active environment still depends on them.
- Only after account/plan and database existence are verified, consider a dedicated `crushify-staging` database if it does not already exist and the account remains free. It must have its own **database-scoped auth token**, separate from Production. Do not use a Turso Platform API token.
- Do not create or use Cloudinary credentials for staging while only the potentially-Production cloud is available. A separate free account dedicated to staging is a future option requiring owner approval and separate credentials.
- Populate Vercel **Preview** variables through the Vercel dashboard or approved secret manager. Do not use Production `env pull`, copy Production values, or store secrets in Git-tracked files.
- Do not use local OIDC or other local authentication metadata as a deployment credential. Any such credential's presence, purpose, scope, and validity are **NOT VERIFIED** here; the owner must verify it through the approved credential-management workflow without copying it into documentation.

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
TURSO_CONFIRM_DATABASE=crushify-preview
TURSO_CONFIRM_GROUP=crushify-preview
TURSO_CONFIRM_REGION=Singapore
TURSO_CONFIRM_HOSTNAME=crushify-preview-crushify.aws-ap-southeast-1.turso.io
STORAGE_PROVIDER=mock
```

`TURSO_CONFIRM_HOSTNAME` must exactly match the hostname in
`TURSO_STAGING_DATABASE_URL`. The migration validator also checks it against
the single allowlisted Preview hostname and the fixed database/group/region
values. These checks do not prove Turso account ownership, database ID, token
scope, or separation from Production. An authorized owner must independently
verify those facts before any remote connection or migration.

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

Each migration version commits in its own transaction. If a later migration
fails, earlier versions may already be committed; the runner provides no
automatic rollback or restore. Before running `--migrate`, the owner must
verify an independent backup/restore path and document a recovery plan. The
repository does not implement that backup/restore procedure.

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
- The Turso scripts require explicit database, group, region, provider, and hostname confirmations. Error messages do not include URLs or tokens. Any historical candidate target or local tooling observations are not current verification; target identity and separation from Production are **NOT VERIFIED**.
- Staging database scripts use only `TURSO_STAGING_*` credentials. The Cloudinary staging smoke script fails before adapter construction and does not fall back to production credentials.
- `npm run db:apply:staging` and `npm run deploy:staging` are legacy Wrangler commands targeting Cloudflare D1/Worker resources, not the Vercel Preview path. They remain callable and have no explicit confirmation gate. Cloudflare staging is not an approved deployment path; do not execute either command without separate owner approval. The guarded Turso scripts are a distinct path and do not gate these Wrangler commands.
- Cloudinary staging is available to the opt-in Preview flow only with dedicated staging credentials and a distinct configured Production cloud name. Owner verification of account identity is still required; no remote asset operations were performed.
- `vercel.json` declares one daily publication lifecycle Cron route with a Production runtime guard. It does not declare a Preview Cron. No deployed schedule or invocation is verified. The Cloudflare Worker Cron triggers are disabled in source.
- The app's in-memory `MemoryStorageAdapter` supports local API/integration tests only. Vercel Preview does not construct it. With the opt-in gate disabled, authenticated/customer media operations remain unavailable; with it enabled and complete isolated provider configuration, Preview maps to staging Cloudinary, Resend, and SePay Test mode. The protected manual lifecycle route can recover pending SePay webhook events and fulfillment; no Preview Cron is configured. Remote configuration and deployment behavior have not been verified.
- Local tests and a successful environment-file parse do not prove remote connectivity. No remote migration, CRUD operation, or Cloudinary upload should be reported as successful until the corresponding remote smoke script actually completes.

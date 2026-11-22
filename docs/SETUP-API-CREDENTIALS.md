# API integration and credential setup

This is an owner-operated checklist for local development, Preview, and any later Production release. It lists configuration names used by the current source; it does not mean an account, credential, deployment, or provider call has been verified. No credential values belong in this document, source control, browser variables, chat, or terminal output.

## What is and is not integrated

| Service | Current integration | Credential/setup requirement |
|---|---|---|
| Turso/libSQL | Used by the Vercel API adapter; local Vercel development can use a `file:` database. | Separate Turso databases and tokens are owner-provisioned for Preview and Production. |
| Cloudinary | Server-side private media adapter for Production and explicitly enabled Preview with dedicated staging credentials. | Separate Preview cloud/account and credentials are mandatory; no remote account or upload was verified. |
| Resend | Server-side sign-in email adapter in Production and explicitly enabled Preview. | Verified sender/domain and environment-specific API keys are mandatory; no real email was sent. |
| SePay | Local mock/Test-mode flows and explicitly enabled Preview SePay Test mode. | Preview requires Test-mode webhook and bank configuration. No provider sandbox transaction was run. SePay Live checkout/payment processing is not implemented. |
| Admin operations | Existing magic-link sessions plus a server-side exact-email `ADMIN_EMAILS` allowlist. | Configure the list separately in each server environment; Preview admins must also be in `PREVIEW_AUTH_ALLOWED_EMAILS`. This model has no MFA. The list is not a credential and must never be embedded in browser code. |
| VietQR | QR image URL is generated for local SePay Test mode instructions; it is not a SePay checkout API. | No API key is currently used. The remote QR image service has not been validated as a production dependency. |
| Vercel Cron | Daily Production lifecycle route is declared in `vercel.json`; it invokes bounded fulfillment and pending SePay webhook recovery when payment policy permits. | Vercel project/deployment plus `CRON_SECRET`; actual Cron execution is unverified. Preview has a protected manual lifecycle route, not a Preview Cron. |
| Cloudflare D1/R2 | Retained Worker compatibility/local test path. | Not required for the intended Vercel hosting path. |
| Google Fonts / Three.js CDNs | Public browser-loaded assets used by templates. | No account credentials. Browser access to those public CDNs is required for the relevant template assets. |

## Local development (no external credentials)

Requirements: Node.js 22.6 or newer and npm. Local mode uses synthetic data, mock storage, and a local SQLite file. It does not need Turso, Cloudinary, Resend, or SePay credentials.

1. Keep any existing `.env.local` and `.dev.vars` unchanged. If a file does not exist, copy its example:

   ```powershell
   if (-not (Test-Path .env.local)) { Copy-Item .env.example .env.local }
   if (-not (Test-Path .dev.vars)) { Copy-Item .dev.vars.example .dev.vars }
   ```

2. For interactive sign-in, run `npm run dev:email-sink` in a separate terminal. It binds only to `127.0.0.1`, stores at most 25 messages in memory, displays only loopback sign-in links, and sends no email. Set `LOCAL_TEST_MAIL_SINK_URL` in the ignored local config to the printed loopback sink URL. Open the inbox URL in a browser and refresh after requesting a link. Stop the process to discard captured links.
3. For Vercel local development, use only the sample local `file:` database and mock settings. Apply migrations with:

   ```powershell
   node --env-file=.env.local --experimental-strip-types scripts/migrate-turso.ts
   npx vercel dev
   ```

   The migration program rejects non-file database URLs and non-empty auth tokens. Do not point it at a remote database. Keep `APP_ORIGIN` aligned with Vercel Dev's actual local host/port (default `http://localhost:3000`). For the Cloudflare Worker local path, run `npm run db:apply:local` and `npm run dev`.
4. `PAYMENT_MODE=mock` is a local prototype; it creates no QR and has no public “mark paid” action. `npm run test:integration` exercises a synthetic signed webhook and fulfillment in an isolated disposable D1 database. It generates its secret in memory and makes no SePay or bank request.
5. Local validation commands are `npm test`, `npm run typecheck`, `npm run test:integration`, and `git diff --check`. These do not validate remote accounts, provider delivery, or deployed behavior.

The optional `ADMIN_EMAILS` variable is a comma-separated list of exact email addresses authorized for `/admin/`. Leave it blank to keep admin APIs disabled. It is checked server-side on every request and requires an active magic-link session plus CSRF verification for mutations. In Preview, an admin must also be in `PREVIEW_AUTH_ALLOWED_EMAILS`. Do not add real email addresses to the example files or browser assets.

Never copy production credentials into local files. `.env.local`, `.dev.vars`, local databases, and generated sign-in links are private local state; do not commit or share them.

## Vercel Preview — isolated customer-flow setup

Source supports an opt-in Preview customer journey, but it is **disabled until every required Preview value is configured**. The feature gate fails closed on incomplete or cross-environment configuration. Local test code uses synthetic SQLite, in-memory storage, and an injected email sink; it does not verify a Preview deployment, remote database, real email, Cloudinary account, or SePay Sandbox operation. See [FINAL-API-HANDOFF.md](FINAL-API-HANDOFF.md) for the current release checklist and migration checksums.

Before enabling it, the owner must create a dedicated Preview Turso database, an isolated Preview Resend account/key if real Preview sign-in delivery is needed, and a SePay Test-mode webhook/bank setup. Cloudinary staging account/cloud credentials are required only when Preview asset uploads are explicitly enabled. Do not reuse Production secrets, databases, storage, sender keys, or Live payment settings.

In Vercel **Project → Settings → Environment Variables**, scope the following to **Preview only**. Vercel supplies `VERCEL_ENV=preview` and the deployment URL; do not override those values.

| Provider / variable | Required? | Where to create/find it and handling |
|---|---|---|
| Vercel: `ENVIRONMENT=staging` | Mandatory | Vercel Project Settings → Environment Variables. Runtime classification must agree with the Vercel Preview deployment. Vercel supplies `VERCEL_BRANCH_URL`; the customer-flow opt-in requires it and uses it as the stable canonical Preview origin. |
| Turso: `DATABASE_PROVIDER=turso` | Mandatory | Vercel Preview variables. |
| Turso: `TURSO_STAGING_DATABASE_URL`, `TURSO_STAGING_AUTH_TOKEN` | Mandatory; both Preview-only | In the Turso organization console, create/select a dedicated non-production database and create a database-scoped auth token. Keep separate from `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` in Production. Enter only into Vercel's Preview environment. |
| Application: `PREVIEW_CUSTOMER_FLOW_ENABLED=true` | Mandatory opt-in | Vercel Preview variable. This enables guarded customer APIs only when all required integrations validate. |
| Application: `PREVIEW_AUTH_ALLOWED_EMAILS` | Mandatory | Comma-separated exact tester email addresses. Only these recipients may request Preview sign-in links; do not use a public wildcard or unrestricted list. This is configuration, not a credential. |
| Application: `PREVIEW_ASSET_UPLOADS_ENABLED=true` | Optional; default false | Enable only for a separate Preview media-upload test. Leave unset or set exactly `false` for the no-storage customer-flow and SePay Test-mode journey. |
| Cloudinary: `STORAGE_PROVIDER=cloudinary` | Required only when `PREVIEW_ASSET_UPLOADS_ENABLED=true` | Vercel Preview variable. Do not set a storage provider while uploads are disabled unless the application is also fully validated for Cloudinary. |
| Cloudinary: `CLOUDINARY_STAGING_CLOUD_NAME`, `CLOUDINARY_STAGING_API_KEY`, `CLOUDINARY_STAGING_API_SECRET` | Required only for enabled Preview uploads; all from a separate staging Cloudinary account | Create/find credentials in that staging account's Cloudinary Console → Settings / API Keys. Never reuse Production API key/secret. |
| Cloudinary: `CLOUDINARY_PRODUCTION_CLOUD_NAME` | Required only for enabled Preview uploads; comparison value, not a secret | Distinct Production Cloudinary cloud name, entered as a name only to reject accidental same-cloud configuration. Do not place Production API credentials in Preview. |
| Preview discard: `PREVIEW_EMAIL_SINK=discard` | Only while customer authentication is disabled | Magic-link messages are discarded. The runtime rejects this setting together with `PREVIEW_CUSTOMER_FLOW_ENABLED=true`; it cannot support a browser customer-flow test. |
| Preview Resend: `PREVIEW_MAIL_PROVIDER=resend`, `PREVIEW_MAIL_API_KEY`, `PREVIEW_MAIL_FROM_EMAIL` | Mandatory for the Preview customer-flow opt-in | Configure Preview scope only, with a Preview-dedicated Resend key and verified sender. Keep `PREVIEW_EMAIL_SINK` unset. Recipients are restricted to `PREVIEW_AUTH_ALLOWED_EMAILS`; a Preview administrator must also appear in `ADMIN_EMAILS`. Invalid or partial settings fail closed. |
| Local test capture: `PREVIEW_TEST_EMAIL_SINK` | Test harness only; not a Vercel setting | Injected callback captures synthetic sign-in messages in tests. The local Vercel development inbox uses `LOCAL_TEST_MAIL_SINK_URL`. Neither path contacts Resend. |
| SePay: `PREVIEW_PAYMENT_MODE=sepay-test` | Mandatory | Vercel Preview variable; selects only the Test-mode payment policy. |
| SePay: `PREVIEW_SEPAY_WEBHOOK_SECRET`, `PREVIEW_SEPAY_BANK_CODE`, `PREVIEW_SEPAY_BANK_ACCOUNT` | Mandatory; Test mode only | Obtain from the SePay Test-mode account/webhook and bank configuration. Configure the provider's webhook URL to the deployed Preview payment webhook and use the supported signed-webhook configuration. Keep any Live-mode credentials/settings separate and out of Preview. |
| SePay: `PREVIEW_SEPAY_ACCOUNT_NAME` | Optional | Test-mode account name for payment instructions, if supplied by SePay. |
| Lifecycle operator: `STAGING_LIFECYCLE_SECRET` | Mandatory for enabling the customer-flow gate | Generate a distinct 32-byte random value encoded as 64 hex characters; store only in Vercel Preview. Never reuse Production `CRON_SECRET`. Authorizes the protected manual Preview lifecycle endpoint. |
| SePay API reconciliation: `PREVIEW_SEPAY_RECONCILIATION_ENABLED` | Optional; must be exactly `true` to enable manual scans | Preview-only observation feature gate. Do not set until Sandbox account/resource separation and local readiness review are approved. |
| SePay API reconciliation: `PREVIEW_SEPAY_API_TOKEN` | Required when reconciliation is enabled | Server-only SePay Sandbox API token; the runtime uses a fixed Sandbox origin and rejects generic/Production API configuration. Never expose this variable to browser bundles. |
| SePay API reconciliation: `PREVIEW_SEPAY_API_BANK_ACCOUNT_ID` | Required when reconciliation is enabled | UUID of the dedicated Sandbox bank account; this is not the receiving account number used by the webhook flow. |
| SePay API reconciliation: `PREVIEW_SEPAY_RECONCILIATION_SECRET` | Required when reconciliation is enabled | Distinct 32-byte random operator secret encoded as 64 hex characters. It authorizes the manual trigger and must not be shared with `STAGING_LIFECYCLE_SECRET` or `CRON_SECRET`. |
| SePay API reconciliation: `PREVIEW_SEPAY_RECONCILIATION_START_AT` | Required when reconciliation is enabled | Canonical UTC timestamp; initial scan may cover no more than 31 days. Subsequent scans use the durable overlap cursor. |
| Application: `APP_ORIGIN` | Optional | Leave unset to use Vercel's `VERCEL_BRANCH_URL` for the stable branch origin, or set only to that exact HTTPS origin. `VERCEL_URL` is a deployment-specific fallback for non-customer-flow Preview; the customer-flow opt-in requires `VERCEL_BRANCH_URL`. |

Do **not** set generic Production variables (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `MAIL_PROVIDER`, `MAIL_API_KEY`, `MAIL_FROM_EMAIL`, `PAYMENT_MODE`, or `SEPAY_*`) in Preview. For an end-to-end customer-flow test, use the dedicated Preview Resend tuple; discard mode intentionally prevents sign-in. Never combine Preview and Production credentials. Do not configure `LOCAL_TEST_*` in Preview.

After provider accounts and credentials are ready, review the exact database target and obtain owner approval before the remote Turso preflight or migration. The guarded commands are documented in [VERCEL_STAGING.md](VERCEL_STAGING.md); they were not run for this task. The SePay API reconciliation endpoint is `POST /api/ops/staging/sepay-reconciliation`; it accepts no query or request body, is Preview-only, and requires `Authorization: Bearer <operator secret>`. It is manually triggered only; no SePay scan Cron exists. Each call is bounded to four pages of up to 100 transactions, a 120-second database lease, 4-second provider request timeout, one retry, and 60-second Vercel function maximum duration. Results are completed, partial, failed, or skipped when a lease is held. A successful local test does not verify remote account identity, provider delivery, billing, or deployed Preview behavior. API observations cannot settle payments or authorize fulfillment/publication; settlement remains signed-webhook-only.

### Provider and hosting caveats

- **Vercel:** Current plan eligibility for the intended hosting and any commercial use is **NOT VERIFIED**. The owner must check current terms and project eligibility before deployment or commercial activity. No plan change or purchase is authorized here.
- **Turso:** an account and isolated database are required for hosted use. Review current plan, capacity, region, backup, and commercial terms with Turso. Current remote database/configuration status is **NOT VERIFIED**.
- **Cloudinary:** a separate staging account/cloud and credentials are required. Review current pricing/credit limits, private-asset delivery features, data region, and commercial terms with Cloudinary. No storage request was made.
- **Resend:** Production sign-in uses `MAIL_PROVIDER`, `MAIL_API_KEY`, and `MAIL_FROM_EMAIL`. Preview can use only `PREVIEW_MAIL_PROVIDER`, `PREVIEW_MAIL_API_KEY`, and `PREVIEW_MAIL_FROM_EMAIL`, or explicitly discard mail. Keep Vercel values in their matching environment scopes. No real email or provider configuration was verified.
- **SePay:** use Test mode only. No real-money settlement or SePay Live configuration is enabled. Confirm Test-mode availability and webhook setup with the provider; no sandbox transaction was performed.

## Production — only after a separate release approval

Do not configure or enable Production through this checklist. First obtain the required commercial/hosting approval, review the release architecture, and test the exact production configuration in an isolated environment. The current source deliberately rejects local payment settings and does not implement a Live checkout flow.

The current adapters expect the following **server-side Production** settings when their respective capabilities are later approved:

| Capability | Exact variable names | Owner setup |
|---|---|---|
| Database | Mandatory: `DATABASE_PROVIDER=turso`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Provision a Production-only database and database-scoped token in Turso. Do not reuse the Preview database/token. Enter in Vercel Project Settings → Environment Variables, Production scope only. |
| Media storage | Mandatory when enabling customer media: `STORAGE_PROVIDER=cloudinary`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Use a Production Cloudinary account and API key/secret from its Console → Settings / API Keys. Do not reuse Preview credentials. Production adapter code exists; no real-account request was made. |
| Sign-in email | Mandatory when enabling customer sign-in: `MAIL_PROVIDER=resend`, `MAIL_API_KEY`, `MAIL_FROM_EMAIL` | Verify sender/domain in Resend and create a Production-scoped API key. Enter in Vercel Production scope only. No real email was sent. |
| Scheduled lifecycle | Mandatory for the configured Production Cron: `CRON_SECRET` | Generate a high-entropy server-only secret in an approved secret manager; source requires at least 32 characters. Add to Vercel Production scope. Verify first Cron execution only through an approved release. |
| Canonical URL | Optional: `APP_ORIGIN` | If set, use the exact Production origin for CORS and CSRF checks; otherwise Vercel's Production URL is used. |

Use Vercel **Settings → Environment Variables**, scope each value only to the intended environment, mark credentials sensitive, and create a new deployment after approved changes. Never prefix credentials with browser-exposed names such as `NEXT_PUBLIC_` or `VITE_`.

### Payments are not ready for Live credentials

Production checkout and webhook settlement are disabled by source policy, and the shared code has no SePay Live checkout/settlement implementation. Production recovery code is not proof of end-to-end fulfillment: publication mutations are disabled in Production. Do not add `PAYMENT_MODE` or `SEPAY_*` values to Vercel Production. Production configuration and deployment are **NOT VERIFIED**. A future Live integration requires a separate design, code review, provider verification, operational/reconciliation plan, and explicit go-live approval.

## Owner action checklist

- [ ] Confirm Vercel account/project ownership, plan eligibility, and repository linkage.
- [ ] Create separate Preview and Production Turso databases and scope their tokens independently.
- [ ] Obtain review/approval before any remote migration; verify Preview migrations with the guarded preflight first.
- [ ] Before enabling Preview, create isolated Preview Cloudinary, Resend, and SePay Test-mode resources and set every mandatory Preview variable in the table above.
- [ ] Verify Preview account/resource separation with the owners and reviewers; local synthetic tests are not provider verification.
- [ ] Keep Production checkout and SePay Live disabled until a separate Live implementation, security review, operations/refunds, and settlement reconciliation are approved.
- [ ] After a separately approved release, configure the Cron secret and confirm the first scheduled invocation.
- [ ] Do not send secret values through chat, commit them, print them, or copy Production values into Preview/local.

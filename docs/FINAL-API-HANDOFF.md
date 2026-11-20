# Final API Configuration Handoff

## Status and deployment model

This is a placeholder-only owner checklist. No credentials are included here. No Vercel deployment, remote database connection or migration, provider connection, Sandbox transaction, or Production operation has been verified or performed.

Vercel serves the static site from the repository root and builds the TypeScript API functions from `api/`; `vercel.json` includes `migrations/**` with the catch-all API function. There is no separate application build script or `builds` override in `vercel.json`. Do not add a build step unless the deployment architecture changes. This local conclusion does not establish a successful Vercel deployment.

## Release manifest

The Vercel payload includes the following runtime files and recursive static trees:

| Purpose | Files |
|---|---|
| Vercel and runtime configuration | `vercel.json`, `package.json`, `package-lock.json`, `tsconfig.json` |
| API entry points | `api/v1.ts`, `api/[...path].ts`, `api/cron/publication-lifecycle.ts` |
| Server runtime | `src/admin.ts`, `src/assets.ts`, `src/auth.ts`, `src/custom-design.ts`, `src/database.ts`, `src/designs.ts`, `src/http.ts`, `src/image-normalizer.ts`, `src/index.ts`, `src/logging.ts`, `src/payments.ts`, `src/product-catalog.ts`, `src/publications.ts`, `src/scheduler.ts`, `src/security-headers.ts`, `src/storage-plans.ts`, `src/storage.ts`, `src/template-registry.ts`, `src/types.ts`, `src/universe.ts` |
| Database runtime | `src/database/d1.ts`, `src/database/migrations.ts`, `src/database/provider.ts`, `src/database/turso.ts` |
| Payment runtime | `src/payments/evidence.ts`, `src/payments/policy.ts`, `src/payments/provider.ts`, `src/payments/sepay-api-v2.ts`, `src/payments/sepay-reconciliation-policy.ts`, `src/payments/sepay-reconciliation.ts`, `src/payments/sepay.ts` |
| Platform and storage runtime | `src/platform/environment.ts`, `src/platform/node-image-normalizer.ts`, `src/platform/vercel.ts`, `src/storage/cloudinary-policy.ts`, `src/storage/cloudinary.ts`, `src/storage/mock.ts`, `src/storage/provider.ts`, `src/storage/r2.ts` |
| Homepage and customer pages | `index.html`, `css/style.css`, `js/main.js`, `js/particle-heart.js`, `admin/index.html`, `admin/admin.css`, `admin/admin.js`, `account/websites/index.html`, `account/websites/websites.css`, `account/websites/websites.js`, `checkout/index.html`, `checkout/checkout.css`, `checkout/checkout.js`, `custom-design/index.html`, `custom-design/custom-design.css`, `custom-design/custom-design.js` |
| Editor, publication, and shared runtime | `shared/customer-editor-data-url.js`, `shared/customer-editor.css`, `shared/customer-editor.js`, `shared/publication-bootstrap.css`, `shared/publication-bootstrap.js`, `p/index.html`, `p/publication.css`, `p/publication.js` |
| Template static pages and assets | All files recursively under `templates/our-universe/`, `templates/love-letter/`, `templates/our-memories/`, `templates/say-yes/`, and `templates/distance-means-nothing/` |
| Database release | The 24 ordered SQL files listed with SHA-256 checksums below. The API function's `includeFiles` setting must continue to include `migrations/**`. |

`.vercelignore` excludes local environment files and variable samples, `.agents/`, session state, docs, tests, scripts, local databases, logs, test output, Wrangler-only configuration, and unrelated Markdown. It does not exclude the API, source, migration, or static runtime trees. Review this ignore list whenever adding a runtime asset or changing Vercel's build process.

No separate production build is required by the current architecture: the static files are served directly and Vercel compiles the API TypeScript entry points. Tests verify the package/configuration claim and the presence of the principal deployable paths; they do not prove Vercel's remote build behavior.

## Migration release sequence

Apply migrations only to a separately approved, isolated Preview database after verifying its identity and authorization. The current checked-in sequence is contiguous from `0001` through `0024`. SHA-256 values below are for the current local files; the migration loader compares names and checksums and applies them in numerical order. Do not edit an applied migration or infer remote ledger state from these local hashes.

| Version | File | SHA-256 |
|---:|---|---|
| 0001 | `migrations/0001_initial_schema.sql` | `37974475cbcaaf4d0f82e818ccc66808e3095843c6af3ab34738326b9f5a3963` |
| 0002 | `migrations/0002_auth_previews_and_uploads.sql` | `aa76b1861fdeb48257a04225775c635cf4dfaa227df2682ef80039f7f96362f8` |
| 0003 | `migrations/0003_local_test_payments.sql` | `53e660dd76d78d282598af2f337e30b44d4dd604fe595d39cbc56843c1939da3` |
| 0004 | `migrations/0004_payment_webhook_recovery.sql` | `0f7701530fb44ae5651fe999c18d400f8c87056b9b6f086aacdd76acdd6620c4` |
| 0005 | `migrations/0005_publication_delivery.sql` | `c85cf4945347ea8d284d2543e80c13a0b79970d0328cce2256fbf7d1d26b4c75` |
| 0006 | `migrations/0006_storage_entitlements.sql` | `6a44bcf5ee4d1d9634d49c15c6ea87d8d0d91d18d0a915528f261f116b347000` |
| 0007 | `migrations/0007_love_letter_photos.sql` | `d0a2823fa38fe4bbcad7204a8cb76018b0f7673659e316c87f0eff591d4563be` |
| 0008 | `migrations/0008_scheduled_maintenance.sql` | `ecc9d2e1c98b0effb8cd61c2bb041b65f24b24d3acbff2bdb70fed54dddd1665` |
| 0009 | `migrations/0009_fulfillment_recovery_leases.sql` | `6325fec46e3c4d5330f97fa8a19f769051438c3ca90a811b205b301b3d85e25a` |
| 0010 | `migrations/0010_asset_upload_leases.sql` | `50bea1ad33d6f300e567b9de351e6991b4579529a7a228ed2ddcf937a612ecd7` |
| 0011 | `migrations/0011_asset_reference_and_upload_attempts.sql` | `3c98ce68a5bed2db0b88a63a7b926f20c2a124ded8585b7e196487a44852c113` |
| 0012 | `migrations/0012_lifecycle_retention_and_upload_recovery.sql` | `7078974888b7038439d98f8c355ea8a7761bf6b695292299730030cdc50a6798` |
| 0013 | `migrations/0013_publication_derivative_operations.sql` | `c74ef1dc1220b9314999eee17e87e75e71a8a6af252603479db75b951056f1a7` |
| 0014 | `migrations/0014_derivative_provider_success_reconciliation.sql` | `e0a3cdc6672241adee3df11f6bf7fd30b7e9ef98b00be72e1d9bbb5ee25fbd83` |
| 0015 | `migrations/0015_payment_settlement_evidence.sql` | `5e498cfc901c3b205aa865e894a3d3adc54c7a92a7981596b48c83ae33c5aed4` |
| 0016 | `migrations/0016_sepay_api_v2_reconciliation.sql` | `19cc2908d97cced4d5a94ce070778fa47ca45fb2f82d2b2ac96855b74641cafe` |
| 0017 | `migrations/0017_sepay_api_reconciliation_continuation.sql` | `418e57a5698e42201dab158e723d00852b8dea7d3d1d6f91c31f76f9b6313663` |
| 0018 | `migrations/0018_webhook_only_settlement_evidence.sql` | `f1b906bf12e30c5a4e0c8ecaf5b72b9d1c319d014fda42d303fbcb2f4e896935` |
| 0019 | `migrations/0019_custom_design_requests.sql` | `8ee7fd272953e25aaba888aeff0ac19eb714b8f77c82734ebb47561f7659c94f` |
| 0020 | `migrations/0020_custom_design_admin_review.sql` | `d05c3d7c0921f1c3faecb7fda758afef43dbd69c57c6418ff6f7f4dd6aa1d0f4` |
| 0021 | `migrations/0021_admin_activity_audit.sql` | `a68311d13e6532628ece129c409b9d771c2e617a8a831b0f0f9b5a7244b0fe5e` |
| 0022 | `migrations/0022_custom_design_customer_replies.sql` | `1d8625d50d2ea58f9bb815c5d50a6b179e2123e5282c97dc090d99f4162432c7` |
| 0023 | `migrations/0023_manual_bank_transfer_settlement.sql` | `8d9896000cd14f53f8ef9a74a72e2e9d644e7809ce3096a7486372ca9a1bf75f` |
| 0024 | `migrations/0024_manual_payment_activity_audit.sql` | `80683828a47b0f856c4589a83316e725154d0b1cc246dbb6a420d5e221ba031f` |

The staging-specific Turso preflight and migration commands are `npm run db:preflight:turso:staging` and `npm run db:migrate:turso:staging`. They are remote operations and were not run. Use them only after a separate owner approval, target-hostname verification, isolated database confirmation, backup/recovery review, and inspection of the remote migration ledger.

## Configuration inventory

Placeholders below are labels, not valid credentials. Configure server-side values in the matching Vercel environment only. Do not share secrets in chat, source, browser code, or terminal output.

| Variable | Type | Preview | Production |
|---|---|---|---|
| `ADMIN_EMAILS` | Non-secret allowlist | `<PREVIEW_ADMIN_EMAILS>`; exact normalized administrator emails, also included in Preview auth allowlist | `<PRODUCTION_ADMIN_EMAILS>`; exact administrator emails |
| `PREVIEW_AUTH_ALLOWED_EMAILS` | Non-secret allowlist | `<PREVIEW_TESTER_EMAILS>`; exact permitted test recipients | Not used |
| `ENVIRONMENT` | Normal config | `staging` | Production deployment classification; do not override Vercel environment inconsistently |
| `DATABASE_PROVIDER` | Normal config | `turso` | `turso` |
| `TURSO_STAGING_DATABASE_URL` / `TURSO_STAGING_AUTH_TOKEN` | URL / secret | `<ISOLATED_PREVIEW_DATABASE_URL>` / `<PREVIEW_DATABASE_TOKEN>` | Must not be set |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | URL / secret | Must not be set | `<PRODUCTION_DATABASE_URL>` / `<PRODUCTION_DATABASE_TOKEN>` |
| `STORAGE_PROVIDER` | Normal config | `cloudinary` | `cloudinary` only when approved for use |
| `CLOUDINARY_STAGING_CLOUD_NAME` / `CLOUDINARY_STAGING_API_KEY` / `CLOUDINARY_STAGING_API_SECRET` | Name / ID / secret | `<PREVIEW_CLOUD>` / `<PREVIEW_KEY>` / `<PREVIEW_SECRET>`; isolated account | Must not be set |
| `CLOUDINARY_PRODUCTION_CLOUD_NAME` | Name / non-secret comparison value | `<PRODUCTION_CLOUD_NAME>`; must differ from Preview cloud name; account ownership must be verified independently | Must not be set |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | Name / ID / secret | Must not be set | `<PRODUCTION_CLOUD>` / `<PRODUCTION_KEY>` / `<PRODUCTION_SECRET>` |
| `PREVIEW_EMAIL_SINK` | Feature flag | `discard` to disable Preview delivery; unset for dedicated Preview Resend | Must not be set |
| `PREVIEW_MAIL_PROVIDER` / `PREVIEW_MAIL_API_KEY` / `PREVIEW_MAIL_FROM_EMAIL` | Config / secret / sender | `resend` / `<PREVIEW_RESEND_KEY>` / `<VERIFIED_PREVIEW_SENDER>`; Preview-only, separate account/key | Must not be set |
| `MAIL_PROVIDER` / `MAIL_API_KEY` / `MAIL_FROM_EMAIL` | Config / secret / address | Must not be set | `resend` / `<PRODUCTION_RESEND_KEY>` / `<VERIFIED_PRODUCTION_SENDER>` |
| `PREVIEW_CUSTOMER_FLOW_ENABLED` | Feature flag | `true` only after isolated Preview configuration is verified | Must not be set |
| `PREVIEW_PAYMENT_MODE` | Normal config | `sepay-test` or `manual-bank-transfer` | Must not be set |
| `PREVIEW_SEPAY_WEBHOOK_SECRET` | Secret | `<SEPAY_TEST_WEBHOOK_SECRET>` | Must not be set |
| `PREVIEW_SEPAY_BANK_CODE` / `PREVIEW_SEPAY_BANK_ACCOUNT` | Normal config | `<TEST_BANK_CODE>` / `<TEST_RECEIVING_ACCOUNT>` | Must not be set |
| `PREVIEW_SEPAY_ACCOUNT_NAME` | Normal config | `<TEST_ACCOUNT_NAME>` | Must not be set |
| `PREVIEW_MANUAL_BANK_CODE` / `PREVIEW_MANUAL_BANK_ACCOUNT` / `PREVIEW_MANUAL_ACCOUNT_NAME` | Normal config | Set only for the separately opted-in manual-transfer mode; use verified Preview receiving-account details | Must not be set |
| `PREVIEW_SEPAY_RECONCILIATION_ENABLED` | Feature flag | Leave unset until separately reviewed and authorized | Must not be set |
| `PREVIEW_SEPAY_API_TOKEN` / `PREVIEW_SEPAY_API_BANK_ACCOUNT_ID` / `PREVIEW_SEPAY_RECONCILIATION_SECRET` / `PREVIEW_SEPAY_RECONCILIATION_START_AT` | Secret / ID / secret / timestamp | Do not configure until the observation-only Sandbox phase is separately approved | Must not be set |
| `STAGING_LIFECYCLE_SECRET` | Secret | `<PREVIEW_LIFECYCLE_SECRET>`; unique high-entropy value | Must not be set |
| `CRON_SECRET` | Secret | Must not be set | `<PRODUCTION_CRON_SECRET>`; unique high-entropy value |
| `APP_ORIGIN` | Normal config | `<PREVIEW_ORIGIN>` or unset for Vercel's deployment URL | `<PRODUCTION_ORIGIN>` or unset for Vercel's canonical URL |
| `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_PROJECT_PRODUCTION_URL` | Platform values | Supplied by Vercel; do not copy between environments | Supplied by Vercel |

Vercel project/runtime configuration:

- Scope all `PREVIEW_*`, `STAGING_*`, and `TURSO_STAGING_*` settings to Preview only.
- Scope Production database, Cloudinary, Resend, and Cron settings only to Production. Do not configure Production payment variables: Live checkout and settlement are not implemented.
- `ADMIN_EMAILS` must be set independently in each environment; an absent, empty, or invalid list disables admin authorization. Preview administrators must also pass `PREVIEW_AUTH_ALLOWED_EMAILS`.
- For Preview email, choose either `PREVIEW_EMAIL_SINK=discard` with all `PREVIEW_MAIL_*` variables unset, or the complete dedicated Preview Resend tuple with `PREVIEW_EMAIL_SINK` unset. Preview Resend recipients must be in `PREVIEW_AUTH_ALLOWED_EMAILS`; an administrator must also be in `ADMIN_EMAILS`. Never copy Production `MAIL_*` values into Preview.
- Mark tokens, API keys, webhook signing keys, and operator secrets as sensitive server-side variables. Never use public/browser prefixes.
- The Vercel cron declaration in `vercel.json` is daily. Its first hosted execution and plan eligibility remain unverified.

## Verification sequence after owner approval

1. Confirm ownership and terms for the Vercel project and each provider account. Create separate Preview resources and verify them in their provider consoles; do not infer isolation from different names.
2. Set only Preview variables above. Double-check that no generic Production credential or `SEPAY_*` Live setting is present in Preview.
3. Use the guarded Preview database preflight to verify the exact host and migration ledger. Review the proposed ordered migrations and hashes above. Obtain explicit owner authorization before applying any remote migration.
4. After the approved migration, deploy a Preview build and verify startup, sign-in restrictions, admin allowlist, private uploads/previews, and error handling. Confirm logs contain no tokens or personal data.
5. Configure the SePay Test-mode webhook to the Preview endpoint using the Test-mode signing secret and bank configuration. Verify delivery/signature and recovery only with synthetic/Test-mode activity. API v2 reconciliation, if separately authorized, is observation-only and must never settle or fulfill an order.
6. Confirm Preview isolation, migration ledger, webhook evidence, publication/expiry behavior, and recovery procedures before considering Production. Production requires a separate release approval, security/operations review, provider readiness, and a Live payment design; none is granted by this checklist.

No remote configuration, migration, provider connection, email delivery, webhook, Sandbox transaction, deployment, or Production operation has been verified by this handoff.

# ORDERS-2.33 — First Paid Order End-to-End Readiness Audit

**Final verdict: NOT READY — IMPLEMENTATION BLOCKERS**

This is a read-only launch-readiness audit. No application source, tests, migrations, provider settings, or deployment configuration were changed. No remote service was contacted, no real order/payment/publication was created, and no Production resource or secret value was accessed.

The local implementation has a standard five-template catalog, server-side price calculation, customer authentication, SePay webhook validation, and publication/expiry code. Local tests pass. That evidence does **not** make a real first sale safe: Production order creation and SePay settlement are deliberately disabled; Production database/storage/email configuration and applied migrations are unverified; paid-order recovery is not scheduled; and Production customer publication-management mutations are deliberately blocked.

## 1. Scope, evidence rules, and previous reports

Statuses below mean:

- **PASS** — source behavior and relevant local evidence were found.
- **PARTIAL** — source or local tests exist, but an important remote, operational, or end-to-end check is absent.
- **BLOCKED** — a required route or capability is deliberately disabled or not implemented.
- **NOT APPLICABLE** — outside the approved first-order journey.

Severity is **CRITICAL / HIGH / MEDIUM / LOW**. Local synthetic tests are not evidence of Vercel, Turso, Cloudinary, email, or SePay Production behavior.

Reconciliation of previous QA evidence:

- ORDERS-2.31’s inactive-catalog and misleading-pricing-copy findings are superseded locally by ORDERS-2.32. Current [src/product-catalog.ts](../../src/product-catalog.ts), [src/payments.ts](../../src/payments.ts), [index.html](../../index.html), and [checkout/index.html](../../checkout/index.html) expose the five standard products and the approved displayed prices.
- ORDERS-2.32 itself leaves remote migrations/provider setup unverified. Its local custom-month tests do not establish that non-preset month terms can be persisted by the Production order path; see finding F-02.
- ORDERS-2.29’s code-level Vercel isolation remains supported by current source and local tests, but does not verify actual deployed configuration.
- ORDERS-2.30’s fail-closed Preview storage status remains current: Vercel Preview has no storage adapter, and durable media operations are unavailable there. This supersedes any earlier suggestion that Preview mock storage could serve as durable storage.
- Current editor source contradicts the older documentation statement that only Our Universe uses the customer APIs: Our Universe has its own API client, and Love Letter, Our Memories, Say Yes, and Distance Means Nothing load the shared customer editor and register adapters. That is source evidence, not proof of a hosted browser workflow.

## 2. Git baseline and final state

Baseline recorded before the audit report was created:

- Branch: `main` tracking `origin/main`
- HEAD: `84acc4c19a143805830495671e076bbc395db3e3`
- Staged paths: **0**
- Modified tracked paths: **35**
- Untracked paths: **12**

All baseline paths are pre-existing work and were preserved.

**Modified tracked paths at baseline:**

`.env.example`, `README.md`, `account/websites/websites.js`, `checkout/checkout.js`, `checkout/index.html`, `docs/API_SPECIFICATION.md`, `docs/DATABASE_SCHEMA.md`, `docs/HOSTING_MIGRATION.md`, `docs/PAYMENT_FLOW.md`, `docs/PRODUCT_ARCHITECTURE.md`, `docs/PUBLICATION_AND_DELIVERY.md`, `docs/SECURITY_PLAN.md`, `docs/SEPAY_SETUP.md`, `docs/TEMPLATE_ENGINE.md`, `docs/VERCEL_STAGING.md`, `index.html`, `scripts/staging-config.ts`, `scripts/staging-turso.ts`, `src/auth.ts`, `src/payments.ts`, `src/platform/vercel.ts`, `src/product-catalog.ts`, `src/publications.ts`, `src/storage/cloudinary-policy.ts`, `tests/database-contract.test.ts`, `tests/payment-contract.mjs`, `tests/payments.test.ts`, `tests/pre-staging-security.test.ts`, `tests/product-catalog.test.ts`, `tests/publications.test.ts`, `tests/scheduler.test.ts`, `tests/staging-config.test.ts`, `tests/storage.test.ts`, `tests/vercel.test.ts`, `tests/worker.test.ts`.

**Untracked paths at baseline:**

`docs/qa/ORDERS-2.23-TURSO-STAGING-DATABASE-ISOLATION.md`, `docs/qa/ORDERS-2.24-CLOUDINARY-STAGING-ISOLATION.md`, `docs/qa/ORDERS-2.25A-PREVIEW-AUTH-GATE-REMEDIATION.md`, `docs/qa/ORDERS-2.26-PREVIEW-MOCK-PAYMENT-ISOLATION.md`, `docs/qa/ORDERS-2.27-STAGING-MANUAL-PUBLICATION-LIFECYCLE.md`, `docs/qa/ORDERS-2.28-PREVIEW-LIFECYCLE-SECRET-ISOLATION.md`, `docs/qa/ORDERS-2.29-VERCEL-PREVIEW-ENVIRONMENT-CONFIGURATION-AUDIT.md`, `docs/qa/ORDERS-2.30-PREVIEW-STORAGE-DURABILITY-REMEDIATION.md`, `docs/qa/ORDERS-2.31-FIRST-PAID-ORDER-READINESS-AUDIT.md`, `docs/qa/ORDERS-2.32-CATALOG-PRICING-REMEDIATION.md`, `src/payments/policy.ts`, `tests/auth-environment.test.ts`.

**Final state after this report:**

- Branch and HEAD unchanged: `main` / `84acc4c19a143805830495671e076bbc395db3e3`.
- Staged paths: **0**.
- Modified tracked paths: **35**, same as baseline.
- Untracked paths: **13**: the same 12 baseline paths plus this report, `docs/qa/ORDERS-2.33-FIRST-PAID-ORDER-END-TO-END-READINESS-AUDIT.md`.
- No application file was changed for ORDERS-2.33.

## 3. First-order journey matrix

| # | Journey stage | Status | Source and local evidence | Production status / blocker |
|---:|---|---|---|---|
| 1 | Open the homepage | PARTIAL | Static landing page at [index.html](../../index.html); Vercel serves the project root. | Deployment/domain not checked. The navigation also contains stray visible text `up github` (MEDIUM UX defect). |
| 2 | View five standard templates and prices | PARTIAL | Five product IDs and approved pricing are in [src/product-catalog.ts](../../src/product-catalog.ts); homepage and checkout explain first-month, additional-month, Lifetime, and no-recurring-charge terms. Local catalog tests pass. | No deployed catalog/API or Production database was queried. |
| 3 | Select a template | PASS (source) | Homepage cards link directly to the five template pages; `js/main.js` also supports whole-card navigation. | Static route delivery was not tested on a deployed domain. |
| 4 | Customize a selected template | PARTIAL | The template registry and design API support the five templates. Our Universe uses its own API flow in `templates/our-universe/index.html`; the other four load `shared/customer-editor.js` and register adapters. | No hosted per-template browser or physical-mobile test. Preview authentication is disabled. |
| 5 | Save and preview customization | PARTIAL | [src/designs.ts](../../src/designs.ts) and `shared/customer-editor.js` implement owner-scoped drafts, revisions, private preview tokens, and save/reload; local API/schema tests pass. | Production login-email and storage dependencies are unverified. Preview returns `AUTH_UNAVAILABLE`; this journey cannot be exercised end-to-end in Vercel Preview. |
| 6 | Choose hosting duration | PARTIAL | [checkout/index.html](../../checkout/index.html) accepts a positive integer month count and a Lifetime choice. | Only 1, 3, 6, 12 months and Lifetime are seeded as storage plans. The UI accepts 2 months, but the Production order path does not create its required `custom-2-months` row. |
| 7 | Server calculates the price | PARTIAL | Server computes the approved formula and stores pricing snapshots; browser-supplied prices are rejected. Local unit and integration contracts cover 1, 2, 3, 6, 12 and 24-month calculations. | The 2-month local order succeeds only through a local-only plan-insertion branch; the equivalent Production order is not verified and currently lacks its plan row. |
| 8 | Customer authenticates | PARTIAL | Production auth code implements one-time, 15-minute magic links, hashed tokens, 14-day sessions, CSRF/origin checks, secure cookies, rate limits, and owner checks. Synthetic local tests pass. | Production email sender/configuration, domain, rate-limit behavior, and session operation are not remotely verified. Preview auth is deliberately disabled. |
| 9 | Customer creates an order | BLOCKED | [src/payments/policy.ts](../../src/payments/policy.ts) disables Production order creation; `POST /api/v1/orders` fails before writes. | Production cannot accept an order. Vercel Preview passes the payment-policy check but is stopped by disabled auth before order writes. |
| 10 | Customer receives payment instructions | BLOCKED | Instructions are created only for local `sepay-test` mode. | Production has `mode: null`; no live checkout or bank instructions are generated. |
| 11 | SePay receives and verifies transfer | BLOCKED | [src/payments/sepay.ts](../../src/payments/sepay.ts) contains bounded parsing and timestamped raw-body HMAC verification. Local synthetic signature tests pass. | Production webhook is disabled and SePay’s actual webhook/signature contract, onboarding, account, and callback configuration have not been verified. |
| 12 | Webhook is authenticated/idempotent | PARTIAL | [src/payments.ts](../../src/payments.ts) persists webhook events, rejects stale/bad signatures, handles duplicates/collisions, and uses conditional settlement updates. Local synthetic tests pass. | No real provider retries, duplicate deliveries, or concurrency were exercised. Checkout creates a new idempotency key on each submit, so a lost successful response followed by retry can create a second pending order. |
| 13 | Order becomes paid only after settlement | PARTIAL | Settlement checks incoming direction, receiving account, payment reference, exact amount/currency, pending/unexpired state, transaction uniqueness, and processed webhook evidence. | Tests prove the local code path only; the Production route is disabled and provider compatibility is unknown. |
| 14 | Fulfillment creates publication | PARTIAL | [src/publications.ts](../../src/publications.ts) verifies paid-order evidence and creates/publishes a unique-slug site; local synthetic fulfillment/publication tests pass. | Production DB/storage are unverified. A failed fulfillment is marked retryable, but no configured Production job invokes `recoverPendingFulfillments`. |
| 15 | Customer receives public URL | PARTIAL | Fulfillment creates a URL using the validated app origin; account and checkout pages can display it. | Production origin/domain and public delivery were not tested. No post-payment delivery email is implemented; customer relies on the account/dashboard. |
| 16 | Customer accesses/manages website | BLOCKED (management) | `/api/v1/publications` owner-scoped dashboard reads exist, and account UI renders publish/unpublish/revoke/consent controls. | `requireLocalPublishing` blocks all customer publication mutations outside local test mode. The visible controls therefore cannot unpublish/revoke or withdraw photo consent in Production. |
| 17 | Expiry, renewal, retention, cleanup | PARTIAL | Lifecycle, calendar-month renewals, Lifetime handling, retention cleanup, leases, and a daily Vercel Cron are implemented and covered by synthetic tests. | Cron secret, remote DB/storage, actual execution, and cleanup monitoring are unverified. Renewal order creation is blocked with Production checkout. Webhook/fulfillment recovery is not part of this Cron. |

## 4. Subsystem audit findings

### A. Product catalog and pricing

**PARTIAL — MEDIUM/HIGH.** The current local catalog contains exactly the five standard IDs: `our-universe`, `love-letter`, `our-memories`, `say-yes`, and `distance-means-nothing`. Premium/Custom Design are not registered standard products and do not resolve through `standardProduct`; client-submitted amount/total/currency fields are rejected. Server pricing is:

- 1 month: 59,000 VND.
- 2 months: 69,000 VND.
- 3 months: 79,000 VND.
- 6 months: 109,000 VND.
- 12 months: 169,000 VND.
- Lifetime: 199,000 VND.

There is no recurring charge. Renewal pricing is a separate 10,000 VND per renewed month; Lifetime renewal/upgrade is not offered.

**F-02 — non-preset duration cannot be ordered outside local test mode (HIGH).** The checkout accepts any positive whole-month value and the formula supports it. `standardStoragePlanForTerm` maps 2 months to `custom-2-months`; however, migrations seed only 1, 3, 6, 12 and Lifetime. `createOrder` inserts a custom plan only when `localApprovedPricingEnabled(env)` is true. In Production that branch is false, while the subsequent order query requires an ACTIVE `storage_plans` row. Thus the local integration test’s 2-month success does not prove Production supports 2 months; the Production request currently fails with a price-unavailable result. This creates an implicit duration restriction despite the uncapped UI/formula. The same issue applies to other non-seeded terms.

### B. Authentication and customer ownership

**PARTIAL — HIGH.** Production auth is enabled in code. Session tokens are random and stored hashed, magic links are one-time and expire after 15 minutes, sessions expire after 14 days, mutating cookie-authenticated requests require CSRF/origin checks, and resource queries use the authenticated customer ID. Local synthetic Production-auth tests cover these flows.

Preview auth is intentionally disabled and returns `AUTH_UNAVAILABLE` before database, token, or email effects. Do not enable it as a shortcut for testing.

Production sign-in depends on a working sender. Vercel forwards only the Resend path (`MAIL_PROVIDER`, `MAIL_API_KEY`, `MAIL_FROM_EMAIL`); missing configuration results in unavailable email sign-in. No real email delivery, domain reputation, or deployed Vercel session flow was tested.

### C. Database and migrations

**PARTIAL — CRITICAL.** Vercel selects Turso and uses staging-specific Turso credentials only in Preview; Production uses the generic Turso credentials and rejects staging database hostnames. Local Vercel development requires a file database. `migrations/0001` through `0008` are consecutive; the migration runner checks a migration ledger/checksum, foreign-key enforcement, and refuses an existing untracked schema. Local tests applied all eight migrations and verified repeat application/schema behavior.

Vercel includes the migration files but does not automatically apply them on API startup. No Production or Preview connection, remote schema state, migration application, backup, or restore was checked. The remote schema may therefore not match the code.

### D. Media storage and publication

**PARTIAL — CRITICAL.** Production Vercel source requires explicitly selected Cloudinary storage and the generic Production Cloudinary credentials. Upload code restricts image type/size, uses private authenticated source assets, verifies stored metadata, and creates public derivatives only after explicit asset consent. Cleanup failures are recorded/retryable. Cloudinary adapter tests use mocked responses; no real upload/read/delete/derivative operation occurred.

Preview `createStorage` returns no adapter. Upload, publication, lifecycle, and media retrieval requiring durable storage fail closed. There is no verified durable Preview provider. Production Cloudinary account identity, retention behavior, credentials, limits, and public/private delivery remain unverified. Production API requests also require a valid configured storage provider (apart from liveness), so a missing/bad provider prevents normal API use.

Publication creation/fulfillment and public rendering are implemented behind strict paid-order evidence and are covered locally. However, customer publication mutation routes call `requireLocalPublishing`, which only allows local test mode. In Production, dashboard actions for publish/unpublish, revoke, update, and photo-consent withdrawal cannot work. This is a customer privacy/control blocker, not just a missing convenience.

### E. SePay payment

**BLOCKED — CRITICAL.** Production policy selects the SEPAY provider identity but sets `mode: null`, `orderCreationEnabled: false`, and `sepayWebhookEnabled: false`. Production environment validation also treats `PAYMENT_MODE` and `SEPAY_*` values as local-only and rejects them outside Vercel development. Setting credentials alone cannot enable Production checkout.

The code expects `x-sepay-timestamp` and `x-sepay-signature` HMAC headers over the timestamp and raw body. Local tests prove the implementation’s synthetic signing contract; they do not prove that the configured SePay product/account provides this exact contract. Incoming direction, transaction ID, receiving account, reference, amount, order expiry, duplicate, and review checks exist. There is no live checkout, provider reconciliation API/job, refund implementation, or admin manual-review workflow.

### F. Fulfillment, recovery, and lifecycle

**PARTIAL — CRITICAL/HIGH.** Webhook settlement creates one fulfillment job, and fulfillment verifies payment/event evidence before publication and entitlement creation. Fulfillment claims are idempotent and failures are recorded as FAILED. However, `recoverPendingFulfillments` and `recoverPendingSePayWebhookEvents` are exported recovery functions, not invoked by the configured Vercel Cron or another Production operator route. The configured daily Cron runs publication expiry/retention lifecycle only. A successful payment followed by a publication/storage failure can leave the order in FULFILLING with no configured automatic retry or admin recovery path.

The website lifecycle checks expiry on public reads and has scheduled cleanup/retention behavior; the Vercel daily Cron requires `CRON_SECRET`, DB, and storage. Local tests exercise synthetic lifecycle records, not an actual deployed schedule. No customer-facing payment reconciliation, refund, or recovery operations are available.

### G. Vercel deployment and environment configuration

**PARTIAL — HIGH.** `api/[...path].ts` is the Vercel Node adapter; `vercel.json` includes migrations, routes `/p/:slug`, sets static security headers, and schedules `/api/cron/publication-lifecycle` daily. Runtime classification and credential-scope guards have local synthetic tests. The actual Vercel project, deployment, plan, custom domain, variables, cron execution, database identity, and storage identity were not inspected.

Source-level Production variable names (values were not read):

- Runtime/origin: `ENVIRONMENT`, Vercel-provided `VERCEL_ENV`, `VERCEL_PROJECT_PRODUCTION_URL`, optionally `APP_ORIGIN`.
- Database: `DATABASE_PROVIDER`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`.
- Storage: `STORAGE_PROVIDER`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`.
- Sign-in email: `MAIL_PROVIDER`, `MAIL_API_KEY`, `MAIL_FROM_EMAIL`.
- Scheduled lifecycle: `CRON_SECRET`; optional `DATA_RETENTION_DAYS`.
- Proposed SePay values: `PAYMENT_MODE`, `SEPAY_WEBHOOK_SECRET`, `SEPAY_BANK_CODE`, `SEPAY_BANK_ACCOUNT`, `SEPAY_ACCOUNT_NAME` are currently rejected as non-development/local-only configuration. They must not be added to Production to bypass the gate.

Preview source expects `ENVIRONMENT=staging`, Vercel-provided `VERCEL_URL`, and dedicated `TURSO_STAGING_DATABASE_URL` / `TURSO_STAGING_AUTH_TOKEN`. Preview has no approved durable storage provider; Cloudinary staging variables are rejected. No Vercel variable values or account settings were checked.

The prior security plan also notes Vercel Hobby is for personal/non-commercial development. Current plan/terms were not checked; the owner must verify commercial eligibility before launch.

### H. Customer experience and business readiness

**PARTIAL — HIGH.** Homepage and checkout disclose the approved standard pricing and no recurring billing. Checkout explicitly says Production payment is disabled and cancellation/refund policy is unpublished. Contact links point to `hello@crushify.love`, but mailbox ownership/monitoring is unverified. There are no published terms/privacy/refund pages, refund operations, support/reconciliation runbook, or payment dispute workflow. The account dashboard can show order/publication/expiry details and link to a delivered site, but no payment-completion email is sent.

The UI creates a fresh `Idempotency-Key` per submit. The server correctly handles repeated requests with the same key, but a client retry after the first response is lost uses a different key and may create a second pending order. No browser or mobile network-failure test was run.

## 5. Prioritized blockers

### P0 — Do not accept a Production payment

1. **Production checkout and webhook settlement are disabled.** Production policy refuses order creation and webhook processing; local-only payment settings are rejected in Production.
2. **Production persistence and durable media are unverified.** Remote DB identity/schema/migrations and Production storage provider/account have not been checked or exercised.
3. **Paid-order recovery is missing operationally.** No configured scheduled fulfillment/webhook recovery or manual review/reconciliation route exists. A paid order can remain unfulfilled after a failure.
4. **Customer cannot reliably revoke/manage a Production publication.** Customer mutation routes are local-only even though dashboard actions are shown. Public links and photo consent need effective customer controls before taking personal content/payments.

### P1 — Required before controlled first sale

5. **Non-preset hosting terms fail the Production order path.** The 2-month/69,000 VND contract works in the local test-only insertion path but lacks an ACTIVE plan record outside it.
6. **No validated SePay Production contract or payment operations.** HMAC expectations, provider onboarding/callback, bank instructions, settlement/reconciliation, refunds, and manual-review procedures are unverified or absent.
7. **No published legal/support policy.** Refund/cancellation policy is explicitly unpublished; privacy/terms, support ownership, retention communication, and customer recovery instructions need owner approval.
8. **Order retry can create duplicate pending orders.** Client idempotency key is not retained across retry when the initial response is lost.
9. **Production authentication and email delivery are unverified.** The code depends on Production email configuration and working Vercel/domain behavior.
10. **Remote schema and Vercel commercial eligibility are unknown.** No owner evidence was obtained for actual environment settings or commercial account terms.

### P2 — Resolve before public launch or after a controlled pilot as appropriate

11. Vercel Preview reports `checkout_enabled: true` from the staging payment policy even though disabled auth makes order routes return `AUTH_UNAVAILABLE`; this is a misleading readiness signal for Preview testing.
12. The homepage contains visible stray text `up github` in its navigation.
13. No deployed desktop/mobile browser test, external-device delivery test, or per-template hosted save/preview test was performed.
14. The daily lifecycle Cron and expiry cleanup lack verified remote execution/alerting. Expiry is enforced on public reads, but scheduled cleanup and recovery remain unverified.

### P3 — Optional after safe launch

15. Add post-payment delivery email/notifications once delivery and support operations are stable; the current account/dashboard is the delivery path.

## 6. Shortest safe remediation roadmap

Keep Production order creation, SePay webhook, and any live transfer **disabled** until steps 1–6 pass.

| Order | Work and files/modules | Dependencies and tests | Remote/approval | Acceptance |
|---:|---|---|---|---|
| 1 | Fix duration persistence and retry idempotency: `src/payments.ts`, `src/product-catalog.ts`, `checkout/checkout.js`, and `tests/product-catalog.test.ts`, `tests/payment-contract.mjs`. | Local isolated DB tests must exercise the same plan persistence behavior intended for Production; test 1/2/3/6/12/24 months, Lifetime, invalid/unsafe terms, and a lost-response retry. | No remote side effect. Product owner confirms any duration policy change; do not invent a cap. | 2 months creates a persisted 69,000 VND order snapshot outside the local-only fixture branch; retry reuses an idempotency key; browser price remains untrusted. |
| 2 | Implement safe paid-order recovery and operator reconciliation: `src/payments.ts`, `src/publications.ts`, `src/scheduler.ts`, `src/platform/vercel.ts`, Vercel API routes, and related tests. | Synthetic duplicate/out-of-order webhook, DB/storage outage, failed fulfillment, retry, and manual-review cases. | Local first. Owner/security approval required before exposing operator routes or scheduling financial recovery in Production. | A verified paid order can be retried idempotently; failure is visible/actionable; no browser action can mark an order paid; manual review has an authorized recovery procedure. |
| 3 | Complete Production customer publication controls and consent withdrawal: `src/publications.ts`, `account/websites/websites.js`, and tests. | Test owner-scoped publish/unpublish/revoke/consent withdrawal, stale lifecycle revisions, media cleanup failures, and public denial after revoke. | Local synthetic tests first; explicit owner/privacy approval before allowing Production mutations. | Customers can stop public access and withdraw image consent; cleanup failures are surfaced and retried without false success. |
| 4 | Finalize customer/legal/operations materials: checkout/account pages and approved documentation for terms, privacy/retention, cancellation/refund, support, payment reconciliation, and “paid but not delivered” recovery. | Policy owner review and customer-facing tests for statuses and support links. | Owner/legal approval required; no policy text or refund promises should be invented by engineering. | Customers can understand exact price, hosting/expiry, public visibility, support contact, refund/cancellation process, and recovery path before payment. |
| 5 | Owner verifies Production infrastructure without using Preview credentials: Vercel commercial eligibility/origin/variables, dedicated Production Turso identity and all migrations, Cloudinary Production identity/durable media behavior, and Production email sender. | Owner-approved read-only account verification, then isolated synthetic upload/read/delete and email delivery checks where safe. Confirm backups/restore and migration ledger. | Remote account access/configuration required; owner approval required. No credentials in Preview; no remote migration until explicitly approved. | Correct Vercel environment and domain are confirmed; schema matches all migrations; durable storage operations and sign-in email work; no Production/Preview credential overlap. |
| 6 | Validate the actual SePay test/sandbox contract and full fulfillment/recovery flow with synthetic or provider-approved test transactions. | Match provider documentation/signing, callback retries, QR/instructions, amount/reference/receiving account, duplicate/replay, timeout, refund/reconciliation, and publication delivery. | Provider sandbox/account required; explicit owner approval. Do not use Production payment credentials in Preview or test with real customer funds. | Provider contract is verified, webhook remains idempotent, a test order fulfills and can be recovered/reconciled, and customer controls/expiry work end-to-end. |
| 7 | Only after all preceding acceptance criteria, conduct a deliberately approved controlled-first-order release. | Reviewed production runbook, monitoring, support coverage, backup/recovery, and rollback plan. | Requires explicit owner approval before any Production checkout/webhook enablement or live transaction. | One authorized real order can be tracked from customer sign-in through verified settlement, durable publication, customer access/revocation, expiry communication, and operational recovery. |

**Optional, not a launch gate once P0/P1 are satisfied:** broader visual polish and accessibility testing across all devices, remove the homepage navigation artifact, and add post-payment email notifications.

## 7. Local verification performed

All checks were local and used synthetic/test data; none contacted Turso, Cloudinary, SePay, Resend, Vercel, or Production:

| Check | Result |
|---|---|
| `npm run typecheck` | Passed. |
| `npm test` | **140 passed, 0 failed, 0 skipped** across 27 suites. |
| `npm run test:integration` | Passed: local D1 API/payment contracts, legacy regression, constraints, and batch rollback. |
| `git diff --check` | Passed for the tracked worktree diff; the new report was separately checked for trailing whitespace. |

The tests cover local migration application/idempotency, environment isolation, synthetic auth/session/CSRF, product catalog and price calculations, local payment/webhook settlement contracts, publication/expiry, storage adapters with mocked Cloudinary responses, and Vercel handler behavior with synthetic dependencies. They do not prove actual remote configuration or provider operation.

## 8. Explicitly not verified

- Production or Preview Vercel variables, plan, custom domain, deployed source revision, Cron execution, logs, or alerts.
- Production/Preview Turso database identity, schema migration state, backups, restore, or data.
- Production Cloudinary account identity, actual private upload/read/delete, public derivative behavior, durability, quota, or cleanup.
- Production email sender, inbox delivery, authentication on the deployed domain, or recovery after email failure.
- SePay onboarding, real webhook headers/signature compatibility, test/live account, QR/bank transfer, settlement/reconciliation, refunds, or disputes.
- A real paid order, real customer account, real publication, public link delivery, physical mobile/browser UX, or Production security boundary.
- Commercial eligibility of the deployed hosting plan and owner approval of terms, privacy, retention, refund, support, and payment operations.

No Production payment should be enabled based solely on these passing local tests.

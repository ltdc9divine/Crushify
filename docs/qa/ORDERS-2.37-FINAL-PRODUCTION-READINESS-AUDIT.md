# ORDERS-2.37 — Final Production Readiness & Security Audit

**Final verdict: NOT READY — BLOCKING ISSUES REMAIN.**

Crushify must not accept its first real paid order on the audited implementation. Production order creation and SePay settlement are explicitly disabled, and no SePay Live checkout mode is implemented. Even after an authorized payment-policy change, production database, storage, email, deployment, and recovery operations have not been remotely verified. A customer-facing design deletion route is authenticated and owner-scoped, but is not local-only gated: after fulfillment it can revoke the customer's active publication and hosting entitlement and delete its media. No customer deletion/refund policy is documented.

This is a read-only source, test-report, and configuration audit. It does not authorize or establish Production readiness. No application source, tests, migration, or deployment configuration was changed. No remote resource, provider, secret value, real order, or customer data was accessed.

## 1. Executive summary

| Area | Finding |
|---|---|
| Standard offer | Five standard templates and the approved initial/renewal pricing are implemented locally. Premium and Custom Design do not use the standard self-service catalog. |
| Payment path | **Blocked.** Production reports `checkout_enabled: false`, rejects order creation, has no payment mode, and rejects SePay webhook settlement. |
| Ownership | Customer API queries generally derive customer identity from the authenticated session and scope reads/mutations by that identity. Synthetic tests include foreign-owner design, order, publication, and renewal cases. |
| Publication management | Customer listing is session/owner-scoped. Production publication detail and mutation routes remain local-test-only. The account UI therefore does not constitute a working Production management path. |
| Lifecycle | The source has exact persisted-expiry checks, lifetime exclusion, retention, shared-asset deferral, and retryable cleanup. The Vercel Cron config invokes lifecycle only; deployed execution is not verified. |
| Fulfillment recovery | Durable lease/retry/manual-review code exists, but no configured Production runner or operator recovery route exists. The Vercel Cron does not invoke it. |
| Infrastructure | Source defines environment separation, but remote Vercel, Turso, Cloudinary, SePay, email, origin, migration, scheduler, and monitoring state was not verified. |
| Highest-priority security concern | `DELETE /api/v1/designs/{id}` has customer session, CSRF, and ownership checks, but no local-only publication gate. It permits deletion after the related order reaches `FULFILLED`, revoking the active website/entitlement without changing the historical payment. |

### Evidence labels

- **Source-verified:** behavior found in the checked-in implementation/configuration; not proof of deployment.
- **Local synthetic:** a test or QA report uses synthetic data, local databases, mocks, or provider fixtures.
- **Documented:** stated in project documentation; not proof that a provider or deployment is configured.
- **Owner action:** requires product, security, legal, or operations decision/configuration.
- **NOT VERIFIED:** requires authorized remote evidence or a provider-backed test; not performed here.

## 2. Git baseline and final state

The initial Git baseline was captured before source inspection.

| State | Branch | HEAD | Staged | Modified tracked | Untracked |
|---|---|---|---:|---:|---:|
| Initial | `main` | `4f4aaa354893309dd8ed325882bfa461058aa9d3` | 0 | 15 | 3 |
| Final, after this report | `main` | `4f4aaa354893309dd8ed325882bfa461058aa9d3` | 0 | 15 | 4 |

The branch tracked `origin/main` with no divergence at baseline. No staged changes were present.

**Pre-existing modified tracked files (15):**

- `account/websites/websites.js`
- `docs/DATABASE_SCHEMA.md`
- `docs/PAYMENT_FLOW.md`
- `docs/PUBLICATION_AND_DELIVERY.md`
- `src/designs.ts`
- `src/index.ts`
- `src/logging.ts`
- `src/payments.ts`
- `src/publications.ts`
- `tests/database-contract.test.ts`
- `tests/database.test.ts`
- `tests/integration.mjs`
- `tests/payment-contract.mjs`
- `tests/publications.test.ts`
- `tests/vercel.test.ts`

**Pre-existing untracked files (3):**

- [ORDERS-2.35-FULFILLMENT-RECOVERY-REMEDIATION.md](ORDERS-2.35-FULFILLMENT-RECOVERY-REMEDIATION.md)
- [ORDERS-2.36-PUBLICATION-MANAGEMENT-REMEDIATION.md](ORDERS-2.36-PUBLICATION-MANAGEMENT-REMEDIATION.md)
- [0009_fulfillment_recovery_leases.sql](../../migrations/0009_fulfillment_recovery_leases.sql)

The only new untracked file is this report. All pre-existing changes remain intact. HEAD did not change. No commit, push, merge, deployment, remote migration, provider call, or secret inspection occurred.

## 3. Scope and prior QA reconciliation

Read all 14 available reports in the requested ORDERS-2.23 through ORDERS-2.36 range:

- [ORDERS-2.23 Turso staging isolation](ORDERS-2.23-TURSO-STAGING-DATABASE-ISOLATION.md)
- [ORDERS-2.24 Cloudinary staging isolation](ORDERS-2.24-CLOUDINARY-STAGING-ISOLATION.md)
- [ORDERS-2.25A Preview authentication gate](ORDERS-2.25A-PREVIEW-AUTH-GATE-REMEDIATION.md)
- [ORDERS-2.26 Preview mock-payment isolation](ORDERS-2.26-PREVIEW-MOCK-PAYMENT-ISOLATION.md)
- [ORDERS-2.27 staging lifecycle](ORDERS-2.27-STAGING-MANUAL-PUBLICATION-LIFECYCLE.md)
- [ORDERS-2.28 lifecycle-secret isolation](ORDERS-2.28-PREVIEW-LIFECYCLE-SECRET-ISOLATION.md)
- [ORDERS-2.29 Preview environment configuration](ORDERS-2.29-VERCEL-PREVIEW-ENVIRONMENT-CONFIGURATION-AUDIT.md)
- [ORDERS-2.30 Preview storage durability](ORDERS-2.30-PREVIEW-STORAGE-DURABILITY-REMEDIATION.md)
- [ORDERS-2.31 first-order readiness audit](ORDERS-2.31-FIRST-PAID-ORDER-READINESS-AUDIT.md)
- [ORDERS-2.32 catalog/pricing remediation](ORDERS-2.32-CATALOG-PRICING-REMEDIATION.md)
- [ORDERS-2.33 end-to-end readiness audit](ORDERS-2.33-FIRST-PAID-ORDER-END-TO-END-READINESS-AUDIT.md)
- [ORDERS-2.34 variable-duration persistence](ORDERS-2.34-VARIABLE-HOSTING-DURATION-REMEDIATION.md)
- [ORDERS-2.35 fulfillment recovery](ORDERS-2.35-FULFILLMENT-RECOVERY-REMEDIATION.md)
- [ORDERS-2.36 publication management](ORDERS-2.36-PUBLICATION-MANAGEMENT-REMEDIATION.md)

ORDERS-2.32 supersedes the older inactive-catalog and first-month-price-copy findings. ORDERS-2.34 supersedes the non-preset-duration persistence gap. ORDERS-2.35 adds durable local fulfillment leases/retries but explicitly does not configure a Production recovery runner. ORDERS-2.36 fixes local renewal eligibility, deletion retry state, and dashboard idempotency; it does not enable Production publication mutations or add a Production gate to design deletion.

Primary source inspected includes [payments.ts](../../src/payments.ts), [payments/policy.ts](../../src/payments/policy.ts), [payments/sepay.ts](../../src/payments/sepay.ts), [product-catalog.ts](../../src/product-catalog.ts), [designs.ts](../../src/designs.ts), [publications.ts](../../src/publications.ts), [assets.ts](../../src/assets.ts), [auth.ts](../../src/auth.ts), [scheduler.ts](../../src/scheduler.ts), [index.ts](../../src/index.ts), [platform/environment.ts](../../src/platform/environment.ts), [platform/vercel.ts](../../src/platform/vercel.ts), [vercel.json](../../vercel.json), and both Wrangler manifests. Relevant UI inspected includes [checkout.js](../../checkout/checkout.js), [websites.js](../../account/websites/websites.js), and the tagged [Our Universe editor](../../templates/our-universe/index.html). Relevant tests include [payment-contract.mjs](../../tests/payment-contract.mjs), [publications.test.ts](../../tests/publications.test.ts), [payments.test.ts](../../tests/payments.test.ts), [scheduler.test.ts](../../tests/scheduler.test.ts), [vercel.test.ts](../../tests/vercel.test.ts), [auth-environment.test.ts](../../tests/auth-environment.test.ts), and [integration.mjs](../../tests/integration.mjs).

## 4. End-to-end customer journey assessment

Routes below are implemented by the shared API/router; their presence does not prove a deployed route. “Production blocked” describes the current source policy, not an operator action taken during this audit.

| # | Journey stage; route and method | Authentication / ownership | State, environment, payment, cleanup, and idempotency | Evidence and result |
|---:|---|---|---|---|
| 1 | Public catalog/pricing: `GET /api/v1/catalog`, `GET /api/v1/storage-plans` | Public read; no customer identity required. | Server catalog exposes five standard templates and approved prices. Catalog visibility is separate from checkout authorization. | **Source/local:** [product-catalog.ts](../../src/product-catalog.ts), [payments.ts](../../src/payments.ts), [product-catalog.test.ts](../../tests/product-catalog.test.ts). Premium/Custom is not an available standard product. |
| 2 | Template selection: static template pages and homepage links | Public static content. | Five standard template IDs are registered. No payment state changes. | **Source/local:** template catalog and registry tests; no deployed route/browser session verified. |
| 3 | Customization and draft persistence: `POST /api/v1/designs`, `GET|PUT /api/v1/designs/{id}` | Customer session; mutations use CSRF and server-side `customer_id` scoping. | Draft data/revisions persist locally; asset references are validated against the owned design. | **Source/local:** [designs.ts](../../src/designs.ts), shared editor and template-registry tests. Preview auth is disabled. |
| 4 | Private preview: `POST /api/v1/designs/{id}/preview`, `GET /api/v1/previews`, preview-asset reads | Customer session to issue preview; subsequent preview uses a bearer token. | Token is revocable/expiring. Preview auth gate prevents a hosted Preview customer journey. | **Source/local:** design/preview code and tests. No deployed browser validation. |
| 5 | Hosting-duration selection | Authenticated design/checkout UI. | Positive whole-month terms and Lifetime are accepted by the standard flow. No arbitrary business maximum is introduced; representable integer/date range is enforced. | **Source/local:** [checkout.js](../../checkout/checkout.js), [payments.ts](../../src/payments.ts), [ORDERS-2.34](ORDERS-2.34-VARIABLE-HOSTING-DURATION-REMEDIATION.md). |
| 6 | Server-side price calculation | `POST /api/v1/orders` (when enabled). | Server computes the total and immutable order-item snapshot; browser amount/currency/price fields are rejected. Renewal uses the server rate. | **Source/local:** product-catalog and payment contract tests. Production cannot reach order creation under current policy. |
| 7 | Order creation/persistence: `POST /api/v1/orders` | Session + CSRF; design is selected by authenticated customer, and idempotency key is required and bound to a request fingerprint. | Creates `AWAITING_PAYMENT`, order items and a `PENDING` payment atomically. Production policy disables order creation. Preview policy reports mock order capability, but auth fails closed before database effects. | **Source/local:** [payments.ts](../../src/payments.ts), [payments.test.ts](../../tests/payments.test.ts), [payment-contract.mjs](../../tests/payment-contract.mjs). No Production order created. |
| 8 | Payment-instruction creation | Included in order response; no standalone live payment endpoint. | Only local `sepay-test` creates transfer/QR instructions. Mock mode creates none. Production has no active mode. | **Source/documented:** [payments/sepay.ts](../../src/payments/sepay.ts), [SEPAY_SETUP.md](../SEPAY_SETUP.md). No SePay account/provider behavior verified. |
| 9 | Webhook authentication: `POST /api/v1/payments/sepay/webhook` | Provider HMAC secret, fresh timestamp, raw body signature. No customer session. | Verifies HMAC-SHA256 with constant-time comparison and ±300-second timestamp tolerance before processing. Production webhook policy is disabled. | **Source/local:** [sepay.ts](../../src/payments/sepay.ts), [payments.test.ts](../../tests/payments.test.ts). SePay's real configured signature contract is **NOT VERIFIED**. |
| 10 | Duplicate/replay webhook protection | Same operator/provider route as above. | Unique `(provider,event_id)` and provider transaction ID, payload-hash collision handling, conditional updates and processed-event evidence prevent duplicate settlement. | **Source/local:** payment and integration contracts use synthetic signed events. Provider retries/concurrency in Production are **NOT VERIFIED**. |
| 11 | Payment settlement | Internal processing after a valid webhook. | Requires incoming transfer, matching reference/account/amount/currency, pending/unexpired order, unique transaction and no review flag. Browser return state cannot mark paid. Production settlement is disabled. | **Source/local:** [payments.ts](../../src/payments.ts), [payment-contract.mjs](../../tests/payment-contract.mjs). No real transfer or settlement. |
| 12 | Pending webhook recovery | `recoverPendingSePayWebhookEvents` is exported; no customer route. | Function is policy-gated and can reprocess durable `RECEIVED` events. It has no call site in the Vercel Cron or Worker scheduled handler and no operator route. | **Source verified:** repository search finds the definition only. No deployed or operational recovery path verified. |
| 13 | Fulfillment recovery | `recoverPendingFulfillments` is exported and called by the Worker `scheduled` handler. No Vercel/operator route. | Verified-payment eligibility, bounded retries, five-minute leases/fencing tokens, and `MANUAL_REVIEW` after eight attempts. Expired leases are eligible for reclaim. | **Source/local:** [publications.ts](../../src/publications.ts), [index.ts](../../src/index.ts), migration 0009 and ORDERS-2.35 tests. Wrangler schedules are disabled; Vercel Cron does not call it. |
| 14 | Storage entitlement creation | Internal fulfillment after verified settlement. | Unique entitlement per order; initial/Lifetime and renewal state are persisted. Renewal checks the prior entitlement and reuses an existing order-linked entitlement rather than extending twice. | **Source/local:** [publications.ts](../../src/publications.ts), database/payment-contract tests. No Production entitlement created. |
| 15 | Publication creation | Internal fulfillment; customer `POST /api/v1/publications` is separate and local-test-only. | Fulfillment requires verified paid SePay evidence, reuses publication identity on retry, records snapshots/consent, and publishes only eligible content. | **Source/local:** publications and payment-contract tests. No Production publication path is enabled or exercised. |
| 16 | Public URL generation/access: `/p/{slug}`, `GET /api/v1/publications/{slug}` and asset reads | Intentionally public bearer-link access, not customer-management authorization. | Slug is generated and origin-validated; reads check publication/consent/expiry state. | **Source/local:** [publications.ts](../../src/publications.ts), synthetic public-read tests. Production origin, CDN and recipient delivery are **NOT VERIFIED**. |
| 17 | Account website list: `GET /api/v1/publications` | Customer session; query scopes to the session customer. | Lists publication, entitlement, fulfillment and cleanup-pending state. Preview auth is disabled. | **Source/local:** publications tests. Account UI does not make unavailable Production mutations work. |
| 18 | Publication detail/manage: `GET /api/v1/publications/{id}`, `POST|PATCH /api/v1/publications/{id}/*` | Session, CSRF for mutations, owner-scoped publication lookup. | `requireLocalPublishing` blocks detail and mutation routes outside local test mode. Thus Production users cannot use these functions, including publish/unpublish/revoke/consent changes. | **Source verified:** [publications.ts](../../src/publications.ts); local synthetic tests only. |
| 19 | Hosting renewal: `POST /api/v1/orders` with `renewal_publication_id` | Session + CSRF; publication/design is selected through owner-scoped queries; idempotency key required. | Latest entitlement must be `ACTIVE` or `EXPIRED`; server computes 10,000 VND/month; Lifetime is excluded. Production order creation remains disabled. | **Source/local:** [payments.ts](../../src/payments.ts), [publications.ts](../../src/publications.ts), [websites.js](../../account/websites/websites.js), ORDERS-2.36 persisted tests. |
| 20 | Expiry, retention and cleanup | `GET /api/cron/publication-lifecycle` in Vercel Production; Preview operator route is separate. | Uses persisted `expires_at <= now`; excludes active Lifetime; retention cleanup is bounded/retryable and defers shared source assets. Vercel schedule runs lifecycle only. | **Source/local:** [scheduler.ts](../../src/scheduler.ts), [publications.ts](../../src/publications.ts), [vercel.json](../../vercel.json), lifecycle tests. Remote Cron execution is **NOT VERIFIED**. |
| 21 | Customer design deletion: `DELETE /api/v1/designs/{id}` | Session, CSRF and owner-scoped design checks; no publication-local environment gate. | Blocks unexpired awaiting-payment and `PAID`/`FULFILLING` orders. Once order is `FULFILLED`, it can revoke the design's publications/entitlements and delete media. Payment record is retained. Cleanup is retryable. | **Source/local:** [designs.ts](../../src/designs.ts), [index.html](../../templates/our-universe/index.html), [publications.test.ts](../../tests/publications.test.ts). Production deletion policy is **NOT VERIFIED / not documented**. |
| 22 | Recovery/operations after failure | No customer/admin/manual-review route found. Customer can retry design deletion; scheduler functions are internal. | Fulfillment/manual-review rows are durable, but there is no configured Production job or documented operator interface to inspect, retry, or resolve them. | **Source/docs:** [PAYMENT_FLOW.md](../PAYMENT_FLOW.md), ORDERS-2.35/2.36. Database inspectability is not an operational recovery procedure. |

## 5. Critical security findings

### A. Customer ownership and IDOR

**Source assessment: generally sound customer scoping, with route availability limitations.**

- Session identity is derived by `requireSession`/`getSession`; customer IDs from request bodies are not used as the authorization authority.
- Design reads, updates, and deletes include the session customer ID in their database lookup/update. Order status/list and renewal queries are owner-scoped. Publication details/mutations use `loadOwnedPublication` joining the design to its customer.
- Mutations require CSRF validation. `requireCsrf` checks the trusted app origin and a matching CSRF cookie/header bound to the session hash.
- The payment contract includes persisted synthetic checks that another customer cannot read a design/order/publication, mutate a publication, or renew another customer's publication.
- Public recipient URLs are intentionally bearer links and are distinct from customer-management APIs.
- Publication detail/mutations remain local-test-only, so authorization in their Production path is not a launch capability; the server rejects the route before customer use.

**Limitation:** source/tests are local evidence. No deployed Production session, mail link, cookie, origin, or cross-customer request was tested.

### B. Design deletion — HIGH

**Route and method:** `DELETE /api/v1/designs/{designId}` in [designs.ts](../../src/designs.ts), invoked by the “delete design” control in [Our Universe](../../templates/our-universe/index.html).

**Authorization:** Requires a customer session, valid CSRF/origin check, and an owned `DRAFT`/`DELETION_PENDING` design. The database transition also includes `customer_id`. This is not an observed IDOR.

**Environment:** Unlike publication detail/mutation routes, `deleteDesign` does not call `requireLocalPublishing` or another local-only publication gate. The ordinary Vercel API router dispatches it in Production. If Production storage is configured, the route can execute.

**Order/publication effects:**

- It refuses deletion while an order is `PAID` or `FULFILLING`, or while an `AWAITING_PAYMENT` order has not expired.
- It does not refuse an order already marked `FULFILLED`. It then revokes all eligible publications for that design, revokes active/extended/Lifetime entitlements, marks publication derivatives for cleanup, deletes source media, clears publication snapshots, and archives the design.
- It does not change the order/payment settlement record. Therefore a customer may delete an already-paid, active website while the payment remains recorded as succeeded; refunds are not implemented.
- The UI confirms an irreversible design/photo deletion, but no approved policy for post-purchase termination, hosting credit/refund, retention window, or effect on already-paid hosting was found.
- Deletion selects assets by the deleted design/customer. Normal publication validation binds assets to their design, while lifecycle cleanup separately tests shared-asset references. The deletion path itself has no explicit global active/retained-publication reference check for every source asset. Existing tests do not establish deletion safety for an anomalous cross-publication source reference.

**CSRF:** protected by `requireCsrf`; no unauthenticated administrative endpoint was found.

**Tests:** `publications.test.ts` checks that an unexpired awaiting-payment order blocks deletion and that a failed cleanup leaves persisted payment state unchanged, publication/entitlement revoked, cleanup visible, and owner retry successful. Those tests use a paid/succeeded fixture for cleanup retry. They do not prove a Production environment gate, an approved post-fulfillment deletion policy, or cross-publication asset-reference safety.

**Risk classification: HIGH, policy and operational safety.** An authenticated customer can intentionally invoke the route, but the absence of a local-only gate means this destructive behavior is reachable in Production. It can remove an active paid site; the UI's generic browser confirmation does not define a retention/undo or refund policy for the resulting paid entitlement.

**Recommendation (no change made in this audit):** keep Production checkout disabled. Before any Production publication/deletion capability is relied upon, have the product owner explicitly define whether a customer may permanently terminate a paid site, how hosting/refunds are handled, whether there is a retention/undo window, and what happens to shared media. Then either gate deletion to the approved policy with explicit confirmation and a safe retention/checkpoint strategy, or keep it disabled in Production until the policy and persisted-database regression tests are approved. Add a test proving deletion cannot remove a source asset still referenced by another active/retained publication.

### C. Payment integrity

- Browser-submitted price, amount, and currency are rejected by order validation; the server computes and snapshots initial and renewal charges.
- Production payment policy is `{ mode: null, orderCreationEnabled: false, sepayWebhookEnabled: false }`. `handleSepayWebhook` exits through `paymentModeError` before signature/body processing when disabled.
- Local webhook code verifies a timestamped raw-body HMAC; the event/payment uniqueness constraints and conditional database transactions protect duplicate/replay settlement.
- Settlement requires incoming transfer, exact payment reference, receiving account, amount, currency, pending/unexpired order, unique transaction and processed webhook evidence. Browser redirects cannot mark an order paid.
- Unpaid/failed orders do not create an entitlement or publication through the verified fulfillment contract.
- Recovery does not call a payment provider or charge again; it reuses verified payment evidence and order-linked publication/entitlement state.
- These are source and synthetic-test findings only. The Production path is disabled, and no real SePay payload, callback retry, settlement, dispute, refund, or reconciliation was tested.

### D. Environment isolation

| Runtime | Source behavior | Audit assessment |
|---|---|---|
| Vercel Production | Requires `VERCEL_ENV=production` paired with unset/`production` `ENVIRONMENT`; uses generic Turso credentials; rejects staging credentials/hostnames; Cloudinary is Production-only; production payment gates remain off. | Fail-closed source contract; actual assignments, identities, deployment and provider behavior **NOT VERIFIED**. |
| Vercel Preview | Requires `VERCEL_ENV=preview` plus `ENVIRONMENT=staging`; uses only staging Turso variables and validates a staging hostname; rejects Production credentials; returns no durable storage adapter; authentication fails closed before DB/token/email effects. | Source isolation supported by synthetic tests. No remote database identity/configuration verified. |
| Local Vercel | Requires development/local classification and file-backed DB; local test/payment settings are scoped to explicit local gates; remote credentials are rejected. | Source/local contract only. |
| Legacy Worker | Uses D1/R2 bindings; request scope rejects staging before the API/database path; scheduled maintenance requires explicit Production environment and D1. | Separate runtime, not proof of Vercel Preview. `wrangler.staging.jsonc` is configuration text, not proof of deployment. |
| Unknown/mismatched | Runtime classifier returns null and validation fails closed. | Source contract; no unknown deployment tested remotely. |

Preview's payment policy currently sets internal mock order capability true, while Preview authentication is disabled. Thus `checkout_enabled` may be reported true even though customer order creation fails at `AUTH_UNAVAILABLE`; this is not settlement capability and should not be treated as staging launch evidence. Production remains false.

No evidence was found that Preview selects Production database or Cloudinary credentials through normal Vercel provider resolution. However, environment variable values, account ownership, and remote resource identities were intentionally not inspected.

## 6. Payment, fulfillment, and publication assessment

### Payment and fulfillment

The local SePay Test contract is materially guarded, but there is no Live payment implementation. `docs/SEPAY_SETUP.md` describes Test-mode requirements and explicitly says no provider account has been connected. The local HMAC contract does not prove that the configured SePay product/account emits the same signed headers/payload.

ORDERS-2.35 added migration 0009, recovery leases, fencing tokens, retry backoff, attempt limit, `MANUAL_REVIEW`, and persisted tests. Expired `PROCESSING` leases are reclaimable in code. The running topology is incomplete:

1. `vercel.json` declares `GET /api/cron/publication-lifecycle` at `0 3 * * *`.
2. The Vercel handler invokes only `runScheduledPublicationLifecycle`.
3. `recoverPendingFulfillments` has no Vercel call site or operator HTTP route.
4. `recoverPendingSePayWebhookEvents` has no Worker or Vercel scheduled call site.
5. The Worker `scheduled` handler can invoke fulfillment recovery and publication lifecycle, but both Wrangler Cron triggers are disabled in the checked-in deployment configuration, and no deployed Worker schedule was verified.
6. Jobs in `MANUAL_REVIEW` stop automatic retry. No operator endpoint, admin screen, supported command, or runbook was found to inspect and resolve them safely.

Consequently, a future successfully settled payment could remain `FULFILLING` after publication failure without a configured Production retry/reconciliation path. Do not enable live checkout before an approved, authorized, observable recovery mechanism and manual-review procedure exist and are verified.

### Publication, renewal and expiry

- Publication creation/fulfillment rechecks verified paid SePay evidence, matching amount/currency, order/design/template and consent. Recovery reuses an order's existing publication identity instead of creating a second one.
- Public link generation uses the validated application origin. Actual Production URL, custom domain and recipient delivery are unverified.
- Renewal order creation checks the latest entitlement is `ACTIVE` or `EXPIRED`, calculates 10,000 VND per renewed month server-side, and binds renewal to the target publication. Fulfillment verifies payment/prior entitlement and reuses an existing renewal entitlement for idempotent retry.
- Lifetime uses a `LIFETIME` entitlement and null expiry; ordinary expiry and retention explicitly exclude active Lifetime.
- Lifecycle compares persisted timestamps (`expires_at <= now`), records retention, protects active/in-flight records and defers shared-asset cleanup. Failure remains retryable.
- Production order creation is disabled; publication detail and customer publication mutations are local-only. These protections are not equivalent to usable Production customer management.
- Design deletion is the exception: it is authenticated/owner-scoped but has no local-only publication gate and can remove a fulfilled customer's active website, as detailed above.

## 7. Database, storage and migration readiness

### Database

- The migration chain is present locally through `0009_fulfillment_recovery_leases.sql`. Migration 0009 rebuilds the fulfillment-job table while preserving existing fields and adds manual-review/retry/lease metadata and a recovery index.
- Reports ORDERS-2.35/2.36 say migration 0009 was applied only to ephemeral local databases. No remote migration was run or inspected in this audit.
- Vercel API startup does not automatically apply application migrations. Production Turso identity, account ownership, token scope, migration ledger/checksums, schema compatibility, backups and restore are **NOT VERIFIED**.
- The checked-in `wrangler.jsonc` describes local Worker D1/R2 names; `wrangler.staging.jsonc` describes a separate legacy Worker D1/R2 staging profile. Neither is evidence of Vercel/Turso state.

### Storage

- Vercel Preview intentionally has no storage adapter; durable upload, media and lifecycle cleanup operations fail closed. It cannot validate the complete customer media journey.
- Vercel Production source requires an explicit Cloudinary provider and Production credentials for media operations. Cloudinary account identity, credentials, data region, quota, private source reads, derivative delivery/deletion and retention were not checked against the provider.
- No fallback from Preview to Production Cloudinary or Worker R2 was found in the inspected Vercel adapter.
- Asset lifecycle tests use synthetic storage. They do not prove provider durability or deletion behavior.

### Required owner/provider evidence

| Service/control | Required evidence before launch | Status in this audit |
|---|---|---|
| Production Turso | Correct Production database/account identity, narrowly scoped token, schema/migration ledger through 0009, backup/restore and access controls. | **NOT VERIFIED** |
| Production migrations | Reviewed rollout/forward-repair and backup procedure; confirm exact deployed schema before code rollout. | **NOT VERIFIED**; no remote migration run. |
| Cloudinary | Correct Production account, private source/public derivative policy, isolated test upload/read/revoke/delete, retention, quotas and failure behavior. | **NOT VERIFIED** |
| Vercel | Correct project/revision, Production domain and `APP_ORIGIN`/system origin, commercial plan eligibility, assigned runtime variables, deployment protection and Cron attachment. | **NOT VERIFIED** |
| Application origin | Exact HTTPS Production origin used for CSRF, public URLs and email links; deployed domain behavior. | **NOT VERIFIED** |
| Authentication/email | Production session/cookie and CSRF behavior plus configured Resend or supported Worker mail binding, domain authentication, delivery and failure monitoring. | Source exists; provider configuration and inbox delivery **NOT VERIFIED**. |
| Operational secrets | Approved secret inventory/scopes for DB, email, Cron and future payment; no cross-environment reuse; access/rotation process. | Values were not accessed; assignments **NOT VERIFIED**. |
| Logging/monitoring | Alerts and operator response for failed Cron, DB/storage errors, failed jobs, manual-review counts and unresolved payments; access controls and retention. | Safe structured logging exists; alerting and response operations **NOT VERIFIED**. |
| SePay | Provider onboarding, supported VND settlement, actual webhook signature/payload, duplicate retries, account/reference/amount behavior, fees/payouts, refunds and reconciliation. | **NOT VERIFIED**; no account/provider request. |

## 8. Scheduler and recovery audit

| Question | Finding |
|---|---|
| Does Vercel Cron invoke publication lifecycle? | The repository declares it in `vercel.json`; the handler runs `runScheduledPublicationLifecycle`. Actual Vercel attachment, authorization secret, invocation and successful DB/storage operation are **NOT VERIFIED**. |
| Does Vercel Cron invoke fulfillment recovery? | No. The handler is lifecycle-only. |
| Is there an executable recovery entry point? | `recoverPendingFulfillments` is called by the legacy Worker scheduled handler, which requires explicit Production scope; no Vercel or operator route calls it. |
| Are expired leases recoverable? | Yes in source: expired/tokenless `PROCESSING` leases can be reclaimed with a new lease token. Local persistence/concurrency tests are reported in ORDERS-2.35. |
| Can failed jobs reach manual review? | Yes in source after eight attempts; status/error category/count are persisted/logged. |
| Can an operator inspect and resolve manual review? | No supported operator endpoint/screen/runbook was found. Durable DB state alone is not an approved operations path. |
| Does pending webhook recovery run? | Exported recovery function exists, but repository search found no caller. |
| Is Worker scheduled execution active? | Wrangler Cron triggers are disabled in the reported configuration; remote Worker deployment/schedule is **NOT VERIFIED**. |
| Are Preview and Production isolated? | Vercel lifecycle routes use distinct scope checks/secrets; Preview route fails before DB connection because durable storage is unavailable. Actual secret assignment and deployment behavior are **NOT VERIFIED**. |

**Conclusion:** lifecycle scheduling is declared in source but not remotely proven; fulfillment/webhook recovery is not operationally scheduled in the Vercel path and lacks manual operator controls.

## 9. Pricing and business consistency

Source price policy, catalog response, checkout UI and account renewal UI align with the approved standard pricing:

| Offer | Local server pricing |
|---|---:|
| Initial, one month | 59,000 VND (includes the first month) |
| Each additional initial month | 10,000 VND |
| Lifetime | 199,000 VND |
| Renewal per month | 10,000 VND |
| Recurring billing | None implemented |

The initial formula is `59,000 + max(0, months - 1) × 10,000 VND`; custom positive month terms are persisted through the ordinary standard policy path, subject to safe integer and representable calendar expiry. No arbitrary business duration cap was found. Lifetime is separate and excluded from ordinary renewal/expiry. Browser prices are not authoritative.

The catalog contains only the five standard templates. Premium and Custom Design are not silently priced as standard templates. The custom-design workflow documentation describes intended quote/deposit/balance states, but no customer-facing custom quote/payment route was found in the audited self-service order path. Do not advertise Premium/Custom as purchasable through this checkout.

Prices being visible does not mean checkout is enabled. Both Production order creation and webhook settlement remain disabled. No recurring billing or unapproved price was introduced.

## 10. Test evidence and verification performed

No test/build/integration command was rerun for this read-only audit. The `package.json` was inspected: `npm test` invokes Node tests; `npm run test:integration` invokes the local integration harness; separate commands include remote-capable migration/deploy/staging smoke scripts. The latter were not run. Prior QA reports describe integration tests as loopback/local Wrangler with temporary D1 and synthetic data; this audit did not execute them.

Most recent local evidence reported in ORDERS-2.36:

| Evidence type | Reported command/result | What it establishes |
|---|---|---|
| Focused unit/API tests | `node --experimental-strip-types --test tests/publications.test.ts tests/vercel.test.ts` — 19 passed, 0 failed. | Synthetic publication ownership/lifecycle/renewal and Vercel handler behavior. |
| Unit suite | `npm test` — 143 passed, 0 failed, 0 skipped. | Local unit/API contracts; no remote provider behavior. |
| Local integration | `npm run test:integration` — passed for local Wrangler/D1 API/payment contracts, legacy regression, constraints and batch rollback. | Isolated local persisted-database behavior only. |
| Type checking | `npm run typecheck` — passed. | TypeScript static checking only. |
| JavaScript syntax | `node --check` on modified account/payment-contract/integration JS files — passed. | Syntax only. |
| Diff whitespace | `git diff --check` — passed in ORDERS-2.36. | Worktree whitespace at that report's final check. |

Earlier ORDERS-2.32 also reports a local 375px homepage pricing-copy check, not a complete customer browser test. The tests cover persisted state for payment/fulfillment/entitlements, owner isolation, renewal replay, expiry, lifetime exclusion, shared-asset retention, and cleanup retry. They do not prove remote Preview or Production configuration, provider-backed webhook behavior, hosted browser behavior, or a real customer journey.

Evidence categories:

- **Unit/synthetic API tests:** reported passing locally.
- **Persisted local database integration tests:** reported passing with synthetic local state.
- **Browser tests:** limited local pricing-copy check in earlier report; no full journey/mobile/device test in ORDERS-2.36.
- **Remote Preview tests:** not performed; Preview auth and durable storage intentionally prevent a complete journey.
- **Production tests:** none. No real payment, migration, deployment, scheduler invocation, provider call, or customer data access.

## 11. Remaining blockers ranked by severity

### CRITICAL

1. **Production cannot accept or settle an order.** Production order creation and SePay webhook settlement are disabled; no Live payment mode or provider-backed activation contract exists. Do not place a real order or enable the gates.
2. **No operational paid-order recovery.** The Vercel Cron does not run fulfillment or pending-webhook recovery. There is no operator route/procedure for retries, `MANUAL_REVIEW`, reconciliation, or “paid but not published.”
3. **Production database and durable storage are unverified.** Production Turso schema through migration 0009, Cloudinary identity/behavior, backups, and recovery are unknown. A successful local test cannot establish safe persistence/delivery.

### HIGH

4. **Non-destructive Production customer publication controls are disabled.** Production users cannot use publication detail or publish/unpublish/revoke/update/consent mutation routes because they remain local-test-only. The separate design-delete route can revoke a site destructively, but is not a substitute for safe publication management.
5. **Customer design deletion can remove a fulfilled customer's website.** The owner/CSRF-protected route has no local-only gate, revokes publications and entitlements after fulfillment, deletes media, and leaves payment settlement intact. No approved deletion/refund/retention policy or cross-publication source-reference test was found.
6. **No provider-backed SePay contract or payment operations.** Actual HMAC/header compatibility, provider retries, settlement/payout, refund, dispute, and reconciliation behavior are not verified; refund/admin operations are unimplemented.
7. **Production identity/email and deployment are unknown.** Vercel project/domain/origin, Production auth email sender, mail delivery, and commercial plan eligibility require owner/provider verification.
8. **Customer/legal/support readiness is incomplete.** Payment flow documentation says refunds, reconciliation, admin actions and custom deposit/balance payments are not implemented; published terms/privacy/cancellation/refund/support processes were not verified.

### MEDIUM

9. **Remote migrations and scheduler are unverified.** Migration 0009 was local-only in the prior report; `vercel.json` is repository configuration, not proof of attached/running Cron.
10. **Preview is not a full rehearsal environment.** Customer authentication and durable media are unavailable; `checkout_enabled` can be misleading because mock policy is enabled while auth is not.
11. **Shared-asset deletion invariant is not explicit in design deletion.** Lifecycle cleanup checks shared references, but deletion has no per-source global reference check and no test for that case.
12. **No verified operational monitoring/alerting or manual-review resolution.** Safe logs/counts exist, but no alert delivery, support escalation, on-call ownership, or operator action was verified.

### LOW

13. **Documentation drift:** [PUBLICATION_AND_DELIVERY.md](../PUBLICATION_AND_DELIVERY.md) still contains older statements that only Our Universe is integrated, while the current source and prior audit describe adapters for all five standard templates. Update that documentation separately before it is used as an operator/customer capability statement.
14. **Small UX defect:** ORDERS-2.33 noted stray visible `up github` text on the homepage. It does not affect payment integrity and is not a launch blocker for the controlled first sale.

## 12. Exact owner actions required

Before any real payment:

1. Keep Production checkout, webhook settlement and all payment-related gates **disabled**.
2. Approve an actual first-sale product scope and customer terms: price/hosting period, public visibility and consent, expiry/retention, deletion, cancellation/refund, support contact and “paid but not published” process. Do not infer legal/refund promises from code.
3. Decide the Production customer-management policy. Either implement/test approved customer publication controls or keep sale disabled; explicitly decide what post-fulfillment design deletion does to the active website, paid entitlement and refund/retention, and test shared-asset protection.
4. Approve and implement an authorized, auditable Production recovery/reconciliation operation for pending webhooks, failed fulfillment, expired leases and `MANUAL_REVIEW`. Define who can inspect, retry, resolve or refund; make the runner observable and idempotent.
5. Have the authorized infrastructure owner verify, without exposing values in reports, the actual Vercel project/revision/domain/plan, exact Production origin, Turso account/database and token scope, schema ledger through 0009, backup/restore, Cloudinary account/storage behavior, email sender and delivery, Cron attachment/secret, logs/alerts, and environment separation.
6. Rehearse the full customer journey in a safe environment. Current Preview cannot authenticate customers or persist media, so do not substitute Production credentials or describe Preview as full end-to-end evidence. Provision a separately approved isolated rehearsal path if required.
7. Verify the SePay Test account/provider contract with explicit owner approval and provider-approved test transactions: exact headers/signature, transfer fields, retries, duplicates, amount/reference/account matching, timeouts, reconciliation, refunds and publication recovery. Do not test with customer funds.
8. Review/approve a controlled rollout and rollback procedure only after local tests, remote infrastructure evidence, provider test evidence, legal/support readiness, and recovery operations have passed. Enabling SePay requires a separate explicit authorization; this audit does not authorize it.

### Before Production deployment

- Verify deployed source revision and Vercel runtime/domain/plan.
- Verify Production Turso identity, migration ledger, backups and restore rehearsal before rollout; do not assume checked-in migrations were applied.
- Verify Cloudinary Production identity and private-source/public-derivative handling with an approved synthetic test.
- Verify Production email, CSRF/session/origin behavior and customer support contact.
- Verify Cron configuration, secret scope, actual invocation, failure alerting and manual fulfillment recovery.
- Verify no Preview/local credentials or test flags are present in Production and no Production credentials are present in Preview/local.
- Keep order/webhook gates off until the complete safe first-order acceptance checklist is signed by the responsible owner.

## 13. Final verdict

**NOT READY — BLOCKING ISSUES REMAIN.**

The implementation has substantial local safeguards and passing reported synthetic tests, but it cannot currently accept and complete a real Production order. Production checkout and settlement are disabled; recovery is not operationally scheduled; critical infrastructure and migration state are unverified; and Production customer publication controls and design-deletion policy are unresolved. Do not enable SePay or accept real funds based on this audit.

## 14. Final Git state

After adding this report:

- Branch: `main`
- HEAD: `4f4aaa354893309dd8ed325882bfa461058aa9d3` (unchanged)
- Staged paths: 0
- Modified tracked paths: the same 15 paths listed in the initial baseline
- Untracked paths: the three initial untracked paths plus this report
- No source, tests, migration, or configuration were changed for ORDERS-2.37.
- No remote services, provider APIs, Production resources, secret values, migrations, payments, notifications, commits, pushes, merges or deployments were accessed/performed.

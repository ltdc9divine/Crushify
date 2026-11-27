# Payment and Entitlement Flow

**Status:** Local integration coverage exercises synthetic SePay and manual bank-transfer settlement. Vercel Preview supports either an opt-in SePay Test path or an independently configured manual bank-transfer path. Preview deployment, account details, and real transfers are **NOT VERIFIED**. Production checkout and payment confirmation remain **DISABLED**; Production publication mutations are also disabled.
**Provider:** Local `mock`, `sepay-test`, and `manual-bank-transfer` modes and explicitly gated Preview SePay Test/manual transfer paths are implemented. SePay Live checkout/settlement is not implemented.

## Runtime payment policy

| Runtime | Selected provider/mode | Order and settlement behavior |
|---|---|---|
| Production | No payment mode | Order creation and SePay webhook settlement are disabled. The scheduler policy allows recovery attempts for existing fulfillment jobs, but publication mutations reject Production; no complete Production fulfillment flow or configuration is verified. |
| Vercel Preview / staging | Disabled by default; SePay Test or manual bank transfer after explicit opt-in | Requires `PREVIEW_CUSTOMER_FLOW_ENABLED=true` and the complete isolated Preview database, email, allowlist, lifecycle, and payment-mode-specific configuration. Cloudinary and `PREVIEW_ASSET_UPLOADS_ENABLED=true` are required only for uploaded-media operations. SePay Test requires Preview webhook/bank settings. Manual transfer requires separate Preview bank details and admin allowlisting; an admin must verify the actual received funds before confirming. Configuration and deployment remain **NOT VERIFIED**. Preview mock settlement is not supported. |
| Local development | `mock`, `sepay-test`, or `manual-bank-transfer` | Local integration uses disposable D1 and synthetic details. Manual confirmation is an admin action; it does not connect to a bank. Mock mode emits no bank instructions. |
| Unknown / ambiguous | No provider | Payment creation, SePay verification, reconciliation, and fulfillment fail closed. |

With the Preview opt-in disabled, customer authentication, order creation, settlement, and fulfillment are disabled. The Preview payment mode is exclusively either SePay Test or manual transfer; the two configurations cannot be mixed. Manual transfer is not automatic payment: an authenticated, CSRF-protected admin confirms a pending order only after checking the actual bank receipt. There is no customer-facing mark-paid route. This describes source behavior only and does not establish that Preview resources or a real transfer have been configured.

## 1. Authority model

- Browser may request a checkout for a catalog SKU/design revision; it cannot set price, currency, discount amount, entitlement, `PAID`, or fulfillment state.
- `src/product-catalog.ts` is the authoritative standard catalog: 59,000 VND includes the first month, each additional month costs 10,000 VND, and Lifetime is a single 199,000 VND package. Catalog availability is separate from runtime checkout authorization; Production order creation is disabled, while Preview requires the complete explicit opt-in described above. Browser-supplied prices are rejected.
- The server accepts a positive integer month count or Lifetime, recalculates the total, and stores the complete pricing-policy snapshot with the order items. Historical orders without this snapshot continue to use their persisted totals and are never repriced.
- Order references (`CRF...`) and payment references (`CRP...`) are separate random values. SePay uses the payment reference for webhook matching; manual transfer instructions use the unique order reference.
- In `mock` mode, no QR or bank instructions are emitted. In `sepay-test` mode, an owner-scoped QR and transfer details are returned only from settings scoped to that runtime: local Test-mode settings for local development or Preview-scoped Test-mode settings behind the complete Preview gate.
- `sepay-test` is the SePay **Webhook Test mode** flow, not a hosted Payment Gateway checkout: a simulated transaction in the SePay Test-mode Dashboard sends the signed webhook. The transfer QR is a VietQR image URL and must only use isolated Test-mode account details; never make a real transfer during Preview QA. The separate SePay API v2 Sandbox integration is observation-only and cannot settle orders.
- Preview Test-mode orders use the SePay provider only when the explicit Preview gate and complete required configuration validate. Fulfillment/publication still requires verified `SEPAY` webhook evidence; API observations do not satisfy that requirement. Client-supplied provider values are rejected.
- Manual transfer orders use the distinct `MANUAL_BANK_TRANSFER` provider and remain `PENDING` until an allowlisted admin submits a CSRF-protected confirmation. The server requires the exact persisted amount/currency, unexpired pending order, consistent price snapshot, and a unique optional transaction reference. A durable, immutable confirmation record is the settlement evidence; the admin attestation is not a bank API reconciliation. Repeat submissions are idempotent and do not duplicate fulfillment.
- Only a valid HMAC-signed webhook with fresh timestamp, unique transaction, exact payment reference, incoming transfer, receiving account and exact amount can mark a pending payment/order successful. Settlement is recorded as `VERIFIED` evidence in `payment_settlement_evidence`; that evidence, not a webhook delivery acknowledgment, is authoritative for fulfillment/publication.
- A webhook event ID is a delivery/event identity; the SePay transaction ID is stored separately as evidence identity. They currently have the same value in the supported webhook payload, but code and schema do not treat them as interchangeable. SePay API v2 UUIDs are stored in the separate `sepay_api_observations` table, not in `payment_settlement_evidence` or legacy `provider_payment_id`. API observations cannot authorize settlement, fulfillment, or publication.
- The browser return URL is UX only. It displays “processing/confirmed” based on a server read; never fulfills directly from a query parameter or client callback.

## 2. Self-service state machine

```text
Design DRAFT ── valid save ──> DRAFT revision N
     │
     └── checkout request ──> Order AWAITING_PAYMENT + Payment PENDING
                                  ├── signed SePay webhook ──> Payment SUCCEEDED + Order PAID
                                  └── verified admin transfer ──> Payment SUCCEEDED + Order PAID
```

Failure, mismatch, cancellation or expiry never grants entitlement. Mismatch/late/unmatched signed events are stored for manual review. The persisted base schema has review flags rather than new `MANUAL_REVIEW` enum values; the API exposes an effective `MANUAL_REVIEW` status. Publication mutations are enabled only for local tests or the explicitly opted-in Preview runtime; they are disabled in Production. Production fulfillment recovery policy alone does not establish Production entitlement, publication, or end-to-end readiness.

After a verified settlement, fulfillment is a separate durable state machine: `PENDING → PROCESSING → COMPLETED`, with retryable failures recorded as `FAILED` and exhausted retries as `MANUAL_REVIEW`. Payment success is not rolled back when fulfillment fails. Jobs are eligible only while a matching, non-revoked settlement evidence row and the successful payment/order state remain valid. Missing, revoked, mismatched, or review-required evidence fails closed.

### Publication gate

The publication API rechecks order/design/customer consistency, `SELF_SERVICE` and paid order state, successful payment state, verified settlement evidence, amount/currency equality, the purchased template/schema version, and active renderer before publishing and on recipient reads. Legacy payments continue only when migration 0015 backfills sufficient evidence; unverified legacy payments remain blocked for manual review. Publication mutations require either local test mode or the explicit Preview customer-flow gate; they are disabled in Production. A disabled runtime returns `PUBLICATION_DISABLED`.

Each template has a server-validated draft/preview adapter in the shared customer editor, and the same checkout UI can review drafts and track an authenticated order. Checkout displays catalog prices, but order creation requires the separate runtime `checkout_enabled` capability. Production order creation is disabled; Preview requires the complete opt-in configuration described above. The local integration harness uses disposable databases and synthetic fixtures; tests do not establish a real transfer, provider configuration, or deployed Preview behavior.

## 3. Local order creation

1. Require an authorized local test runtime, customer session and CSRF. SePay Test secrets are required only for `sepay-test`; manual mode requires the receiving-bank details and a separate admin confirmation.
2. Require an owned DRAFT design for one of the five standard templates and an active template/version.
3. Load the price policy and catalog-enabled state. Monthly total is 59,000 + max(0, months - 1) × 10,000 VND; Lifetime is exactly 199,000 VND, not the base price plus a separate Lifetime charge.
4. The server validates the chosen term, recalculates the amount, and writes the order, line items and pending payment through the shared database batch. Client price fields are rejected. The immutable snapshot records template, duration type/months, included and additional months, monthly rate, hosting charge or Lifetime price, total, currency, policy version and calculation time.
5. Return owner-scoped instructions only when the selected provider is configured. SePay Test orders expire after 15 minutes; manual transfer orders expire after 24 hours. Manual transfers do not generate or display a payment QR.

`GET /checkout/?design_id=...` is a shared checkout and status view. It requires the existing authenticated customer session, displays a dynamic month input, itemized price and Lifetime disclaimer. The submit button remains disabled unless the runtime explicitly enables checkout; Production checkout is not enabled. Order status remains owner-scoped. The view does not publish or create an entitlement itself.

### Storage renewal

Renewal orders snapshot the selected server-priced storage plan and do not require an active template price; the standard renewal price is 10,000 VND per renewed month. The initial-purchase `/catalog` prices include the template price, while `/storage-plans` reports renewal charges only. Lifetime upgrades are not offered through renewal because no separate upgrade price is defined. A renewal before expiry extends from the current expiry using calendar-month arithmetic. A renewal after expiry but before the retention deadline starts at the confirmed payment time, then republishes the same publication with its original slug. Lifetime entitlements have `status=LIFETIME` and `expires_at=NULL`, cannot be renewed, and are explicitly excluded from scheduled expiration and retention cleanup while that entitlement remains active. A `NULL` expiration alone is not treated as proof of Lifetime. Renewal fulfillment uses lifecycle compare-and-swap and order idempotency so a stale concurrent attempt is retryable without losing an extension or duplicating entitlement history.

## 4. Webhook and idempotency

- Require `Content-Type: application/json`, a body no larger than 64 KiB, and valid UTF-8. Verify `X-SePay-Signature` (`sha256=<hex>`) over the exact raw body with `X-SePay-Timestamp`; reject timestamps outside ±300 seconds before JSON parsing.
- Insert unique `(provider,event_id)` and raw JSON/hash before processing. Store processing attempts/time, provider transaction ID, order reference and expected/actual amount for review. Duplicate transaction IDs are also unique on `(provider,provider_payment_id)` in `payments`.
- Match `code` exactly to the generated `CRP` payment reference; require `transferType=in`, configured receiving account, exact integer `transferAmount`, pending payment/order, and unexpired order.
- In the same atomic database batch, insert `SEPAY_WEBHOOK` settlement evidence, transition payment/order state, and mark the webhook event processed. A unique `(provider, evidence_source, source_transaction_id)` key makes retries idempotent while allowing a webhook and an API observation to be stored as separate evidence sources. A transaction already attached to another payment cannot be reassigned; conflict leaves the payment unsettled and the event in manual review.
- Evidence stores the verified amount/currency, timestamp and payload hash, not the webhook's full receiving account number. `receiving_bank_account_id` remains nullable until a stable, non-sensitive provider account identifier is available.
- Use conditional database updates and atomic batches so simultaneous identical webhooks do not grant twice. A verified mismatch/unmatched/late event is retained as `MANUAL_REVIEW`; never mark paid from the return URL. A repeated provider transaction ID with a different payload is reviewed and cannot settle a second order.
- SePay must receive HTTP 200/201 with `{"success":true}` after durable processing. Storage/processing failure returns an error so configured provider retry can retry. Persisted `RECEIVED` events are idempotently reprocessed on retry. Fulfillment claims use durable leases with fencing tokens; retry delay starts at 30 seconds, doubles to one hour, and stops after eight attempts in `MANUAL_REVIEW`. Legacy Cloudflare Worker code retains bounded recovery and publication lifecycle logic; both Wrangler Cron triggers are disabled in source. `vercel.json` declares a daily Production Cron for lifecycle handling; deployed schedule behavior is **NOT VERIFIED**. No SePay API scan Cron exists.
- The SePay webhook route is enabled for local test modes and for Preview only when the complete explicit SePay Test-mode opt-in validates. Pending-event recovery can be invoked through the protected Preview lifecycle operation; Preview has no automatic lifecycle Cron. No deployed Preview operation or Sandbox transaction is verified.
- Webhook raw payloads can contain account and transaction data; protect access and retention before any production use.

## 5. Custom project payments

- An accepted quote creates a **deposit** order for exact quoted deposit amount. It cannot be edited after customer acceptance.
- Verified deposit changes project from `QUOTED` to `DEPOSIT_PAID`; admin can then start work.
- Preview approval creates the **balance** order from the accepted quote snapshot (or a new accepted quote for approved scope changes).
- Verified balance changes project to `DELIVERED` only after deliverables are ready. Do not treat a deposit as full payment.
- Additional work beyond quote requires a new/versioned quote and customer acceptance before work/charge.

The workflow and guards are detailed in [CUSTOM_DESIGN_WORKFLOW.md](CUSTOM_DESIGN_WORKFLOW.md).

## 6. Coupons, refunds and reconciliation

- Coupons, refunds, admin actions and custom deposit/balance payments are not implemented.
- Migration 0015 backfills only legacy payments with a matching `PROCESSED` webhook and order reference, transaction ID, amount/currency, timestamp, payload hash, and consistent successful payment/order state with no review or contradictory event. It does not change order/payment states or trigger fulfillment. Missing or ambiguous records remain blocked and require operator investigation; no admin review UI exists.
- An observation-only SePay API v2 client, additive migration 0016, and durable paginated scan/cursor service are implemented. A protected Preview-only manual trigger exists at `POST /api/ops/staging/sepay-reconciliation`; it requires the full Preview reconciliation configuration, including an enable flag, Sandbox API token, bank-account UUID, start timestamp, and distinct operator secret. Whether any such credentials are configured or a scan has run is **NOT VERIFIED**. There is no SePay scan Cron. The scan is bounded and stores observations only. API observations alone cannot authorize settlement or fulfillment, create settlement evidence, or authorize publication. The only settlement authorization path is a valid, processed SePay webhook that creates matching `VERIFIED` `SEPAY_WEBHOOK` evidence. A webhook `success` response acknowledges delivery; it is not itself settlement evidence. Production checkout and webhook processing remain disabled.
- Reserve/redemption strategy must avoid concurrent oversubscription. Count redemption once under idempotent transaction and release reservation on expiry/failure if using reservations.
- Refund is a provider operation initiated by authorized server/admin; store refund reference/events, never mark refunded just because frontend asked.
- Reconcile pending payments on schedule or manually; compare local orders with provider settlement/export and report amount/currency/reference mismatches.
- Log actor, reason, provider transaction and old/new state for admin payment actions.

## 7. Launch checklist

- Contract test provider sandbox signatures, replay, duplicate/out-of-order events, amount mismatch, timeout, refund and webhook retries.
- Configure separate test/live keys and webhook secrets per environment; keep them only in the selected host's server-side secret store.
- Verify provider business onboarding, VND settlement support, fees, payout delays, dispute/refund flow, invoice/tax rules and terms.
- Build support runbook for “charged, not published”, “pending”, refund and custom deposit/balance cases.
- Keep Production checkout disabled until terms, support, reconciliation, all-template draft persistence, durable storage, and remote publication security are approved. Visible catalog prices do not authorize order creation or payment. Preview Test mode is not Production readiness.

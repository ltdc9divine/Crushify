# Payment and Entitlement Flow

**Status:** shared draft/preview and order-status UI for all five standard templates; order/payment, SePay webhook verification, and paid-order-gated publication remain local-only prototypes. Vercel Preview selects mock payment internally, but Preview authentication is disabled, so it cannot create customer orders. No provider account has been connected, no real transaction was made, and no live checkout or publication is enabled.
**Provider:** SePay Test mode is the only implemented provider flow. Production/live mode is deliberately disabled by the current application, despite Production retaining the SePay provider identity in the environment policy.

## Runtime payment policy

| Runtime | Selected provider/mode | Order and settlement behavior |
|---|---|---|
| Production | SePay provider identity; no live mode | Checkout and SePay webhook processing remain disabled, matching the existing local-only implementation. |
| Vercel Preview / staging | Mock only | No SePay settings are accepted or forwarded. The order route reaches the existing disabled-auth guard before database queries or writes; SePay webhooks and payment fulfillment are rejected. There is no Preview mock-confirmation route. |
| Local development | Existing `mock` or `sepay-test` mode | Existing synthetic local order, signed-webhook, and fulfillment tests remain available. Mock mode emits no bank instructions. |
| Unknown / ambiguous | No provider | Payment creation, SePay verification, reconciliation, and fulfillment fail closed. |

Preview mock settlement is intentionally unavailable while customer authentication is disabled. A future staging-only confirmation mechanism would need a separately approved operator capability, be scoped to the isolated staging database, and write only a distinct `MOCK` provider state; it must not reuse customer cookies, SePay webhooks, or Production credentials. No such operator credential or route currently exists, so staging orders cannot be settled or fulfilled.

## 1. Authority model

- Browser may request a checkout for a catalog SKU/design revision; it cannot set price, currency, discount amount, entitlement, `PAID`, or fulfillment state.
- `src/product-catalog.ts` is the authoritative standard catalog: 59,000 VND includes the first month, each additional month costs 10,000 VND, and Lifetime is a single 199,000 VND package. All five standard templates and these prices are available through the catalog API. Catalog availability is separate from runtime checkout authorization; Production and Preview order creation remain disabled. Browser-supplied prices are rejected.
- The server accepts a positive integer month count or Lifetime, recalculates the total, and stores the complete pricing-policy snapshot with the order items. Historical orders without this snapshot continue to use their persisted totals and are never repriced.
- Order references (`CRF...`) and payment references (`CRP...`) are separate random values. Only the payment reference is included in transfer instructions and matched against a webhook.
- In `mock` mode, no QR or bank instructions are emitted. In `sepay-test` mode, an owner-scoped QR and transfer details are returned only from explicit local SePay Test mode bank settings.
- A hypothetical Preview mock order is stored with provider `MOCK`; publication/fulfillment queries require verified `SEPAY` webhook evidence, and staging fulfillment/recovery is disabled. Client-supplied provider values are rejected.
- Only a valid HMAC-signed webhook with fresh timestamp, unique transaction, exact payment reference, incoming transfer, receiving account and exact amount can mark a pending payment/order successful. There is no admin reconciliation endpoint.
- The browser return URL is UX only. It displays “processing/confirmed” based on a server read; never fulfills directly from a query parameter or client callback.

## 2. Self-service state machine

```text
Design DRAFT ── valid save ──> DRAFT revision N
     │
     └── checkout request ──> Order AWAITING_PAYMENT + Payment PENDING
                                  │
                    signed paid webhook ──> Payment SUCCEEDED + Order PAID
```

Failure, mismatch, cancellation or expiry never grants entitlement. Mismatch/late/unmatched signed events are stored for manual review. The persisted base schema has review flags rather than new `MANUAL_REVIEW` enum values; the API exposes an effective `MANUAL_REVIEW` status. Publication creation and lifecycle are implemented only behind a local-test guard; they are not production fulfillment or entitlement.

### Local publication gate

The publication API rechecks order/design/customer consistency, `SELF_SERVICE` and `PAID` order state, successful payment state, processed matching webhook evidence, amount/currency equality, the purchased template/schema version, and active renderer before publishing and on recipient reads. Publication mutations require `LOCAL_TEST_MODE=true` and `ENVIRONMENT` unset or `local`; a disabled runtime returns `PUBLICATION_DISABLED`.

Each template has a server-validated draft/preview adapter in the shared customer editor, and the same checkout UI can review drafts and track an authenticated order. Checkout displays the approved monthly/Lifetime prices, but order creation requires the separate runtime `checkout_enabled` capability; Production payment/order creation remains disabled and Preview authentication is unavailable. The Wrangler integration harness uses disposable local D1 and synthetic fixtures; no test uses a real transfer or provider.

## 3. Local order creation

1. Require an authorized local test runtime, customer session and CSRF. SePay Test webhook secrets are required only for `sepay-test` or its local synthetic webhook tests.
2. Require an owned DRAFT design for one of the five standard templates and an active template/version.
3. Load the price policy and catalog-enabled state. Monthly total is 59,000 + max(0, months - 1) × 10,000 VND; Lifetime is exactly 199,000 VND, not the base price plus a separate Lifetime charge.
4. The server validates the chosen term, recalculates the amount, and writes the order, line items and pending payment through the shared database batch. Client price fields are rejected. The immutable snapshot records template, duration type/months, included and additional months, monthly rate, hosting charge or Lifetime price, total, currency, policy version and calculation time.
5. Return the separate order/payment references, amount, 15-minute expiry and owner-scoped bank instructions only when explicitly configured for SePay Test mode.

`GET /checkout/?design_id=...` is a shared checkout and status view. It requires the existing authenticated customer session, displays a dynamic month input, itemized price and Lifetime disclaimer. The submit button remains disabled unless the runtime explicitly enables checkout; Production checkout is not enabled. Order status remains owner-scoped. The view does not publish or create an entitlement itself.

### Storage renewal

Renewal orders snapshot the selected server-priced storage plan and do not require an active template price; the standard renewal price is 10,000 VND per renewed month. The initial-purchase `/catalog` prices include the template price, while `/storage-plans` reports renewal charges only. Lifetime upgrades are not offered through renewal because no separate upgrade price is defined. A renewal before expiry extends from the current expiry using calendar-month arithmetic. A renewal after expiry but before the retention deadline starts at the confirmed payment time, then republishes the same publication with its original slug. Lifetime entitlements have `status=LIFETIME` and `expires_at=NULL`, cannot be renewed, and are explicitly excluded from scheduled expiration and retention cleanup while that entitlement remains active. A `NULL` expiration alone is not treated as proof of Lifetime. Renewal fulfillment uses lifecycle compare-and-swap and order idempotency so a stale concurrent attempt is retryable without losing an extension or duplicating entitlement history.

## 4. Webhook and idempotency

- Require `Content-Type: application/json`, a body no larger than 64 KiB, and valid UTF-8. Verify `X-SePay-Signature` (`sha256=<hex>`) over the exact raw body with `X-SePay-Timestamp`; reject timestamps outside ±300 seconds before JSON parsing.
- Insert unique `(provider,event_id)` and raw JSON/hash before processing. Store processing attempts/time, provider transaction ID, order reference and expected/actual amount for review. Duplicate transaction IDs are also unique on `(provider,provider_payment_id)` in `payments`.
- Match `code` exactly to the generated `CRP` payment reference; require `transferType=in`, configured receiving account, exact integer `transferAmount`, pending payment/order, and unexpired order.
- Use conditional database updates and atomic batches so simultaneous identical webhooks do not grant twice. A verified mismatch/unmatched/late event is retained as `MANUAL_REVIEW`; never mark paid from the return URL. A repeated provider transaction ID with a different payload is reviewed and cannot settle a second order.
- SePay must receive HTTP 200/201 with `{"success":true}` after durable processing. Storage/processing failure returns an error so configured provider retry can retry. Persisted `RECEIVED` events are idempotently reprocessed on retry. The Cloudflare Worker retains bounded fulfillment recovery and publication lifecycle code, but both Wrangler cron triggers are disabled. The repository's daily Vercel Cron is authoritative only for publication lifecycle; it does not run pending webhook recovery. No deployed scheduler or provider API reconciliation was verified.
- The SePay webhook route and pending-event recovery are local-only. Preview rejects the route before reading/verifying the body or touching payment tables; local mock mode keeps its synthetic signed-webhook contract, but its settings are never forwarded to Preview.
- Webhook raw payloads can contain account and transaction data; protect access and retention before any production use.

## 5. Custom project payments

- An accepted quote creates a **deposit** order for exact quoted deposit amount. It cannot be edited after customer acceptance.
- Verified deposit changes project from `QUOTED` to `DEPOSIT_PAID`; admin can then start work.
- Preview approval creates the **balance** order from the accepted quote snapshot (or a new accepted quote for approved scope changes).
- Verified balance changes project to `DELIVERED` only after deliverables are ready. Do not treat a deposit as full payment.
- Additional work beyond quote requires a new/versioned quote and customer acceptance before work/charge.

The workflow and guards are detailed in [CUSTOM_DESIGN_WORKFLOW.md](CUSTOM_DESIGN_WORKFLOW.md).

## 6. Coupons, refunds and reconciliation

- Coupons, refunds, reconciliation jobs, admin actions and custom deposit/balance payments are not implemented.
- Reserve/redemption strategy must avoid concurrent oversubscription. Count redemption once under idempotent transaction and release reservation on expiry/failure if using reservations.
- Refund is a provider operation initiated by authorized server/admin; store refund reference/events, never mark refunded just because frontend asked.
- Reconcile pending payments on schedule or manually; compare local orders with provider settlement/export and report amount/currency/reference mismatches.
- Log actor, reason, provider transaction and old/new state for admin payment actions.

## 7. Launch checklist

- Contract test provider sandbox signatures, replay, duplicate/out-of-order events, amount mismatch, timeout, refund and webhook retries.
- Configure separate test/live keys and webhook secrets per environment; keep them only in the selected host's server-side secret store.
- Verify provider business onboarding, VND settlement support, fees, payout delays, dispute/refund flow, invoice/tax rules and terms.
- Build support runbook for “charged, not published”, “pending”, refund and custom deposit/balance cases.
- Keep checkout disabled until terms, support, reconciliation, all-template draft persistence, durable storage, and remote publication security are approved. Visible catalog prices do not authorize order creation or payment.

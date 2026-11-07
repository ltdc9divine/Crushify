# Payment and Entitlement Flow

**Status:** local-only order and SePay webhook verification prototype. Synthetic local tests run against D1 and Turso/libSQL; no provider account has been connected, no real transaction was made, and no live checkout or publication is enabled.
**Provider:** SePay Test mode is the only future provider path considered here. Production/live mode is deliberately disabled in both runtimes.

## 1. Authority model

- Browser may request a checkout for a catalog SKU/design revision; it cannot set price, currency, discount amount, entitlement, `PAID`, or fulfillment state.
- The server loads an active `template_prices` row; the browser cannot submit a price or currency. The table is empty until a local test price is explicitly inserted.
- The server creates a pending order and payment attempt from an owned Our Universe draft, with the current design revision snapshotted. Order creation is idempotent and expires after 15 minutes.
- Order references (`CRF...`) and payment references (`CRP...`) are separate random values. Only the payment reference is included in transfer instructions and matched against a webhook.
- In `mock` mode, no QR or bank instructions are emitted. In `sepay-test` mode, an owner-scoped QR and transfer details are returned only from explicit local SePay Test mode bank settings.
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

Failure, mismatch, cancellation or expiry never grants entitlement. Mismatch/late/unmatched signed events are stored for manual review. The persisted base schema has review flags rather than new `MANUAL_REVIEW` enum values; the API exposes an effective `MANUAL_REVIEW` status. No fulfillment, entitlement, refund or publication transition is implemented.

## 3. Local order creation

1. Require local runtime, `LOCAL_TEST_MODE=true`, `PAYMENT_MODE=mock|sepay-test`, a local webhook secret, customer session and CSRF.
2. Require an owned DRAFT Our Universe design and active template/version.
3. Load the active server-side VND template price; no active price currently exists. Do not populate production prices from homepage copy or assumptions.
4. Insert order, item and pending payment through the shared database batch. Client fields besides `design_id` are rejected. The item snapshots template and design revision.
5. Return the separate order/payment references, amount, 15-minute expiry and owner-scoped bank instructions only when explicitly configured for SePay Test mode.

`GET /checkout/?design_id=...` is a local-only experimental view. It requires an existing login and an explicitly activated local test price. It polls only the owner-scoped order status. It does not publish or create an entitlement.

## 4. Webhook and idempotency

- Require `Content-Type: application/json`, a body no larger than 64 KiB, and valid UTF-8. Verify `X-SePay-Signature` (`sha256=<hex>`) over the exact raw body with `X-SePay-Timestamp`; reject timestamps outside ±300 seconds before JSON parsing.
- Insert unique `(provider,event_id)` and raw JSON/hash before processing. Store processing attempts/time, provider transaction ID, order reference and expected/actual amount for review. Duplicate transaction IDs are also unique on `(provider,provider_payment_id)` in `payments`.
- Match `code` exactly to the generated `CRP` payment reference; require `transferType=in`, configured receiving account, exact integer `transferAmount`, pending payment/order, and unexpired order.
- Use conditional database updates and atomic batches so simultaneous identical webhooks do not grant twice. A verified mismatch/unmatched/late event is retained as `MANUAL_REVIEW`; never mark paid from the return URL. A repeated provider transaction ID with a different payload is reviewed and cannot settle a second order.
- SePay must receive HTTP 200/201 with `{"success":true}` after durable processing. Storage/processing failure returns an error so configured provider retry can retry. Persisted `RECEIVED` events are idempotently reprocessed on retry; an internal bounded recovery function exists, but no scheduler/operator runner or provider API reconciliation is configured.
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
- Do not enable homepage prices or checkout CTAs as purchasable until catalog, terms, support and reconciliation are approved.

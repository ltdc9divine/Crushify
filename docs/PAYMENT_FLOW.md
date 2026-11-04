# Payment and Entitlement Flow

**Status:** design only. No gateway, checkout, webhook, or payment status mutation has been implemented.
**Requested provider:** SePay is the intended future integration, subject to account, settlement, currency, refund, security and legal checks. No test or live credentials are configured.

## 1. Authority model

- Browser may request a checkout for a catalog SKU/design revision; it cannot set price, currency, discount amount, entitlement, `PAID`, or fulfillment state.
- The server-side API loads the current enabled SKU/quote, validates ownership and eligibility, computes totals in integer minor units and creates a local order/payment attempt.
- Provider-hosted checkout/redirect is preferred for the initial launch to reduce handling of card data. Crushify must not collect/store card PAN/CVV.
- Only a verified provider webhook (or documented administrator reconciliation with evidence and elevated access) can mark a payment successful.
- The browser return URL is UX only. It displays “processing/confirmed” based on a server read; never fulfills directly from a query parameter or client callback.

## 2. Self-service state machine

```text
Design DRAFT ── valid save ──> DRAFT revision N
     │
     └── checkout request ──> Order AWAITING_PAYMENT + Payment PENDING
                                  │
                    signed paid webhook ──> Payment SUCCEEDED
                                  │
                                  └── atomic order PAID + entitlement
                                                │
                                                └── publish job
                                                      ├── FULFILLED + URL
                                                      └── retryable FULFILLING
```

Failure/cancel/expiry transitions never grant entitlement. Refund events transition order through refund states and may unpublish/revoke based on the disclosed product/refund policy. That policy must be decided before implementation.

## 3. Checkout creation

1. Authenticate customer and load design by owner ID.
2. Validate active template/version, asset readiness, design revision and SKU compatibility.
3. Resolve server price from versioned catalog. Apply eligible coupon server-side under usage constraints.
4. Create `orders`, `order_items` price snapshots and `payments` attempt with an idempotency key.
5. Call provider using a unique merchant reference and server amount/currency. Store provider checkout/session ID and expiry.
6. Return only checkout URL, opaque order ID and expiry.
7. If provider creation times out, reconcile using idempotency/merchant reference; do not create duplicate charge attempts.

If price changes between draft and checkout, show the authoritative price before redirect. Save the exact design revision used for the order; lock or snapshot it so checkout payment cannot publish a later, unpurchased revision.

## 4. Webhook and idempotency

- Verify signature over exact raw body, timestamp/nonce rules and configured endpoint secret.
- Insert unique `(provider, event_id)` before processing. Duplicate deliveries return 2xx after recording/confirming prior outcome.
- Match provider transaction and merchant reference to expected local payment; compare exact amount, currency, merchant account, environment and order state.
- Apply transitions in a database transaction where possible; use conditional updates so two concurrent webhooks cannot fulfill twice.
- Fulfillment/publication is a separate idempotent operation, retryable after a crash. Never keep a database transaction open while calling the provider, storage service or email API.
- Record only necessary, redacted webhook metadata and payload hash; no card/secret data.
- Provide reconciliation for missed/out-of-order webhooks using provider API and audited admin action.

## 5. Custom project payments

- An accepted quote creates a **deposit** order for exact quoted deposit amount. It cannot be edited after customer acceptance.
- Verified deposit changes project from `QUOTED` to `DEPOSIT_PAID`; admin can then start work.
- Preview approval creates the **balance** order from the accepted quote snapshot (or a new accepted quote for approved scope changes).
- Verified balance changes project to `DELIVERED` only after deliverables are ready. Do not treat a deposit as full payment.
- Additional work beyond quote requires a new/versioned quote and customer acceptance before work/charge.

The workflow and guards are detailed in [CUSTOM_DESIGN_WORKFLOW.md](CUSTOM_DESIGN_WORKFLOW.md).

## 6. Coupons, refunds and reconciliation

- Normalize coupon codes; validate active window, template/SKU eligibility, currency, per-customer limit and global remaining count at checkout.
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

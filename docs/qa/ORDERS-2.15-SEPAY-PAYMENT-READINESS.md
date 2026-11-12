# ORDERS-2.15 — SePay Payment Integration Readiness Audit

**Review date:** 2026-11-12  
**Classification: PARTIAL — PROVIDER VERIFICATION REQUIRED**

This audit verified the local synthetic payment contract only. No SePay account, remote provider settings, Vercel environment, Production resource, real transfer, or real transaction was accessed or changed.

## 1. Executive conclusion

**Local readiness: PASS for a controlled SePay Test-mode verification, subject to an isolated local endpoint and SePay Test-mode account setup. Overall result: PARTIAL — PROVIDER VERIFICATION REQUIRED.**

The local SePay webhook implementation follows the provider’s documented JSON payload fields, timestamped HMAC-SHA256 signature format, and successful acknowledgement body. Local synthetic tests pass for authoritative pricing, all five standard templates, signature checks, amount/reference/account validation, replay protection, failure recovery, and paid-order-gated fulfillment.

This is not evidence that a SePay Test-mode callback has reached Crushify. Test mode still requires an authorized Test-mode account/webhook and a publicly reachable, isolated endpoint. The app deliberately enables payment handling only in a local test runtime; Vercel Preview and Production do not receive payment mode or SePay configuration. No live-payment mode or production checkout is implemented.

## 2. Initial and final repository state

Initial and final repository identity:

- Branch: `main`
- HEAD: `5205f730fd0141fb9c8d0697787b700e4bda04ff`
- Initial worktree: 26 modified tracked paths and 6 untracked paths.
- Final worktree: those existing modifications and untracked files remain, plus this report as one new untracked file.

Pre-existing modified tracked paths:

```text
_headers
docs/HOSTING_MIGRATION.md
docs/PAYMENT_FLOW.md
docs/PRODUCT_ARCHITECTURE.md
docs/PUBLICATION_AND_DELIVERY.md
docs/STAGING_DEPLOYMENT.md
docs/VERCEL_STAGING.md
shared/customer-editor.js
src/platform/vercel.ts
templates/distance-means-nothing/index.html
templates/love-letter/index.html
templates/our-memories/index.html
templates/our-memories/our-memories.js
templates/our-universe/index.html
templates/say-yes/index.html
templates/say-yes/say-yes.css
templates/say-yes/say-yes.js
tests/browser-love-letter.mjs
tests/integration.mjs
tests/payment-contract.mjs
tests/publications.test.ts
tests/scheduler.test.ts
tests/template-registry.test.ts
vercel.json
wrangler.jsonc
wrangler.staging.jsonc
```

Pre-existing untracked paths:

```text
docs/qa/ORDERS-2.11C-FIVE-TEMPLATE-CHECKOUT.md
docs/qa/ORDERS-2.12-CONSOLIDATED-RELEASE-REVIEW.md
docs/qa/ORDERS-2.13-LIFECYCLE-CRON-RESOLUTION.md
docs/qa/ORDERS-2.14-TURSO-CLOUDINARY-READINESS.md
docs/qa/ORDERS-2.3-2.6-FINAL-QA-REPORT.md
tests/orders-2-10-browser-fixture.mjs
```

No source or test files were changed by this audit. No reset, checkout, clean, stash, commit, push, merge, or deployment occurred. `session.json` was not accessed. Final `git diff --check` passes.

## 3. Payment architecture

- `src/payments.ts` owns order creation, server-side price resolution, payment state, webhook processing, and routes.
- `src/payments/provider.ts` defines the provider boundary for instructions, signature verification, parsing, transaction normalization, and status mapping. `src/payments/sepay.ts` is the current sole provider implementation.
- Orders are tied to the authenticated customer’s owned draft Design and a server-computed VND total. The server persists pricing snapshots, separate random `CRF...` order and `CRP...` payment references, a pending payment, and a 15-minute order expiry. Client amount/status/payment claims are rejected.
- `src/publications.ts` requires paid/succeeded, matching verified webhook evidence before fulfillment/publication. No browser return or client-set status can mark an order paid.
- The HTTP endpoint is `POST /api/v1/payments/sepay/webhook`. Requests are JSON-only and bounded to 64 KiB.
- Migrations 0001, 0003, and 0004 establish payment orders, provider transaction uniqueness, unique provider event IDs, review metadata, raw event persistence, and retry tracking.

### Runtime and mock-mode isolation

**PASS — LOCAL IMPLEMENTATION**

- `paymentModeError` rejects order and webhook processing unless `ENVIRONMENT=local`, `LOCAL_TEST_MODE=true`, and `PAYMENT_MODE` is `mock` or `sepay-test`.
- Mock checkout emits no QR or bank instructions. The mock provider does not implement a public “mark paid” action; settlement still requires a valid local signed webhook.
- The Vercel adapter only forwards payment mode/secrets for `VERCEL_ENV=development` with local test mode. Preview and Production do not receive these values, and `runtimePaymentMode` never enables mock/Test settlement there.
- Current Wrangler staging variables identify staging, D1, and R2, with no payment-mode flags. The default Worker config has no payment-mode flag either. Production provider settings were not inspected.
- No live mode exists in the `PaymentProvider`/`Env` types or configuration documentation. The repository documentation explicitly describes live collection, production checkout, refunds, and production reconciliation as unimplemented.

## 4. Webhook security and transaction validation

### Signature and request validation

**PASS — LOCAL IMPLEMENTATION**

- Verifies HMAC-SHA256 over `{timestamp}.{exact raw body}` using `X-SePay-Timestamp` and `X-SePay-Signature: sha256=<hex>`.
- Enforces decimal timestamp syntax, fixed-length hexadecimal HMAC syntax, and a ±300 second timestamp window. The constant-time byte comparison runs after the exact signature format has been enforced.
- Missing, malformed, tampered, stale, and future signatures fail closed before payload processing. The endpoint requires `application/json`, limits request size, and rejects invalid UTF-8.
- HMAC secret configuration is required for webhook handling; local Test mode also validates the configured bank code/account formats.
- Public SePay documentation reviewed during this audit describes the same HMAC construction and headers, and the documented payload fields used here (`id`, `accountNumber`, `code`, `transferType`, `transferAmount`). Source: [SePay HMAC authentication](https://developer.sepay.vn/vi/sepay-webhooks/xac-thuc#hmac-sha256), [Webhook integration and payload](https://developer.sepay.vn/vi/sepay-webhooks/tich-hop-webhook).

### Payment matching and state guards

**PASS — LOCAL IMPLEMENTATION**

- Requires an incoming transfer, exact configured receiving account, exact `CRP` payment reference, safe integer transfer amount equal to the pending payment amount, VND currency, and equality between payment, order, and saved price-snapshot totals.
- Verifies the order is still `AWAITING_PAYMENT`, the payment is `PENDING`, review flags are clear, and expiry is in the future. Late, expired, cancelled, failed, already-paid, outbound, unmatched, wrong-account, under/overpayment, or wrong-reference events cannot settle the order.
- A provider transaction ID is globally unique per provider in `payments`; duplicate IDs cannot fulfill a second order. A payload collision for an already-seen event is recorded for review and cannot re-settle.
- Conditional state updates and atomic batches ensure order/payment/webhook/fulfillment state is consistent. Fulfillment jobs are unique per order. A failure during a batch leaves the webhook event recoverable as `RECEIVED`.
- Payment and review state changes are not exposed through unauthenticated customer routes; order status is owner-scoped.

### Idempotency and retry

**PASS — LOCAL IMPLEMENTATION**

- `(provider,event_id)` is unique; webhook payload hashes distinguish exact retries from same-ID/different-body collisions.
- `(provider,provider_payment_id)` uniqueness prevents transaction replay against another payment.
- Tests cover simultaneous identical webhook delivery, competing transaction IDs for one payment, reuse of a transaction ID against another payment, replay after processing, mismatched duplicate payloads, and retry following an injected database-batch failure.
- Identical provider retries receive HTTP 200 with `{"success":true}` after durable event handling. Invalid authentication returns 401; unsupported content type returns 415; malformed UTF-8 returns 400; oversized bodies return 413. Internal processing failure is allowed to return 5xx to trigger provider retry.
- `recoverPendingSePayWebhookEvents` provides bounded local recovery for retained `RECEIVED` events. No deployed scheduler or SePay API reconciliation job is configured for it; provider callback retry is the available documented recovery path.

### Logging and sensitive data

**PASS — LOCAL CODE REVIEW; broad runtime behavior not exhaustively observable**

- Payment handlers do not explicitly log secrets, HMAC signatures, raw request bodies, account numbers, or transaction payloads. The SePay adapter surfaces generic provider errors rather than provider response bodies.
- The shared API top-level error handler logs an error object for unexpected failures. No local test demonstrated that such an error contains payment secrets or payload data, but all possible driver/runtime error serialization has not been exhaustively proven. Restrict production logs and avoid adding raw webhook/error logging.
- Raw webhook JSON is persisted for retry and review and may include bank-account/transaction metadata; access and retention must be reviewed before any production system stores it.

## 5. Synthetic checkout and payment contract evidence

### All five standard templates

- `tests/integration.mjs` invokes `runPaymentContract` with `allTemplates: true` and `testStandardPricing: true`.
- The contract creates/orders/settles synthetic drafts for Our Universe, Love Letter, Our Memories, Say Yes, and Distance Means Nothing, verifies payment status and fulfillment/publication artifacts, and checks foreign-owner access.
- The legacy all-template publication fixtures use synthetic local fixture prices. The approved standard pricing grid is separately checked by server-side order creation and saved snapshots. This is not a real provider payment.
- The ORDERS-2.11C report records authenticated mock browser checkout for all five templates at 59,000 VND, pending status across reload, no bank QR/instructions, and its bounded double-submit observation. This is browser evidence for mock checkout, not SePay delivery.

### Pricing

**PASS — LOCAL SYNTHETIC SERVER CONTRACT**

The integration contract validates server-generated standard pricing and snapshots:

| Term | Expected total |
|---|---:|
| 1 month | 59,000 VND |
| 2 months | 69,000 VND |
| 3 months | 79,000 VND |
| 6 months | 109,000 VND |
| 12 months | 169,000 VND |
| Lifetime | 199,000 VND |

Negative/unsupported durations, unsupported plans, client amount tampering, malformed Design IDs, and missing/unowned Design cases are rejected. No pricing was changed. No Premium or Custom Design amount is inferred from this grid.

### Webhook cases

Local payment unit and integration contracts exercise:

- Valid HMAC; missing, invalid, stale, future, body-tampered signature; wrong content type; malformed UTF-8.
- Correct payment reference, amount, receiving account, and incoming direction.
- Wrong account, wrong reference, unmatched reference, underpayment, overpayment, outgoing transfer, malformed payload.
- Concurrent identical delivery and replay; competing transaction IDs; provider transaction ID reuse on another order.
- Expired and cancelled order rejection; failed batch recovery and provider retry.
- VND mismatch and tampered pricing snapshot rejection.
- Paid-order fulfillment/publication eligibility and exactly one payment, processed event, publication, entitlement, and fulfillment job in the tested contract.

The provider transaction ID is not independently queried against SePay; it is trusted only as part of a valid HMAC-authenticated provider request and must satisfy local uniqueness. There is no provider-side transaction reconciliation API in this implementation.

## 6. Provider configuration and staging requirements

### Documented server-side configuration names

The code/docs name `PAYMENT_MODE`, `SEPAY_WEBHOOK_SECRET`, `SEPAY_BANK_CODE`, `SEPAY_BANK_ACCOUNT`, and optional `SEPAY_ACCOUNT_NAME`. Values were not inspected, printed, or copied.

The local SePay Test mode setup docs require:

1. A separate SePay Test-mode bank account and webhook, not Live account settings.
2. SePay’s HMAC-SHA256 webhook authentication and an isolated publicly reachable endpoint.
3. Configuring the payment-code parser to extract the `CRP` payment reference into payload `code`.
4. Matching the local `SEPAY_BANK_ACCOUNT` to the Test-mode receiving account.
5. A synthetic, disposable local price/order and simulated Test-mode transfer.
6. Verification in SePay’s webhook delivery history; no production enablement.

SePay’s public docs describe HTTP POST delivery, JSON payload, HMAC authentication, and success acknowledgement requirements. Provider-side configuration and delivery were not observed.

### Staging limitation

- Vercel Preview does not forward payment settings to the API, and the payment guard independently disables non-local payment processing. Therefore the Vercel Preview deployment is not a supported provider-backed payment test endpoint today.
- Current Wrangler staging configuration selects staging/D1/R2 and has no payment-mode configuration. The payment guard would reject order/webhook activity outside local mode.
- A controlled callback may be tested only after separately authorized Test-mode account setup and an isolated reachable local test endpoint that remains in `ENVIRONMENT=local` with synthetic data. This audit did not establish or expose such an endpoint and did not connect it to SePay.
- No Production variables, remote provider settings, or deployment settings were accessed. No Live credentials or transactions were used.

## 7. Confirmed defects and changes

**Confirmed payment implementation defect: none found.** No source, test, migration, configuration, price, or existing report file was modified by this audit. The only task-created file is this report.

Unverified/provider-dependent items are not classified as code defects:

- Actual Test-mode webhook delivery, HMAC secret agreement, payload compatibility, provider retries, and account mapping.
- Public endpoint TLS/routing and timeout behavior under SePay delivery.
- Provider-side simulated transaction and webhook history.
- Provider account limits, onboarding, fees, settlement, refunds, and any Live capability.
- Production checkout, reconciliation, refunds, administrative review, and live payment are explicitly not implemented.

## 8. Regression results

All commands ran locally with synthetic/in-memory fixtures. Integration ran sequentially, not concurrently with another integration suite.

| Command | Result | Evidence |
|---|---|---|
| `node --experimental-strip-types --test tests/payments.test.ts` | PASS | 7 passed; 0 failed. Signature, malformed payload, QR gating, reference generation, local-only runtime, and mock safeguards. |
| `npm run typecheck` | PASS | `tsc --noEmit`; exit code 0. |
| `npm test` | PASS | 91 passed; 0 failed, cancelled, or skipped. |
| `npm run test:integration` | PASS | `Local integration: passed (D1 API and payment contracts, legacy regression, constraints, and batch rollback).` Includes the synthetic all-template payment contract and standard pricing checks. |
| `npm audit --omit=dev` | PASS | `found 0 vulnerabilities`. |
| `git diff --check` | PASS | Exit code 0; no whitespace errors. |

No SePay API, bank, Production database, or real transaction was used by these tests.

## 9. Final worktree status and classification

Final `git status --short --untracked-files=all` contains the same 26 pre-existing modified tracked files and 6 pre-existing untracked files listed in §2, plus:

```text
?? docs/qa/ORDERS-2.15-SEPAY-PAYMENT-READINESS.md
```

Branch and HEAD remain `main` / `5205f730fd0141fb9c8d0697787b700e4bda04ff`.

# PARTIAL — PROVIDER VERIFICATION REQUIRED

The local payment contract is ready for an authorized, isolated SePay Test-mode verification, but no provider-backed staging verification has occurred. Keep Vercel Preview/Production payment-disabled. Do not enable Live payment based on these local results.

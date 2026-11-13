# ORDERS-2.26 — Preview Mock Payment Isolation

**Verdict: PARTIAL — Preview cannot invoke or accept SePay payments, but Preview mock settlement is intentionally unavailable, and the repository does not currently enable Production SePay checkout/webhooks.**

## Baseline and final refs

- Initial and final branch: `main`
- Initial and final `HEAD`: `84acc4c19a143805830495671e076bbc395db3e3`
- No commit, push, merge, or deployment was performed.
- Initial worktree had no staged files, 18 modified tracked files, and 4 untracked files. These pre-existing changes were preserved.
- Final worktree: no staged files, 24 modified tracked files, and 6 untracked files (including this report and the new policy module).
- No migration or remote resource was changed.

Pre-existing modified tracked paths at the start:

`.env.example`, `README.md`, `docs/API_SPECIFICATION.md`, `docs/DATABASE_SCHEMA.md`, `docs/HOSTING_MIGRATION.md`, `docs/SECURITY_PLAN.md`, `docs/VERCEL_STAGING.md`, `scripts/staging-config.ts`, `scripts/staging-turso.ts`, `src/auth.ts`, `src/platform/vercel.ts`, `src/storage/cloudinary-policy.ts`, `tests/database-contract.test.ts`, `tests/pre-staging-security.test.ts`, `tests/staging-config.test.ts`, `tests/storage.test.ts`, `tests/vercel.test.ts`, and `tests/worker.test.ts`.

Pre-existing untracked paths at the start:

`docs/qa/ORDERS-2.23-TURSO-STAGING-DATABASE-ISOLATION.md`, `docs/qa/ORDERS-2.24-CLOUDINARY-STAGING-ISOLATION.md`, `docs/qa/ORDERS-2.25A-PREVIEW-AUTH-GATE-REMEDIATION.md`, and `tests/auth-environment.test.ts`.

Final modified tracked paths:

`.env.example`, `README.md`, `docs/API_SPECIFICATION.md`, `docs/DATABASE_SCHEMA.md`, `docs/HOSTING_MIGRATION.md`, `docs/PAYMENT_FLOW.md`, `docs/SECURITY_PLAN.md`, `docs/SEPAY_SETUP.md`, `docs/VERCEL_STAGING.md`, `scripts/staging-config.ts`, `scripts/staging-turso.ts`, `src/auth.ts`, `src/payments.ts`, `src/platform/vercel.ts`, `src/publications.ts`, `src/storage/cloudinary-policy.ts`, `tests/database-contract.test.ts`, `tests/payment-contract.mjs`, `tests/payments.test.ts`, `tests/pre-staging-security.test.ts`, `tests/staging-config.test.ts`, `tests/storage.test.ts`, `tests/vercel.test.ts`, and `tests/worker.test.ts`.

Final untracked paths:

`docs/qa/ORDERS-2.23-TURSO-STAGING-DATABASE-ISOLATION.md`, `docs/qa/ORDERS-2.24-CLOUDINARY-STAGING-ISOLATION.md`, `docs/qa/ORDERS-2.25A-PREVIEW-AUTH-GATE-REMEDIATION.md`, `docs/qa/ORDERS-2.26-PREVIEW-MOCK-PAYMENT-ISOLATION.md`, `src/payments/policy.ts`, and `tests/auth-environment.test.ts`.

## Finding and root cause

Payment enablement was local-only, but the code used one hard-coded `SEPAY` provider identifier for order reads/writes and settlement. Vercel Preview had no centrally resolved payment mode, and there was no explicit distinction between a future staging mock payment and SePay settlement. The webhook path was not gated by a provider-selection policy.

The inspection also found an architecture mismatch with the task premise: current docs and code expose only local `mock` / `sepay-test` modes. Production checkout and SePay webhook processing are disabled. The Production policy retains the SePay provider identity, but this does not enable live payments. Production configuration and behavior were not broadened.

## Provider-selection policy

| Runtime | Selected provider/mode | Order creation | SePay webhook / recovery | Fulfillment |
|---|---|---|---|---|
| Production | `SEPAY`; no enabled mode | Disabled, as before | Disabled, as before | Existing recovery of already-verified SePay records remains available |
| Vercel Preview / staging | `MOCK` / `mock`, selected internally | Payment policy allows mock only; the existing Preview auth gate returns `AUTH_UNAVAILABLE` before payment-table reads/writes | Rejected before body/signature processing or payment-table access | Disabled |
| Local development | Existing `mock` or `sepay-test` behavior | Preserved | Synthetic local HMAC contract preserved | Existing local verified-payment flow preserved |
| Unknown / ambiguous | No provider | Disabled | Disabled | Disabled |

Preview rejects user-configured `PAYMENT_MODE` and `SEPAY_*` variables. Its internal mock selection does not require or accept a provider supplied by the request. Any hypothetical staging order uses provider `MOCK`, has `mock_mode: true`, and receives no QR/bank instructions.

## Route and settlement inventory

- `GET /api/v1/catalog` and `GET /api/v1/storage-plans` remain public read-only routes.
- `POST /api/v1/orders`, `GET /api/v1/orders`, and order status reads retain customer-session requirements. Preview's existing auth gate prevents order creation and status access before payment-table queries or writes.
- `POST /api/v1/payments/sepay/webhook` is rejected in Preview with `MOCK_SETTLEMENT_UNAVAILABLE`, before body parsing, signature verification, or database access.
- Internal `recoverPendingSePayWebhookEvents` fails closed outside its enabled local test policy.
- `handleFulfillmentForOrder` and `recoverPendingFulfillments` reject staging and unknown runtimes before database access. Publication and fulfillment SQL continue to require `SEPAY` provider rows with processed webhook evidence, so a `MOCK` record cannot be interpreted as a SePay settlement.
- No mock-confirmation, refund, cancellation, admin payment, or provider-API reconciliation route exists. There is no outbound SePay payment API client in the inspected flow; local SePay Test instructions are generated locally. Preview mock mode emits no payment link/instructions.
- Request bodies containing client-supplied payment/provider claims are rejected by the order schema.

## Mock confirmation limitation

Preview customer authentication is intentionally disabled, so the existing order flow cannot create an order there. There is also no staging operator-authentication capability. No unauthenticated or customer-cookie-free settlement endpoint was added: doing so without an approved operator capability would create a new state-changing path without an authorized principal.

Therefore Preview mock checkout, confirmation, and fulfillment remain unavailable. A future staging settlement design requires a separately approved operator-only capability, isolated to the Preview database, scoped to `MOCK` orders, and unable to write `SEPAY` settlement evidence. This prerequisite is unresolved; customer authentication was not re-enabled.

## Tests and side-effect evidence

- Focused payment tests: **11 passed, 0 failed**.
- Focused payment + Vercel isolation tests: **23 passed, 0 failed**.
- `npm test`: **138 passed, 0 failed; 27 suites**.
- `npm run typecheck`: passed.
- `npm run test:integration`: passed — local D1 API/payment contracts, legacy regression, constraints, and batch rollback. The harness used temporary local D1 state and a loopback-only synthetic email sink.
- `git diff --check`: passed.

Synthetic spies/assertions verify:

- Preview order creation returns `AUTH_UNAVAILABLE` before payment DB queries/writes.
- A correctly signed synthetic SePay webhook in Preview returns `MOCK_SETTLEMENT_UNAVAILABLE` with zero database calls.
- Preview fulfillment and webhook recovery reject before database access.
- A Preview mock-confirmation URL is not implemented (404); no settlement path was introduced.
- Vercel Preview rejects injected `sepay-test` mode and synthetic SePay credentials; its internal mode resolves to mock.
- Existing local mock and SePay Test payment contracts, including HMAC validation, replay/idempotency, duplicate events, and verified fulfillment, passed.
- Production route guards remain disabled as before; the HMAC verification implementation was not weakened or changed.

## Changed by ORDERS-2.26

- Added `src/payments/policy.ts`.
- Updated `src/payments.ts`, `src/platform/vercel.ts`, and `src/publications.ts`.
- Updated `tests/payments.test.ts`, `tests/payment-contract.mjs`, and the existing modified `tests/vercel.test.ts`.
- Updated `docs/PAYMENT_FLOW.md`, `docs/SEPAY_SETUP.md`, and the existing modified `docs/VERCEL_STAGING.md`.
- Added this report.

## Remaining risks and verification gaps

- Production SePay checkout/webhook support is not present in the inspected baseline despite the task's stated assumption. Production behavior was deliberately not activated. An owner-approved production payment design/configuration change is required before claiming that Production payment creation or webhook processing is available.
- Preview's mock provider is selected, but no Preview mock order can be created or settled while customer auth is disabled. The operator-only mock-confirmation design needs owner approval and a separate reviewed implementation.
- No Vercel, Turso, SePay, bank, Cloudinary, email, or Production resource was contacted. Remote Preview configuration and database identity remain unverified.
- No real payment, real webhook, remote migration, environment-variable update, commit, push, merge, or deployment occurred.

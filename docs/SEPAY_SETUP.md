# SePay Test mode setup

## Safety status

Crushify implements local synthetic payment tests and an explicitly gated Vercel Preview SePay Test-mode path, plus an observation-only SePay API v2 client. SePay Live collection and Production checkout/webhook settlement are **NOT ENABLED**; refunds, scheduled API polling, automatic reconciliation, and an operator review workflow are not implemented. API observations cannot settle an order or authorize fulfillment/publication. The `template_prices` table is empty by default. Never put a Live secret or real-money account configuration in local or Preview settings; Preview may use only an owner-approved isolated SePay Test-mode account.

The route is `POST /api/v1/payments/sepay/webhook`. It accepts `application/json` up to 64 KiB, verifies `X-SePay-Signature: sha256=<hex>` over `{X-SePay-Timestamp}.{raw_body}`, rejects timestamps outside ±300 seconds, and requires valid UTF-8. A valid event is only applied when its transaction ID is unique, its transfer is incoming, its payment reference exactly matches, the receiving account matches the environment-scoped Test-mode settings (local or fully gated Preview), the amount is exact, and the order is still pending and unexpired. Verified unmatched or mismatched events are retained with attempt count, expected/actual amount and a reason for review.

Migration 0015 adds `payment_settlement_evidence` as the authoritative proof for fulfillment and publication. A successful webhook atomically records `SEPAY_WEBHOOK` evidence with the payment/order transition and processed event. Migration 0016 adds a separate observation store and scan cursors for SePay API v2 transaction UUIDs. API observations are not inserted into `payment_settlement_evidence`; a transaction UUID must not be copied into legacy `payments.provider_payment_id` or assumed equal to a webhook event ID.

The migration backfills only legacy payments with a matching processed webhook, valid provider transaction ID and payload hash, known processing timestamp, matching amount/currency, consistent paid states, and no review flag or contradictory webhook. Other records remain without verified evidence and are blocked from fulfillment/publication for manual investigation. Backfill does not change order/payment states or trigger customer-facing side effects. SePay's webhook `{"success":true}` is only a delivery acknowledgment, not proof that Crushify processed or settled a payment.

## SePay API v2 observations (not settlement)

The typed client in `src/payments/sepay-api-v2.ts` reads `GET /v2/transactions` with Bearer authentication, bounded requests/responses, sequential pagination, and bounded 429/5xx retries. It permits only the documented API origins:

- Production: `https://userapi.sepay.vn/v2`
- Sandbox: `https://userapi-sandbox.sepay.vn/v2`

The API token has broad account and transaction access according to SePay's documentation. A Preview-only manual runtime trigger exists, but it is disabled unless the complete Preview-scoped configuration is supplied. Whether an API token/account is configured or a deployment/runtime invocation exists is **NOT VERIFIED**. The trigger uses a fixed Sandbox origin; it has no cron schedule and is not available in Production. Unit tests inject mock fetch responses; the local D1 contract uses in-process synthetic responses. Neither contacts SePay.

`src/payments/sepay-reconciliation.ts` persists only selected fields (transaction UUID, bank-account UUID, date, direction, integer in/out amounts, `reference_number`, `code`, `webhook_success`, and a hash of those normalized fields). It does not request/store the account number, transaction content, balance/`accumulated`, or an inferred currency. Each page's observations and continuation position are persisted atomically under the database lease and fencing token. A failed page does not advance its continuation pointer; already persisted pages are not fetched again. The completed scan cursor advances only after the final page has been durably recorded. If execution stops after the final page is saved but before cursor completion, the next run finalizes from durable state without refetching that page. Repeated observations are idempotent. Changed facts for a previously seen UUID are retained as manual review without overwriting its original data or payment ownership.

The API response does not establish a mapping between `reference_number` and Crushify's webhook `code`/`CRP` payment reference. The API's `code` may be null, and provider contract testing has not verified the reference semantics. The matching policy therefore requires an explicitly verified reference mapping and independently established currency; those facts are not supplied by the API adapter. Until they are validated, records remain unmatched/manual-review. Matching is exact only—never by amount, fuzzy content, or `webhook_success`. The policy also rejects wrong direction/account, amount mismatch, ambiguous matches, historical transactions, ineligible/expired orders, review flags, and ownership conflicts. It produces a candidate only; there is no automatic order transition, fulfillment, entitlement, or publication path.

Initial history must be scanned in bounded date windows and treated as observation-only. The date-window filter format is SePay's documented `YYYY-MM-DD HH:mm:ss`; the implementation formats these bounds in `Asia/Ho_Chi_Minh` based on SePay's documented output timezone and requests `timestamp_format=iso8601` for returned transaction dates. The docs do not explicitly state the filter timezone, so date-window filtering requires Sandbox validation before operational use. `SINCE_ID` and date-window scans have separate durable cursors. Date-window scans overlap the previous completed window (one day in the Preview trigger; up to seven days is supported by the scan service) to catch late arrivals within the configured interval; the provider's maximum synchronization delay is **NOT VERIFIED**, so arrivals older than the overlap may be missed. A scan window is capped at 31 days. The client requests ascending transaction-date order, but provider ordering guarantees, page-snapshot consistency, and `since_id` boundary semantics are **NOT VERIFIED**. Inconsistent page metadata, repeated pages, or decreasing transaction dates fail closed without advancing past the affected page. A changed dataset may still shift page-number boundaries; the completed-window overlap is a bounded recovery measure, not a guarantee against arbitrarily late backfills.

The scan foundation and manual Preview trigger have local mocked-fetch/database test coverage; they have not been verified against SePay Sandbox. The trigger is `POST /api/ops/staging/sepay-reconciliation`; it requires a Preview-only 32-byte hex operator secret in `PREVIEW_SEPAY_RECONCILIATION_SECRET`, rejects a request body or query parameters, uses a fixed Sandbox host, and is not scheduled. Each invocation is bounded to four pages of 100 records, a 31-day initial window, 4-second API request timeouts, one retry, and a 120-second database lease; the Vercel function has a 60-second maximum duration. If more than 400 records remain, the route returns HTTP 206 with `status: partial`, the durable next page, and the provider-reported page/record counts; invoke it again to continue. Those counts are estimates if the provider's result set changes during pagination. A failed request returns a failure class and code; a repeated pagination inconsistency leaves the same page pending and is an operational cursor stall, not a successful scan. There is no cursor-reset endpoint or automatic retry/scheduler; stop and obtain owner-reviewed recovery guidance rather than editing cursor rows manually. Completed cursor advancement requires all pages to persist under the current lease. No operator review/approval workflow exists. Before any Sandbox scan, the owner must verify token scope, receiving bank-account UUID, parser behavior for `code` versus `reference_number`, date-window behavior, transaction ordering/pagination semantics, synchronization delay, and account currency. Preview reconciliation configuration and execution are **NOT VERIFIED**; Production use is **NOT ENABLED**.

The Preview-only configuration names are `PREVIEW_SEPAY_RECONCILIATION_ENABLED`, `PREVIEW_SEPAY_API_TOKEN`, `PREVIEW_SEPAY_API_BANK_ACCOUNT_ID`, `PREVIEW_SEPAY_RECONCILIATION_SECRET`, and `PREVIEW_SEPAY_RECONCILIATION_START_AT`. The token and account UUID must belong to Sandbox; production and generic API credential variables are rejected in Preview, and Preview-scoped variables are rejected in Production. Never place these values in browser-visible variables, logs, or documentation.

## Preview and Production isolation

- Vercel Preview payment defaults to disabled. The customer flow is opt-in only when `PREVIEW_CUSTOMER_FLOW_ENABLED=true`, `PREVIEW_PAYMENT_MODE=sepay-test`, and the complete Preview configuration validates. Generic `PAYMENT_MODE` and `SEPAY_*` variables are rejected; only the Preview-scoped webhook and bank settings are mapped into the application when the gate is enabled.
- The Preview gate also requires an exact-email allowlist, isolated Turso database, dedicated Cloudinary staging configuration, Preview mail settings, and a lifecycle secret. When complete, Preview can create SePay Test-mode orders and process signed webhooks; there is no public mock-confirmation route. Configuration and deployed behavior are **NOT VERIFIED**.
- Fulfillment/publication still requires matching, verified `SEPAY_WEBHOOK` settlement evidence. Preview fulfillment/publication code is gated by the same opt-in flow; a SePay API v2 observation cannot authorize it.
- Production checkout and SePay webhook settlement are **NOT ENABLED**. The production policy permits recovery attempts for existing fulfillment jobs, but publication mutations are disabled in Production; this is not a production-ready purchase or fulfillment flow. Production configuration and deployment are **NOT VERIFIED**.

## Local mock workflow

1. Copy `.dev.vars.example` to `.dev.vars` only if `.dev.vars` does not already exist. Keep `.dev.vars` ignored and do not commit it.
2. Set `ENVIRONMENT=local` and `PAYMENT_MODE=mock`. Do not print a webhook secret to the terminal. The integration test creates an ephemeral secret in memory for synthetic webhooks; a manual local webhook test may use a separately generated local-only value stored directly in the ignored server environment.
3. Apply migrations to the local D1 database with `npm run db:apply:local`; run the Worker with `npm run dev`. The normal migration does not add prices.
4. For a controlled test only, insert one synthetic price into the local database. Use an isolated disposable database and never use `--remote`:

   ```sql
   INSERT INTO template_prices (
     id, template_id, schema_version, currency, amount_minor, is_active, created_at, updated_at
   ) VALUES (
     'local-payment-test-price', 'our-universe', 1, 'VND', 50000, 1,
     '2026-11-05T00:00:00.000Z', '2026-11-05T00:00:00.000Z'
   );
   ```

5. Sign in through the local Our Universe flow, create an owned draft, then open `/checkout/?design_id=<draft-id>`. The order requires a session and CSRF token. Mock mode displays no QR or transfer details and does not provide a public “mark paid” action.
6. Run `npm test` and `npm run test:integration` to exercise generated signed webhook fixtures. These tests use synthetic prices and a per-run secret; they do not call SePay or any bank.

The example price is a test fixture only, not a Crushify offer or recommended price. Remove disposable database files rather than attempting to reuse test orders as customer data.

## SePay Test mode (account access required)

Whether the project is connected to a SePay account is **NOT VERIFIED**. An actual provider Sandbox check requires owner approval and access:

1. In `my.sepay.vn`, switch to **Test mode** and create a Test mode bank account. Do not copy Live bank settings or secrets.
2. Configure SePay's payment-code parser to recognize the generated `CRP` payment reference in transfer content. `CRF` identifies the separate order reference and must not be used to match a transfer. Create a Test mode webhook pointing to an isolated, publicly reachable test endpoint. SePay's Test mode can simulate transfers and uses the same JSON payload and HMAC-SHA256 mechanism as Live; use HMAC rather than “No authentication.”
3. Store the generated Test mode webhook secret and Test mode bank code/account only in the local server environment. Select `PAYMENT_MODE=sepay-test`. The authenticated order response supplies the Test mode transfer details and a copyable payment reference to the checkout; no bank settings are compiled into frontend assets. Do not expose webhook secrets in frontend variables.
4. Activate a synthetic catalog row only in the disposable local database. Configure the receiving account to exactly match the Test mode account.
5. Simulate an incoming transfer with the exact payment reference and amount; verify a single order changes to `PAID`. Then test under/overpayment, wrong receiving account, outgoing transfer, unmatched reference, replay, and webhook retry. Confirm mismatches become `MANUAL_REVIEW`.
6. Check SePay's webhook history and confirm the endpoint returns HTTP 200 or 201 with JSON `{"success":true}` only after the event is durably recorded. That response does not itself authorize payment; only matching `VERIFIED` settlement evidence does. Keep the test endpoint and data isolated.

SePay Test mode requires account access and may have account-specific limits. Its documentation describes isolated simulated transactions; it does not mean this repository has passed a real SePay Test mode test. Do not tunnel an endpoint containing Live credentials. The app has an internal bounded recovery function for retained events and provider retry reprocessing, but pending-event recovery is not scheduled and no provider API reconciliation job or operator review screen exists.

## Environment variables

| Variable | Use | Local restriction |
|---|---|---|
| `PAYMENT_MODE` | `mock` or `sepay-test` | Local test configuration only. Preview uses `PREVIEW_PAYMENT_MODE=sepay-test` under the explicit customer-flow gate; Production has no live mode. |
| `SEPAY_WEBHOOK_SECRET` | HMAC verification | Local Test mode secret only; keep server-side. |
| `SEPAY_BANK_CODE` | Test mode QR instructions | Required only for `sepay-test`; never pass to browser as configuration. |
| `SEPAY_BANK_ACCOUNT` | Expected incoming account and QR instructions | Must be the isolated Test mode account. |
| `SEPAY_ACCOUNT_NAME` | Optional account name shown in owner-scoped Test mode instructions | Display only; it is not used to authorize a payment. |

`PaymentProvider` is the provider boundary for creating transfer instructions, verifying signed webhooks, parsing payloads, and normalizing transactions. SePay is currently the sole implementation. `CRF` order references and `CRP` payment references are separate random values; only the `CRP` reference is matched to the webhook's `code`.

Vercel Preview maps only the Preview-scoped Test-mode settings into the API runtime when the full customer-flow gate is enabled; generic local `PAYMENT_MODE`/`SEPAY_*` settings are not forwarded. Production checkout and webhook settlement remain disabled. Whether any external credentials or deployment are configured is **NOT VERIFIED**. Cloudflare staging is a legacy, unapproved path; do not run its remote scripts without separate owner approval. There is intentionally no Production payment activation procedure.

## References

- [SePay Test mode quick start](https://developer.sepay.vn/vi/sepay-webhooks/test-mode/bat-dau-nhanh)
- [Test mode vs Live](https://developer.sepay.vn/vi/sepay-webhooks/test-mode/so-sanh-voi-live)
- [SePay webhook HMAC authentication](https://developer.sepay.vn/vi/sepay-webhooks/xac-thuc#hmac-sha256)
- [SePay webhook security checklist](https://developer.sepay.vn/vi/sepay-webhooks/bao-mat)
- [Webhook payload, idempotency, and valid response](https://developer.sepay.vn/vi/sepay-webhooks/tich-hop-webhook)
- [Retry and delivery failures](https://developer.sepay.vn/vi/sepay-webhooks/xu-ly-loi)
- [SePay API v2 transaction list and pagination](https://developer.sepay.vn/vi/sepay-api/v2/giao-dich/danh-sach)
- [SePay API v2 authentication and rate limits](https://developer.sepay.vn/vi/sepay-api/v2/xac-thuc)
- [SePay API v2 Sandbox](https://developer.sepay.vn/vi/sepay-api/v2/sandbox)

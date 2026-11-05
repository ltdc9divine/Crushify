# SePay Test mode setup

## Safety status

Crushify currently implements only a local order and webhook-verification prototype. It does not support SePay Live, real-money collection, production checkout, refunds, order fulfillment, entitlements, publication, admin reconciliation, or automatic price management. The `template_prices` table is empty by default. Never put a real bank account or Live secret in local or preview configuration.

The route is `POST /api/v1/payments/sepay/webhook`. It accepts JSON up to 64 KiB, verifies `X-SePay-Signature: sha256=<hex>` over `{X-SePay-Timestamp}.{raw_body}`, and rejects timestamps outside ±300 seconds. A valid event is only applied when its transaction ID is unique, its transfer is incoming, its payment reference exactly matches, the receiving account matches configured local Test mode settings, the amount is exact, and the order is still pending and unexpired. Verified unmatched or mismatched events are retained for manual review.

## Local mock workflow

1. Copy `.dev.vars.example` to `.dev.vars` only if `.dev.vars` does not already exist. Keep `.dev.vars` ignored and do not commit it.
2. Set `ENVIRONMENT=local`, `PAYMENT_MODE=mock` and generate a random local `SEPAY_WEBHOOK_SECRET` (for example with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`). The development secret is not a SePay credential and must not be reused elsewhere.
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

5. Sign in through the local Our Universe flow, create an owned draft, then open `/checkout/?design_id=<draft-id>`. The order requires a session and CSRF token. Mock mode displays no QR and does not provide a public “mark paid” action.
6. Run `npm test` and `npm run test:integration` to exercise generated signed webhook fixtures. These tests use synthetic prices and a per-run secret; they do not call SePay or any bank.

The example price is a test fixture only, not a Crushify offer or recommended price. Remove disposable database files rather than attempting to reuse test orders as customer data.

## SePay Test mode (account access required)

The project has not been connected to a SePay account. To run an actual provider sandbox check after getting approval and access:

1. In `my.sepay.vn`, switch to **Test mode** and create a Test mode bank account. Do not copy Live bank settings or secrets.
2. Configure SePay's payment-code parser to recognize the generated `CRF` reference in transfer content. Create a Test mode webhook pointing to an isolated, publicly reachable test endpoint. SePay's Test mode can simulate transfers and uses the same JSON payload and HMAC-SHA256 mechanism as Live; use HMAC rather than “No authentication.”
3. Store the generated Test mode webhook secret and Test mode bank code/account only in the local server environment. Select `PAYMENT_MODE=sepay-test`. Do not expose secrets or bank settings in frontend variables.
4. Activate a synthetic catalog row only in the disposable local database. Configure the receiving account to exactly match the Test mode account.
5. Simulate an incoming transfer with the exact payment reference and amount; verify a single order changes to `PAID`. Then test under/overpayment, wrong receiving account, outgoing transfer, unmatched reference, replay, and webhook retry. Confirm mismatches become `MANUAL_REVIEW`.
6. Check SePay's webhook history and confirm the endpoint returns HTTP 200 or 201 with JSON `{"success":true}` only after the event is durably recorded. Keep the test endpoint and data isolated.

SePay Test mode requires account access and may have account-specific limits. Its documentation describes isolated simulated transactions; it does not mean this repository has passed a real SePay Test mode test. Do not tunnel an endpoint containing Live credentials. The app has no provider API reconciliation job or operator review screen.

## Environment variables

| Variable | Use | Local restriction |
|---|---|---|
| `PAYMENT_MODE` | `mock` or `sepay-test` | Accepted only in local test mode. No `live` value exists. |
| `SEPAY_WEBHOOK_SECRET` | HMAC verification | Local Test mode secret only; keep server-side. |
| `SEPAY_BANK_CODE` | Test mode QR instructions | Required only for `sepay-test`; never pass to browser as configuration. |
| `SEPAY_BANK_ACCOUNT` | Expected incoming account and QR instructions | Must be the isolated Test mode account. |
| `SEPAY_ACCOUNT_NAME` | Reserved for future display/verification | Not used to authorize a payment. |

Vercel Preview and Production do not pass these settings into the API runtime. Cloudflare remote deployments have not been changed. There is intentionally no documented production activation procedure.

## References

- [SePay Test mode quick start](https://developer.sepay.vn/vi/sepay-webhooks/test-mode/bat-dau-nhanh)
- [Test mode vs Live](https://developer.sepay.vn/vi/sepay-webhooks/test-mode/so-sanh-voi-live)
- [SePay webhook HMAC authentication](https://developer.sepay.vn/vi/sepay-webhooks/xac-thuc#hmac-sha256)
- [SePay webhook security checklist](https://developer.sepay.vn/vi/sepay-webhooks/bao-mat)
- [Webhook payload, idempotency, and valid response](https://developer.sepay.vn/vi/sepay-webhooks/tich-hop-webhook)
- [Retry and delivery failures](https://developer.sepay.vn/vi/sepay-webhooks/xu-ly-loi)

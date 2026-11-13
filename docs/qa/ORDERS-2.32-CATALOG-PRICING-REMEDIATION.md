# ORDERS-2.32 — Product Catalog & Pricing Remediation

**Verdict: PARTIAL — REMOTE OR OWNER ACTION REQUIRED**

The local standard catalog and pricing contract now exposes all five standard templates and calculates the approved prices consistently. Production and Preview checkout remain disabled. Remote migration state and provider configuration were not inspected or changed.

## 1. Git baseline

At task start:

- Branch: `main`
- HEAD: `84acc4c19a143805830495671e076bbc395db3e3`
- Staged paths: 0
- Modified tracked paths: 27
- Untracked paths: 11

The pre-existing changes and untracked files were preserved. No commit, push, merge, or deployment was performed.

## 2. Root cause

- `STANDARD_CATALOG_ENABLED` was `false`; all five standard duration records also had `enabled: false` and `amountMinor: null`.
- The five template products were already present and marked available, and migrations seed all five template records as `ACTIVE`. The inactive global catalog gate prevented the standard pricing path from being used.
- Migration `0006_storage_entitlements.sql` seeds the standard `storage_plans` as `ACTIVE`, but does not seed active `storage_plan_prices`. Standard prices therefore come from the centralized application policy, not those database price rows. The legacy local fixture path continues to use synthetic database prices.
- The homepage and checkout copy incorrectly said the first month was excluded and that hosting/Lifetime prices were unapproved.

## 3. Changes made

### Catalog and server pricing

- Enabled the centralized standard catalog and its approved duration options.
- Kept the five standard templates as the only standard products. Premium and Custom Design do not resolve through the standard catalog.
- `/api/v1/catalog` now returns approved initial-purchase totals and a separate `checkout_enabled` capability. The distinction prevents catalog visibility from enabling Production or Preview order creation.
- Initial pricing uses the server-authoritative formula `59,000 + max(0, months - 1) × 10,000` VND, with no recurring billing and no duration cap beyond safe-integer/valid-total checks. Lifetime is 199,000 VND.
- `/api/v1/storage-plans` returns renewal charges of 10,000 VND per renewed month. Lifetime renewals/upgrades are not offered because no separate upgrade price was specified.
- Custom month terms remain supported through the duration-based order request; the server persists a matching plan record only through the existing local policy-order path.
- Client-supplied amount, total, or currency fields remain rejected. Existing historical orders are not repriced or changed.

### Customer-facing copy and controls

- Updated the homepage and checkout to state that 59,000 VND includes the first hosting month, each additional month costs 10,000 VND, Lifetime costs 199,000 VND, and there is no automatic renewal or recurring charge.
- Checkout and renewal controls use `checkout_enabled`; prices can be displayed while order creation/payment remains disabled.
- Updated the account renewal selector to show the renewal amount and not offer Lifetime renewal.

### Files changed for ORDERS-2.32

- `src/product-catalog.ts`
- `src/payments.ts`
- `index.html`
- `checkout/index.html`
- `checkout/checkout.js`
- `account/websites/websites.js`
- `tests/product-catalog.test.ts`
- `tests/payment-contract.mjs`
- `tests/worker.test.ts`
- `docs/API_SPECIFICATION.md`
- `docs/PAYMENT_FLOW.md`
- `docs/PRODUCT_ARCHITECTURE.md`
- `docs/TEMPLATE_ENGINE.md`

No migration or environment file was changed, and no new application source file was created.

## 4. Before/after status

| Area | Before | After |
|---|---|---|
| Standard products | Five products defined and individually available, but standard pricing path gated off | All five IDs are discoverable and available through the public catalog contract |
| Initial hosting options | 1, 3, 6, 12 months and Lifetime disabled/unpriced | Totals: 59,000; 79,000; 109,000; 169,000; and 199,000 VND |
| Formula/custom duration | Formula present in source but not enabled by the catalog gate | Server applies the approved formula to positive whole-month terms, without an invented maximum |
| Renewal options | Standard code path lacked configured renewal amounts | Monthly renewals use 10,000 VND per renewed month; Lifetime upgrade remains unavailable |
| Production checkout | Disabled | Still disabled; API reports `checkout_enabled: false` |
| Preview checkout/auth | Disabled | Still disabled; Preview auth/payment isolation was not changed |
| Legacy fixture prices | Local test-only | Preserved for legacy integration contracts |

## 5. Verification

All commands ran locally with synthetic fixtures only:

| Command/check | Result |
|---|---|
| `node --experimental-strip-types --test tests/product-catalog.test.ts tests/worker.test.ts tests/payments.test.ts` | Passed, 38 tests; 0 failed |
| `npm run typecheck` | Passed |
| `npm test` | Passed, 140 tests; 0 failed |
| `npm run test:integration` | Passed: local D1 API/payment contracts, legacy regression, constraints, and batch rollback |
| `node --check checkout/checkout.js` | Passed |
| `node --check account/websites/websites.js` | Passed |
| `git diff --check` | Passed |
| Local browser check of `index.html` at a 375px viewport | Pricing copy rendered; document width was 375px with no horizontal overflow |

Tests cover all five standard product IDs, initial plan totals, 1/2/3/6/12-month prices, Lifetime, a 24-month term, renewal pricing, unsupported Lifetime upgrades, invalid terms, Premium/Custom exclusion, forged client price fields, and Production checkout remaining disabled. The integration harness used loopback Wrangler with temporary local persistence and synthetic accounts/orders; it did not contact external providers.

## 6. Remote and owner requirements

Not verified or performed:

- Whether migration `0006_storage_entitlements.sql` and the active template seeds are applied to any remote database.
- Whether a Vercel deployment serves this source or whether remote catalog/API behavior matches local tests.
- Production/Preview database, storage, email, payment, authentication, and publication configuration.
- Any real SePay checkout, webhook, settlement, fulfillment, or customer order.
- Production legal, refund/cancellation, support, and recovery readiness.

No Vercel, Turso, Cloudinary, SePay, Production, or other remote resource was contacted. No remote migration, environment change, or provider provisioning occurred. A project owner must verify/apply required schema migrations and separately approve any future Production checkout enablement. No recurring payment or Lifetime-renewal price was introduced.

## 7. Final Git state

After adding this report:

- Branch: `main`
- HEAD: `84acc4c19a143805830495671e076bbc395db3e3` (unchanged)
- Staged paths: 0
- Modified tracked paths: 35, including pre-existing user changes
- Untracked paths: 12, including pre-existing user files and this report

All pre-existing changes remain intact. Production checkout and webhook policy, Preview authentication, provider settings, and remote resources were not changed.

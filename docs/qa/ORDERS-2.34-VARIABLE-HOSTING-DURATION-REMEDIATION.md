# ORDERS-2.34 — Variable Hosting Duration Persistence Remediation

## Verdict

**PASS — local duration and renewal persistence remediation.** This is not a Production-readiness sign-off; no remote service or database was accessed.

## Git baseline and final state

- Initial branch: `main`
- Initial HEAD: `84acc4c19a143805830495671e076bbc395db3e3`
- Initial worktree: 0 staged, 35 modified tracked files, 13 untracked files. These were pre-existing and preserved.
- Final branch and HEAD are unchanged.
- Final worktree: 0 staged, 39 modified tracked files, 14 untracked files. The ORDERS-2.34 report is the additional untracked file; pre-existing work remains untouched.

## Root cause

The schema already allowed positive integer values in `storage_plans.duration_months` and `storage_entitlements.duration_months`, and used a text primary key for storage-plan IDs. However, the application generated `custom-N-months` plan records only when the local approved-pricing flag was enabled. The ordinary standard-pricing path still required an active matching storage-plan row, so non-preset terms could not pass order validation and could not be persisted.

The account renewal UI also offered only preset plan IDs even though the server’s duration-based renewal path could calculate a per-month amount.

## Remediation

- Standard monthly custom terms now create and verify an active `custom-N-months` row after validating the customer’s standard product, authoritative price, and expiry range. Conflicting or retired rows fail explicitly.
- Order and payment amounts remain server-calculated. The order snapshot retains the exact duration, VND currency, and calculated total; client-supplied prices are rejected.
- The account renewal UI accepts any positive whole-month count when the standard renewal rate is available. The API exposes the existing 10,000 VND/month renewal rate; the server remains authoritative.
- Monthly order creation checks that the established calendar-expiry calculation can represent the requested term. The limit is the runtime date range, not a configured business maximum.
- Calendar expiry now throws explicitly when date arithmetic exceeds the representable range rather than returning an invalid `Date`.
- Lifetime remains a separate plan with null duration and null expiry. Existing preset-plan behavior remains supported.

### Behavior

| Area | Before | After |
|---|---|---|
| Standard initial order | Preset terms worked; custom terms lacked a required active plan row outside the local pricing flag | Preset and custom terms persist the exact selected months and computed amount |
| Renewal | UI offered fixed plan IDs; custom duration was not available through that selector | Standard renewal UI accepts custom months at 10,000 VND per month; exact duration is stored in the entitlement |
| Expiry | Date arithmetic could yield an invalid date for out-of-range terms | Unrepresentable terms fail before an order is created; valid terms retain calendar-month clamping |
| Lifetime | Separate seeded plan | Still separate, non-expiring, and excluded from standard monthly renewal |

## Files changed

- `src/payments.ts`
- `src/storage-plans.ts`
- `account/websites/websites.js`
- `account/websites/websites.css`
- `tests/payment-contract.mjs`
- `tests/product-catalog.test.ts`
- `tests/storage-plans.test.ts`
- `tests/integration.mjs`
- `docs/qa/ORDERS-2.34-VARIABLE-HOSTING-DURATION-REMEDIATION.md` (created)

No migration was needed. Existing migration `0006_storage_entitlements.sql` already defines positive-integer duration columns without a preset-only constraint. The migration was not modified or applied.

## Verification

- Focused catalog and expiry tests: **10 passed, 0 failed**
- `npm run typecheck`: **passed**
- `npm test`: **140 passed, 0 failed**
- `npm run test:integration`: **passed** — local D1 API/payment contracts, preset regressions, constraints, and batch rollback
- `node --check` for the modified account and test JavaScript files: **passed**
- `git diff --check`: **passed**

The integration test omits `LOCAL_TEST_PRICING_POLICY` so the custom-duration cases exercise the ordinary standard-pricing code path. It still runs only against isolated local Wrangler/D1/R2 and synthetic payment fixtures.

Coverage includes 1, 2, 3, 4, 5, 6, 7, 12, and 24-month initial terms; Lifetime; exact plan and entitlement persistence; custom renewal calculation and expiry; tampered prices; invalid and unsafe durations; and date-range rejection.

## Safety and remaining actions

- Production checkout, SePay webhook settlement, authentication, and publication gates were not enabled or changed by this remediation.
- No remote migration, provider request, real order, payment, or deployment was performed.
- The remote status of migration 0006 and remote Production/Preview configuration remains unverified. Confirm the schema is present before deploying this change; no ORDERS-2.34-specific migration is required.
- This local result does not clear other blockers from the ORDERS-2.33 readiness audit or authorize a Production order.

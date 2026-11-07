# SePay pricing and promotion notes

**Checked:** 2026-11-07 (Asia/Ho_Chi_Minh) against the linked official SePay pages. Prices, eligibility, bank coverage, limits, and terms can change; confirm them directly before selecting a payment provider. This note is informational and does not estimate Crushify's total payment cost.

## Published service pricing

The SePay pricing page lists a **FREE** plan at **0 VND/month** with **50 transactions/month**. The page says over-limit transactions are allowed and charged afterward. Its FAQ defines monthly transaction volume as incoming-money transactions during the month. It lists 12 supported banks for this plan: Vietcombank, VPBank, ACB, Sacombank, VietinBank, MB, BIDV, MSB, TPBank, KienLongBank, ShinhanBank, and OCB.

The page also lists **STARTUP at 120,000 VND/month** and describes over-limit charges. The captured public page does not expose a specific included quota or per-transaction overage rate, so obtain a current quote rather than estimating either. Its separate SHOP product is shown at 99,000 VND monthly or 70,000 VND per shop/month on annual billing (840,000 VND/year); the page describes shop features and free transactions. This is a separate offer and must not be assumed to cover Crushify's webhook/API use case. E-invoice and digital-signature prices are separate offerings and are not included here.

The pricing page says API Banking synchronizes bank transactions through SePay API/Webhooks and that documentation and sandbox are available, but the captured page does not show a complete API Banking price. Bank connection method and features can vary by bank and account setup; confirm the intended webhook and receiving-account configuration and any activation fees.

## Promotions shown by SePay

- **VietinBank household-business offer:** the official page lists a campaign from 2026-10-05 through 2026-11-30 for eligible household businesses without an existing VietinBank CIF that open a new account through SePay. It describes 600 transactions/month for six months (3,600 total) and a VietinBank VIP package stated as worth 2,208,000 VND, plus a bank account-number benefit. SePay registration and bank eligibility/activation steps are required.
- **VietinBank business startup combo:** the official campaign page lists 2026-10-30 through 2026-11-30, or until 50 businesses have joined. It describes 18,000 transactions/year and 1,000 e-invoices/year for businesses without an existing VietinBank CIF opening a new account through SePay, with at least 50 transactions through VietinBank in the first month. Contact and bank activation are required.
- **BIDV business offer:** the official page lists 2026-04-08 through 2027-03-31 for businesses registering for BIDV QR (VA) collection for the first time, with a stated minimum 12-month use of the BIDV settlement account. It describes 360 transactions/month for one year (4,320 total) and a package stated as worth 2,016,000 VND.
- **VPBank 500-transactions/month offer:** expired 2025-12-31 (or earlier if codes ran out). The campaign page says it was limited to the first 100 customers and required opening a new VPBank personal account and using referral code `SEPAY`. Do not include it in a current cost estimate.
- Other campaigns on SePay's promotions page may be expired or have different eligibility. Do not assume expired offers still apply.

These are bank/SePay promotions with specific customer eligibility and application steps, not general discounts guaranteed to Crushify. They do not prove that a particular company or account qualifies.

## Cost and product decisions still required

- Confirm eligible legal entity, bank/account type, settlement flow, and whether the business may use the selected SePay product.
- Confirm current plan/overage fees, VAT/taxes, transaction counting rules, webhook/Test mode quotas, bank connectivity, support and refund terms with SePay.
- Include non-SePay expenses such as hosting, email, domain, customer support, accounting, tax, and operational reconciliation.
- No Crushify template price has been approved. The server-side test catalog starts empty, and the VND 50,000 value in disposable test fixtures is synthetic only.
- No SePay fee or promotion is included in the repository's product prices; no price is published or activated by this work.

## Official sources

- [SePay plans and pricing](https://sepay.vn/bang-gia.html)
- [SePay promotions index](https://sepay.vn/khuyen-mai)
- [VPBank 500-transactions/month campaign](https://sepay.vn/khuyen-mai/uu-dai-cuc-da-tang-goi-sepay-500-giao-dich-thang-suot-nam)
- [VietinBank business startup combo](https://sepay.vn/khuyen-mai/combo-khoi-nghiep-cung-sepay-va-vietinbank)
- [VietinBank household-business campaign](https://sepay.vn/khuyen-mai/tang-3600-giao-dich-khi-mo-tai-khoan-ho-kinh-doanh-doanh-nghiep-vietinbank-qua-sepay)
- [BIDV business campaign](https://sepay.vn/khuyen-mai/tang-hon-4000-giao-dich-mien-phi-cho-bidv-doanh-nghiep)

The Free plan's numeric overage fee and exact STARTUP quota/overage were not visible in the official pricing-page content retrieved on the check date. Verify by written quote, including VAT, billing boundaries, bank/API fees, settlement and refund terms. Do not assume Crushify or its future operator is a household business or corporation eligible for a bank promotion.

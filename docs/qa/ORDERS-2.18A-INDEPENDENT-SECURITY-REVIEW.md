# ORDERS-2.18A — Independent Security Code Review

## Final verdict

**PARTIAL — REMEDIATION REQUIRED**

No confirmed exploitable vulnerability was identified in the configured Vercel Preview path or the reviewed logging and email flows. However, the Cloudinary configuration guard only compares cloud-name strings; it does not prove that staging credentials belong to a separate account or are distinct from Production credentials. There is also a direct Cloudinary adapter path outside the Vercel guard in the legacy Worker provider. Keep Cloudinary disabled for staging until the account/credential identity is owner-verified and all staging paths are covered.

This is a local code review only. It does not establish remote environment isolation or staging/production readiness.

## Git baseline and preservation

At review start:

- Branch: `main`
- HEAD: `5205f730fd0141fb9c8d0697787b700e4bda04ff`
- Status: `## main...origin/main`
- Tracked changes: 36 modified files
- Untracked files: 13
- Staged changes: none
- `git diff --check`: passed

### Tracked files changed at review start

```text
_headers
docs/HOSTING_MIGRATION.md
docs/PAYMENT_FLOW.md
docs/PRODUCT_ARCHITECTURE.md
docs/PUBLICATION_AND_DELIVERY.md
docs/STAGING_DEPLOYMENT.md
docs/VERCEL_STAGING.md
scripts/staging-config.ts
shared/customer-editor.js
src/assets.ts
src/auth.ts
src/designs.ts
src/index.ts
src/platform/vercel.ts
src/publications.ts
src/types.ts
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
tests/staging-config.test.ts
tests/template-registry.test.ts
tests/vercel.test.ts
tests/worker.test.ts
vercel.json
wrangler.jsonc
wrangler.staging.jsonc
```

### Untracked files at review start

```text
docs/qa/ORDERS-2.11C-FIVE-TEMPLATE-CHECKOUT.md
docs/qa/ORDERS-2.12-CONSOLIDATED-RELEASE-REVIEW.md
docs/qa/ORDERS-2.13-LIFECYCLE-CRON-RESOLUTION.md
docs/qa/ORDERS-2.14-TURSO-CLOUDINARY-READINESS.md
docs/qa/ORDERS-2.15-SEPAY-PAYMENT-READINESS.md
docs/qa/ORDERS-2.16-FINAL-PRODUCTION-READINESS.md
docs/qa/ORDERS-2.17-STAGING-ISOLATION-PLAN.md
docs/qa/ORDERS-2.18-PRE-STAGING-SECURITY-REMEDIATION.md
docs/qa/ORDERS-2.3-2.6-FINAL-QA-REPORT.md
src/logging.ts
tests/local-email-sink.mjs
tests/orders-2-10-browser-fixture.mjs
tests/pre-staging-security.test.ts
```

The prior ORDERS-2.18 work log recorded an earlier baseline of 26 modified tracked files and 9 untracked files. That is evidence of a change in counts, not a complete file-by-file ownership map. The files already listed in the ORDERS-2.18 implementation record include `src/platform/vercel.ts`, `src/auth.ts`, `src/types.ts`, `src/logging.ts`, `src/index.ts`, `src/designs.ts`, `src/assets.ts`, `src/publications.ts`, `scripts/staging-config.ts`, `docs/VERCEL_STAGING.md`, and the security/email/staging test harnesses. Other current changes are preserved and are not attributed to ORDERS-2.18A. This review changed no source, test, or configuration file; only this report was added.

## Findings

### SEC-1 — Cloudinary cloud-name comparison does not establish account or credential isolation

- **Severity:** MEDIUM
- **File / function:** `src/platform/vercel.ts`, `createStorage`; staging identity condition near lines 321–342
- **Scenario:** A Preview deployment sets a staging cloud name different from `CLOUDINARY_PRODUCTION_CLOUD_NAME` but assigns Production API credentials to the staging-named credential variables. The guard checks that the credential fields are present, not whether they belong to the staging account or match Production credentials.
- **Evidence:** Preview rejects generic Production variable *names* in `validateCredentialScope` (`src/platform/vercel.ts:139–190`) and compares the staging and Production cloud-name strings in `createStorage` (`:321–342`). It does not verify account ownership or credential identity. Thus copying Production credential values into staging-named variables is not detectable locally. Whether those credentials can mutate the configured cloud depends on Cloudinary account/key behavior and is not established without provider verification.
- **Impact:** If the credentials authorize operations against Production assets, Preview upload/delete capability could affect Production data. Different cloud-name strings alone are not a security boundary.
- **Recommendation:** Keep Preview Cloudinary disabled until an authorized owner confirms a separate Cloudinary account/cloud and account-scoped API credentials using provider-side read-only evidence. Do not treat variable names or a self-attestation flag as proof. Add an operational gate requiring account identity confirmation before enabling the adapter.
- **Fix before Staging?** **Yes, if staging uses Cloudinary.** No Cloudinary staging writes should be enabled before this verification. This finding does not affect the checked-in staging configuration while it uses R2/mock storage.

### SEC-2 — Legacy Worker provider can construct Cloudinary storage without the Vercel isolation guard

- **Severity:** LOW (conditional on using the legacy Worker path)
- **File / function:** `src/storage/provider.ts`, `createStorage` (`:12–28`); called by `src/index.ts` (`:86`, `:125`)
- **Scenario:** A deployment using the Cloudflare Worker provider selects Cloudinary directly, bypassing the Vercel-specific `createStorage` isolation check. The checked-in `wrangler.staging.jsonc` selects R2 (`:27–31`), so this path is not active in that staging configuration.
- **Evidence:** The provider can construct `CloudinaryStorageAdapter` without invoking the Vercel guard. The separate Cloudinary staging smoke script does invoke `assertCloudinaryStagingConfiguration` before constructing the adapter (`scripts/smoke-cloudinary-staging.ts:10–13`).
- **Impact:** If a future/alternate staging Worker changes to Cloudinary, the Vercel guard does not protect its upload/delete operations.
- **Recommendation:** Before enabling Cloudinary on any non-Vercel staging Worker, apply the same fail-closed account-identity policy at the shared provider/factory boundary. Keep R2/mock for the current staging Worker configuration.
- **Fix before Staging?** **No for the checked-in R2/mock staging configuration; yes before enabling Cloudinary on that path.**

No other confirmed vulnerability is reported. The credential-reuse case in SEC-1 remains a material isolation uncertainty, not a verified successful Cloudinary request.

## Group assessment

| Group | Classification | Review conclusion |
|---|---|---|
| Cloudinary adversarial review | **PARTIAL** | Vercel validates environment scope and cloud-name mismatch before provider creation. Production-only variable names, confirmation-string bypass, missing Production identity, and unknown Vercel environment fail closed. There is no Vercel fallback to R2/another provider. Credential/account identity is not proven, and the legacy Worker provider is outside the Vercel guard. No Cloudinary API was called. |
| Logging redaction | **PASS — local code paths** | The application logging call sites found use the safe logger: `src/index.ts:50,74,88,101,111,127`; `src/auth.ts:47,53,325`; `src/assets.ts:218,232,238,349`; `src/designs.ts:208,219`; `src/publications.ts:365,471,591,602,781,1334`; `src/platform/vercel.ts:443,516`. `src/logging.ts:72–92,94–112` serializes constrained fields rather than raw errors, messages, causes, arbitrary context, or request payloads. The remaining direct API log at `api/[...path].ts:150` records only a generated request ID. Provider-side logs and remote log drains were not inspected. |
| Email isolation | **PASS — local code paths** | `createEmailService` makes staging discard-only or unavailable (`src/auth.ts:107–141`); Preview mail settings are conditionally forwarded in the Vercel runtime (`src/platform/vercel.ts:541–550`). The sign-in path checks mail availability before creating a login token and stores the token hash (`src/auth.ts:287–329`); verification consumes the token (`:334–373`). No API response path returning a raw magic token was found. The test sink binds to `127.0.0.1` (`tests/local-email-sink.mjs:4–8`). Preview discard allows neither delivery nor interactive login. Actual deployed email settings were not verified. |
| Environment, payment, webhook, Cron, scheduler | **PASS — local contract; deployment NOT TESTED** | Vercel scope/database checks occur before provider initialization (`src/platform/vercel.ts:139–190,237–269,390–421`). Mock payment is constrained to local development (`:291–319`) and only guarded payment settings are passed to the app (`:561–569`). Webhook handling validates enabled mode and signature before processing (`src/payments.ts:86–106,1030–1065`). Cron auth/runtime checks precede storage/database work (`src/platform/vercel.ts:390–421`); the scheduler uses a persistent lease (`src/scheduler.ts:11–25,38–69`). No remote config, callback, or Cron execution was checked. |
| Test quality and side effects | **PARTIAL** | Targeted local security/configuration, Vercel, scheduler, and staging-configuration tests were reported passing (32 tests). The injected storage factories establish ordering and guard outcomes, but do not test account identity or the real Cloudinary adapter against an isolated account. Local mail integration uses loopback and local fixtures. The full integration suite was not run as part of this independent review. No remote service was contacted. |

## Test evidence and limitations

- Reviewer-run targeted local suites: **32 tests passed** across the security/configuration, Vercel, scheduler, and staging-configuration suites.
- Full `npm test` and `npm run test:integration` were **not run by this independent review**.
- Tests with fake storage factories do not establish remote account separation, key permissions, or deletion boundaries.
- No Vercel environment values, Turso resources, Cloudinary APIs/assets, SePay, email delivery, migration, or deployed Cron were accessed.
- Local test pass status is not evidence that Staging or Production is ready.

## Final Git state

Review began on `main` at `5205f730fd0141fb9c8d0697787b700e4bda04ff` with 36 modified tracked files and 13 untracked files. No existing work was reverted, staged, or overwritten. The only review output is this untracked report. Branch and HEAD are unchanged; `git diff --check` passes.

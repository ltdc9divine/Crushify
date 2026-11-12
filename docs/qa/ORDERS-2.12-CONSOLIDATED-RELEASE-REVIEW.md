# ORDERS-2.12 — Consolidated Release Gate Review

**Review date:** 2026-11-12  
**Branch / HEAD:** `main` / `5205f730fd0141fb9c8d0697787b700e4bda04ff`  
**Verdict: NOT READY**

## 1. Executive verdict

Local synthetic evidence supports the core template editing, mock checkout, standard pricing, order ownership, payment-contract, publication, and regression-test behavior within the limits below. This does **not** establish deployed runtime readiness. No Vercel Production or Preview runtime, Turso database, Cloudinary account, live SePay flow, email provider, or actual scheduled Cron invocation was validated.

Release remains blocked by unverified provider/environment configuration, no automatic Preview expiry/cleanup runner, unresolved commercial hosting-plan eligibility, and missing durable evidence for several browser/editor persistence and operational checks. The repository documentation also says the current SePay Live and full production purchase/reconciliation flow is not implemented. Do not enable live checkout, publish customer data, or deploy on the basis of local QA.

This review did not alter existing source changes or access remote systems. Regression gates were rerun locally because relevant files are modified in the worktree.

## 2. Evidence inventory and confidence

| Evidence source | Review result | Traceability / limit |
|---|---|---|
| [ORDERS-2.3–2.6 / 2.7–2.9 cumulative report](./ORDERS-2.3-2.6-FINAL-QA-REPORT.md) | PARTIAL | Detailed historical browser, API, and gate summaries, including exact integration success text. It also explicitly records untested behavior and no deployed-provider evidence. Raw screenshots and per-interaction logs are not retained with the report. |
| [ORDERS-2.11C five-template checkout report](./ORDERS-2.11C-FIVE-TEMPLATE-CHECKOUT.md) | VERIFIED PASS for its stated local checkout/pricing cases | Records browser, route, Design/Order IDs, HTTP statuses, DOM observations, pricing, idempotency results, and cleanup. No screenshot or raw runner output was retained; Love Letter is carried forward from ORDERS-2.11B rather than rerun. |
| `docs/qa/ORDERS-2.11-PRODUCTION-PREFLIGHT.md` | NOT TESTED / unavailable | File is not present in the repository. No production preflight findings can be attributed to it. |
| Separate ORDERS-2.10 or ORDERS-2.11A/B report files | NOT TESTED / unavailable as repository artifacts | No such report files are present. ORDERS-2.11B results are summarized in the 2.11C report and the prior chat response, not in an independent evidence artifact. |
| Current local command results | VERIFIED PASS for gates listed in §4 | Commands were rerun against the current worktree on 2026-11-12. Integration used the test harness's isolated local D1 and synthetic webhook fixtures. |
| Current repository configuration and source | VERIFIED for code/config only | Confirms configured routes, fail-closed checks, and required variable names; does not prove remote values, provider availability, deployed code, or runtime execution. Secret values were not inspected. |

### Classification meanings

- **VERIFIED PASS** — direct local command, test, API, or browser evidence supports the bounded claim.
- **PARTIAL** — some cases pass, but scope is incomplete, evidence conflicts, or the result is not fully reproducible from retained artifacts.
- **NOT TESTED** — no relevant execution evidence.
- **FAIL** — observed product or gate failure.
- **BLOCKED BY EXTERNAL PROVIDER** — cannot establish the result without an authorized external account, plan, deployment, or provider operation.

## 3. Five-template coverage

The cumulative report records template editor and responsive interactions from ORDERS-2.7/2.9. The 2.11C report independently records authenticated checkout for Our Universe, Our Memories, Say Yes, and Distance Means Nothing, and incorporates the Love Letter browser run from ORDERS-2.11B. Checkout evidence must not be interpreted as proof of editor persistence.

| Template | Editor loading | Meaningful editing | Save/reload persistence | Preview | Checkout UI | Server-side pricing | Order / payment-pending | Ownership isolation | Responsive smoke | Accessibility smoke |
|---|---|---|---|---|---|---|---|---|---|---|
| Our Universe | VERIFIED PASS — local editor opened | VERIFIED PASS — text, Unicode, emoji, long/script-like text and images recorded | PARTIAL — 2.7 reports save/reload; 2.9 explicitly does not claim per-template editor-field persistence after reload | VERIFIED PASS — private preview and return path recorded | VERIFIED PASS — 2.11C browser run, HTTP 200 | VERIFIED PASS — 59,000 VND one-month browser; full server duration grid in §5 | VERIFIED PASS — HTTP 201, `AWAITING_PAYMENT`, reload same order, mock/no QR | PARTIAL — integration/API ownership contract; 2.11B browser isolation was only for Love Letter | VERIFIED PASS — 390/430/768/1024/1440 smoke in cumulative report; not a visual regression audit | PARTIAL — practical keyboard/semantics checks, no full assistive-tech audit |
| Love Letter | VERIFIED PASS — local editor opened | VERIFIED PASS — text, Unicode, script-like input and image evidence | PARTIAL — save/reload reported; subsequent report declines a per-template persistence claim | VERIFIED PASS — private preview/canvas interaction recorded | VERIFIED PASS — ORDERS-2.11B evidence summarized in 2.11C; not rerun in 2.11C | VERIFIED PASS — server pricing contract plus 59,000 VND browser case | VERIFIED PASS — 2.11B reports `AWAITING_PAYMENT`, reload, mock notice, no QR | VERIFIED PASS — other synthetic customer received 404 in 2.11B | VERIFIED PASS — cumulative report's bounded viewport smoke | PARTIAL — named controls and representative keyboard checks; no complete audit |
| Our Memories | VERIFIED PASS — local editor opened | VERIFIED PASS — synthetic fields and image interaction recorded | PARTIAL — 2.7 reports save/reload, but later report does not claim per-template field persistence after reload | VERIFIED PASS — private preview and recipient interaction recorded | VERIFIED PASS — 2.11C browser run, HTTP 200 | VERIFIED PASS — 59,000 VND browser; Standard server grid | VERIFIED PASS — HTTP 201, pending mock state persisted after reload | PARTIAL — API contract only; no template-specific browser isolation run retained | VERIFIED PASS — cumulative viewport smoke | PARTIAL — semantic/keyboard checks recorded; full audit not done |
| Say Yes | VERIFIED PASS — local editor opened | VERIFIED PASS — synthetic fields and image interaction recorded | PARTIAL — prior local draft/save evidence; later report does not claim per-template reload persistence | VERIFIED PASS — private preview/recipient interaction recorded | VERIFIED PASS — 2.11C browser run, HTTP 200 | VERIFIED PASS — 59,000 VND browser; Standard server grid | VERIFIED PASS — HTTP 201, pending mock state persisted after reload | PARTIAL — API contract only; no template-specific browser isolation run retained | VERIFIED PASS — cumulative viewport smoke | PARTIAL — semantics/keyboard checks recorded; full audit not done |
| Distance Means Nothing | VERIFIED PASS — editor required opening its collapsed editing panel first | VERIFIED PASS — Unicode and script-like title/story edits recorded | PARTIAL — local-storage persistence reported; authenticated server-backed persistence after reload not established | VERIFIED PASS — private preview and keyboard-operated panel reported | VERIFIED PASS — 2.11C browser run, HTTP 200 | VERIFIED PASS — 59,000 VND browser; Standard server grid | VERIFIED PASS — HTTP 201, pending mock state persisted after reload | PARTIAL — API contract only; no template-specific browser isolation run retained | VERIFIED PASS — cumulative viewport smoke | PARTIAL — representative keyboard interaction and heading smoke; full audit not done |

**Cross-template limitations:** The ORDERS-2.7 report documents 390–1440 px practical browser checks on the homepage and all five templates, but raw screenshots were not retained and it is not a pixel/zoom/assistive-technology certification. The later ORDERS-2.9 report explicitly limits per-template editor-field persistence after reload to **NOT TESTED**; that later caveat takes precedence over broader earlier summaries. Checkout reload persistence is independently verified in 2.11C for four templates and reported in 2.11B for Love Letter. No customer-facing template was shown to have a fatal page error in the reported successful browser runs.

## 4. Regression gate matrix

Rerun locally on 2026-11-12 against the current worktree:

| Gate | Result | Exact current evidence |
|---|---|---|
| `npm run typecheck` | VERIFIED PASS | `tsc --noEmit`; exit code 0. |
| `npm test` | VERIFIED PASS | Node test runner: **90 tests, 90 passed, 0 failed, 0 cancelled, 0 skipped**. |
| `npm run test:integration` | VERIFIED PASS | `Local integration: passed (D1 API and payment contracts, legacy regression, constraints, and batch rollback).` |
| `npm audit --omit=dev` | VERIFIED PASS | `found 0 vulnerabilities`. |
| `git diff --check` | VERIFIED PASS | Exit code 0; no output. Rechecked after this report was written; this command does not include untracked files. |
| `node --experimental-strip-types --test tests/security-headers.test.ts` | VERIFIED PASS | 4 tests passed, 0 failed. Includes static CSP/hash, remote resource, editor style, and Vercel static-response compatibility checks. |
| Focused security review | PARTIAL | Historical ORDERS-2.9 report records no actionable finding in a bounded read-only review. It is not a penetration test or deployed audit. |

The previous integration incident has a passing current rerun and a test-only fix. The historical reports describe both a best-supported Undici keep-alive reset diagnosis and a separate obsolete `.dev.vars` prerequisite. The precise socket-level root cause was not packet-traced; the corrected isolated integration harness now passes without weakened assertions or timeout increases.

## 5. Payment and order integrity

| Requirement | Result | Evidence / boundary |
|---|---|---|
| 1, 2, 3, 6, 12-month prices | VERIFIED PASS | 2.11C server API returned 59,000 / 69,000 / 79,000 / 109,000 / 169,000 VND and reloaded each pricing snapshot. |
| Lifetime price | VERIFIED PASS | Server returned 199,000 VND; snapshot persistence checked. |
| Invalid duration / unsupported plan | VERIFIED PASS | 0, -1, 1.5 months, `weekly`, and unsupported plan returned HTTP 400 in 2.11C; integration tests also cover unsafe integer values. |
| Client-supplied price tampering | VERIFIED PASS | Client `total_minor` / `amount` rejected with HTTP 400 in 2.11C; historical payment contract also rejects amount/payment/status claims. |
| Invalid Design IDs | VERIFIED PASS | Integration contract covers missing, malformed, and valid-format nonexistent IDs; historical checkout checks also cover missing and unusable IDs. |
| Same-key replay | VERIFIED PASS | 2.11C replay returned HTTP 200 with original Order ID. |
| Concurrent same-key requests | VERIFIED PASS | Both requests returned HTTP 200 and same Order ID in 2.11C. |
| Rapid duplicate UI submission | VERIFIED PASS, bounded | Two rapid pointer clicks in Our Universe produced one browser order POST in 2.11C. This is not a proof of all timing/device cases. |
| Different key on same Design | VERIFIED PASS for behavior; intent PARTIAL | 2.11C created a distinct second order with a new key. Current schema enforces uniqueness by `(customer_id, idempotency_key)`, not Design ID. Documentation reviewed does not explicitly settle whether duplicate initial purchases on the same Design are a desired business rule. Renewal uses an explicit publication reference. No behavior was changed; product owner must decide whether to retain or restrict this behavior. |
| Ownership/authentication | VERIFIED PASS at API level | Integration contract checks authenticated ownership; 2.11B reports a foreign synthetic customer received 404 for the Love Letter order. Browser ownership isolation was not repeated for each template. |
| Mock payment / QR | VERIFIED PASS locally | Browser/UI and API report mock mode; mock note visible, QR hidden, external browser requests absent in 2.11C. This is not proof of process-wide network isolation. |
| Live SePay / real settlement | BLOCKED BY EXTERNAL PROVIDER | No live provider credentials, transaction, or remote webhook was used. Current documentation says SePay Live and production purchase/reconciliation flow are not implemented. |
| Synthetic signed webhook / fulfillment | VERIFIED PASS at API-contract level | Integration uses a generated local HMAC secret and synthetic events to test signature validation, replay/idempotency, fulfillment, publication, and public access. It does not validate provider connectivity or live account setup. |

## 6. Deployment and lifecycle readiness

| Area | Result | Release assessment |
|---|---|---|
| Vercel adapter / route compatibility | VERIFIED PASS for local code contracts | Current Vercel adapter has a `/api/cron/publication-lifecycle` handler; tests cover method/auth/environment/provider-scope paths and CSP tests cover static-response config. No deployed Vercel route was exercised. |
| Vercel Cron config / actual execution | PARTIAL / NOT TESTED | `vercel.json` defines one daily `0 3 * * *` lifecycle route. Unit tests validate config and handler behavior; no actual deployed Cron event or Vercel Production runtime was tested. |
| Preview lifecycle scheduler | BLOCKED BY EXTERNAL PROVIDER / configuration | Vercel Cron is Production-only; the Cloudflare cron triggers are removed. Preview/staging expiry and cleanup therefore have no configured automatic scheduler. |
| Turso adapter / migration safety | PARTIAL | Adapter and guarded migration/preflight code exist. Local tests use D1 and mocks; no authorized Turso staging database identity, schema, migration, or connection was verified. The documented Preview environment previously had no variables, but that historical listing was not repeated in this audit. |
| Cloudinary adapter / upload security | PARTIAL | Local tests cover adapter behavior and synthetic PNG/JPEG flows use local storage. No real Cloudinary upload/delete/signing/derivative/cleanup was executed. Staging requires a separately confirmed cloud and scoped credentials; docs say the only identified cloud may be Production and must not be reused. |
| SePay webhook configuration | PARTIAL | Local HMAC/signature/timestamp/amount/idempotency contract passed; no production webhook endpoint, account, provider secret, or live settlement validated. |
| Expiry / cleanup lifecycle | PARTIAL | Local scheduler/API contract tests cover expiry, denial of expired public access, cleanup retries, completion, and idempotence. No timer fired in a deployed environment; Preview has no runner. |
| Environment variables / secret requirements | BLOCKED BY EXTERNAL PROVIDER | Code/docs specify Turso, storage, origin, mail, payment, and `CRON_SECRET` names and scope checks. No current Production values or presence were read; historical documentation reports Preview variables absent. No values were printed or used. |
| Production plan / commercial restrictions | BLOCKED BY EXTERNAL PROVIDER | Repository docs state Vercel Hobby is non-commercial and the current account/plan eligibility is unverified. A suitable commercial plan and account eligibility must be confirmed by an authorized owner. |
| Email / magic link | NOT TESTED for external delivery | Local synthetic auth links were emitted by a local test adapter; no staging/production email provider delivery was tested. |
| Production/Preview release preflight | NOT TESTED | The requested 2.11 production-preflight report is absent, and no remote preflight was run. No deployment, migration, provider call, or production mutation was performed. |

### Provider and operations boundary

Current code and reports establish guardrails and local behavior only. They do not prove account ownership, correct environment variable values, database isolation, migration currency, storage retention, provider plan eligibility, or a successful production schedule. Cloudinary staging must not use a possibly-production cloud. Do not compensate for missing Preview lifecycle scheduling by enabling an unreviewed alternate scheduler.

## 7. Confirmed defects vs missing evidence

### Confirmed application defects

**None established by the reviewed evidence.** The current local type, unit, integration, audit, CSP, pricing, checkout, and synthetic lifecycle checks passed. Historical findings such as hidden mobile headings and Love Letter deletion interaction were addressed or superseded by later local evidence in the cumulative report. No new code defect was observed during this read-only audit.

### Confirmed release blockers / operational gaps

1. Preview/staging has no configured automatic expiry/cleanup runner under the current Vercel-only Cron design.
2. No Production or Preview deployment/provider configuration or actual Cron execution has been verified.
3. Commercial hosting-plan eligibility is unresolved, while the documented Hobby plan is unsuitable for commercial sales.
4. The documented current payment design does not implement SePay Live or complete production payment/reconciliation operations.
5. Multiple initial orders per Design are currently permitted with different idempotency keys; whether this is intended is not documented.

These are readiness/configuration/business-policy gaps, not evidence that local application tests failed.

### Missing or partial evidence

- No `ORDERS-2.11-PRODUCTION-PREFLIGHT.md` or standalone ORDERS-2.10/2.11A/B QA report exists in `docs/qa/`.
- No per-template authenticated editor-field persistence-after-reload result is claimed by the later ORDERS-2.9 report; older summaries are not enough to override that explicit caveat.
- No Love Letter rerun occurred in ORDERS-2.11C; it relies on the earlier ORDERS-2.11B summary.
- No template-by-template browser ownership isolation; only API contract coverage and a reported Love Letter browser case.
- No screenshots/raw Playwright trace retained for ORDERS-2.11C.
- No deployed Cron firing, Production route test, Preview lifecycle run, or authorized preflight.
- No remote Turso preflight/migration, Cloudinary operation, real email, or live SePay transaction.
- No formal penetration test, full screen-reader audit, complete WCAG/contrast audit, or assistive-technology certification.
- No product decision whether duplicate initial orders per Design should be allowed or prevented.

## 8. Exact next actions, ordered by priority

1. **Keep release blocked.** Do not deploy, turn on live checkout, or accept real payments.
2. **Resolve the commercial and runtime architecture gates with the account owner:** confirm an eligible commercial hosting plan; choose a supported Preview lifecycle strategy; approve a separate staging Turso database and isolated media provider. Do not copy Production secrets or reuse the possibly-production Cloudinary account.
3. **Obtain explicit product policy for multiple initial orders per Design.** Decide whether a new idempotency key should create another initial order or whether only an explicit renewal may do so. Then add/retain a contract test for the approved behavior; do not change code before that decision.
4. **Create a safe staging evidence package only after owner authorization:** verify environment-variable names/presence without exposing values, validate database separation and migrations using the guarded staging preflight, and test synthetic media on an isolated provider.
5. **Verify staging operational flows:** authentication delivery through an approved test mail path, order creation with mock/test payment only, ownership boundaries, publication expiry/cleanup under the chosen staging scheduler, and scheduler idempotence.
6. **Close editor evidence gaps:** for each template, perform a real authenticated edit → save → reload → verify-field-value → preview browser journey. Retain sanitized DOM/test output or screenshots that contain no credentials.
7. **At a later separately authorized release gate,** verify Production-only configuration, required secret presence, provider restrictions, a protected Cron invocation and first scheduled execution. Keep credentials and values out of chat/logs; do not use a real payment in QA.
8. **Re-run the local regression gates after any subsequent code/config change:** typecheck, unit, integration, dependency audit, CSP/security-header tests, and `git diff --check`.

## 9. Final worktree and cleanup status

The audit did not edit application code, run remote operations, or alter existing changes. Local regression tests completed; the integration harness used its own isolated synthetic D1 directory and reported success. No changes were committed.

Final repository state at report creation:

- Branch: `main`
- HEAD: `5205f730fd0141fb9c8d0697787b700e4bda04ff`
- Worktree remains intentionally dirty; all pre-existing modifications and untracked files are preserved.
- `git diff --check`: exit 0.
- No credentials, tokens, cookies, or session values were read or exposed.
- `session.json` was not accessed.
- No deployment, production mutation, commit, push, merge, reset, checkout, clean, or stash was performed.

Exact `git status --short --untracked-files=all` at final verification:

```text
 M _headers
 M docs/HOSTING_MIGRATION.md
 M docs/PAYMENT_FLOW.md
 M docs/PRODUCT_ARCHITECTURE.md
 M docs/PUBLICATION_AND_DELIVERY.md
 M docs/STAGING_DEPLOYMENT.md
 M docs/VERCEL_STAGING.md
 M shared/customer-editor.js
 M src/platform/vercel.ts
 M templates/distance-means-nothing/index.html
 M templates/love-letter/index.html
 M templates/our-memories/index.html
 M templates/our-memories/our-memories.js
 M templates/our-universe/index.html
 M templates/say-yes/index.html
 M templates/say-yes/say-yes.css
 M templates/say-yes/say-yes.js
 M tests/browser-love-letter.mjs
 M tests/integration.mjs
 M tests/payment-contract.mjs
 M tests/publications.test.ts
 M tests/scheduler.test.ts
 M tests/template-registry.test.ts
 M vercel.json
 M wrangler.jsonc
 M wrangler.staging.jsonc
?? docs/qa/ORDERS-2.11C-FIVE-TEMPLATE-CHECKOUT.md
?? docs/qa/ORDERS-2.12-CONSOLIDATED-RELEASE-REVIEW.md
?? docs/qa/ORDERS-2.3-2.6-FINAL-QA-REPORT.md
?? tests/orders-2-10-browser-fixture.mjs
```

Port 8787 was not listening after the integration run; the pre-existing port 8799 process remained active and was not stopped. The integration harness's isolated D1 directory was not found after the run.

## 10. Final verdict

# NOT READY

Local synthetic checkout and regression evidence is strong for the tested scope, but it does not establish Production provider configuration, commercial eligibility, live-payment readiness, Preview lifecycle scheduling, or deployed Cron behavior. Resolve the release blockers and produce authorized staging/operational evidence before reconsidering Production preflight.

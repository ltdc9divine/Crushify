# ORDERS-2.3–2.6 Final QA Report

## A. Outcome

**Readiness: NOT READY.**

The local synthetic Love Letter order-to-publication flow and the core type/unit/security-dependency checks passed. The required integration suite failed reproducibly with a connection reset, and browser coverage did not establish the complete authenticated editing, save/preview, and order-to-publication journey for all five templates. Do not treat this report as Production approval.

## B. Scope

Executed the local QA plan for ORDERS-2.3 through ORDERS-2.6:

- Responsive/browser checks of the homepage and all five templates.
- Representative template editing and persistence checks.
- A synthetic Love Letter order, signed test webhook, fulfillment, publication, and consent-withdrawal flow.
- Type, unit, integration, and production-dependency audit gates.
- Accessibility observations and a readiness assessment.

## C. Safety boundaries

- Used local static servers and an isolated local Wrangler Worker with synthetic fixtures only.
- Did not access Production resources, deploy, use real customer data, initiate real payments, or send real emails.
- Did not commit or push changes.
- Removed the temporary `.dev.vars` placeholder and stopped the static servers and test Worker after testing.

## D. Baseline and change

- Branch: `main`
- Starting commit: `5205f730fd0141fb9c8d0697787b700e4bda04ff`
- Starting worktree: clean.
- One test-harness change: [`tests/browser-love-letter.mjs`](../../tests/browser-love-letter.mjs) now passes `LOCAL_TEST_CATALOG_OVERRIDE:true` to its isolated Wrangler process. Its seeded legacy fixture prices otherwise caused the test to stop with `PRICE_UNAVAILABLE`.
- No application code was changed.

## E. Test environment and limitations

- Static browser checks used local servers on ports 5500 and 5501. These serve files but do not implement Worker/API routes.
- The static pages requested `GET /api/v1/customers/me`, which returned 404 from the static server. This prevented server-backed editor loading/save/preview checks in that environment; it is not evidence of a Worker API failure.
- Browser tabs reported `document.visibilityState === "hidden"` and heavily throttled animation frames. Consequently, 3D appearance/animation and reliable keyboard/focus behavior could not be established. A black or apparently stuck 3D scene in this harness is not classified as a product defect.
- Some image placeholders have empty sources. No failed external asset request was observed; the observed 404 was the unavailable API route above.

## F. Responsive viewport matrix

The homepage and all five template routes were loaded at each configured viewport. DOM measurements showed no horizontal overflow in any case.

| Page | 390 px | 430 px | 768 px | 1024 px | 1440 px |
|---|---:|---:|---:|---:|---:|
| Homepage | PASS* | PASS* | PASS* | PASS* | PASS* |
| Love Letter | PASS* | PASS* | PASS* | PASS* | PASS* |
| Our Memories | PASS* | PASS* | PASS* | PASS* | PASS* |
| Say Yes | PASS* | PASS* | PASS* | PASS* | PASS* |
| Distance Means Nothing | PASS* | PASS* | PASS* | PASS* | PASS* |
| Our Universe | PASS* | PASS* | PASS* | PASS* | PASS* |

`PASS*` means the route loaded and measured document width did not exceed the available client width. It does not certify visual polish, hit-target sizing, zoom behavior, keyboard operation, or 3D rendering. The mobile homepage menu expanded and exposed its navigation links when its DOM click handler was triggered; a real pointer/keyboard interaction was not established in the hidden-tab harness.

## G. Per-template functional coverage

| Template | Verified | Incomplete / outcome |
|---|---|---|
| Love Letter | Vietnamese/Unicode and script-like text remained text; the message cap reached 500 characters; recipient-mode toggle worked; a synthetic PNG decoded and produced a 512 × 512 photo thumbnail. | Static API 404 prevented authenticated editing, save, and preview verification. Unsupported/empty/oversized upload rejection was not established. The local synthetic order flow is covered separately below, but does not establish every editor path. |
| Our Memories | Script-like title remained text; a synthetic JPEG increased the photo count from 6 to 7 of 12. | Authenticated save/preview and the complete order path were not established. On mobile editor mode, the stage heading is hidden from the accessibility tree. |
| Say Yes | Script-like text remained text; local draft save/reload restored fields; test storage was removed afterward. | Server-backed save/preview and full order path were not established. On mobile editor mode, the stage heading is hidden from the accessibility tree. |
| Distance Means Nothing | Synthetic text saved to and restored from isolated local storage; test storage was removed afterward. | No image upload is supported. Server-backed save/preview and full order path were not established. |
| Our Universe | Route loaded and participated in responsive DOM checks. | Editing, save/reload, authenticated preview, and order/publication behavior were not exercised. |

**Overall template status: PARTIAL.** No template has a fully established end-to-end authenticated browser journey.

## H. Synthetic order-to-publication verification

`node tests/browser-love-letter.mjs` completed its isolated local fixture flow after the test-harness override was added. It reached `BROWSER_QA_READY`, and the control endpoint returned HTTP 200 on `/finish`.

Verified for the synthetic Love Letter fixture:

- Publication content was available with HTTP 200.
- A consented public asset was available before withdrawal; after consent withdrawal it returned 404.
- An unconsented photo was not exposed in the public photo count.
- An invalid public slug returned 404.
- The publication route rendered the recipient experience without visible editor inputs or order/payment wording.

This is a **single-template synthetic fixture flow**, using legacy fixture prices. It does not prove all-template fulfillment, standard catalog checkout/pricing, or any real payment behavior. The standard catalog is disabled in this local configuration; the documented standard pricing policy was not validated through checkout.

## I. Automated quality gates

| Gate | Result | Evidence |
|---|---|---|
| `npm run typecheck` | PASS | Completed without type errors. |
| `npm test` | PASS | 86/86 tests passed. |
| `npm audit --omit=dev` | PASS | Zero production dependency vulnerabilities reported. |
| `node tests/browser-love-letter.mjs` | PASS | Synthetic fixture flow reached ready state and exited successfully after finish. |
| `npm run test:integration` | **FAIL** | Reproducible `TypeError: fetch failed` / `ECONNRESET`, with stack locations at `tests/integration.mjs:155` and `tests/payment-contract.mjs:75`. |
| `git diff --check` | PASS | No whitespace errors. |

The integration failure occurred both during the broader run and when run alone. The local Worker logged preceding health/auth/design checks and an expected unpriced 422 response before the reset. The cause remains undetermined; assertions were not weakened and the failure is not attributed to concurrency.

## J. Accessibility and unverified areas

- Accessibility snapshots showed named controls overall.
- **Medium accessibility finding:** mobile editing hides the stage heading in Our Memories and Say Yes, leaving the editor without a visible/accessibility-tree main H1 in those states. See [`our-memories.css`](../../templates/our-memories/our-memories.css) and [`say-yes.css`](../../templates/say-yes/say-yes.css).
- Keyboard-only operation, focus order/visibility, screen-reader behavior, touch-target dimensions, and full contrast/WCAG conformance were not certified.
- The full authenticated save/preview flow for all templates, complete standard-pricing checkout, all-template order-to-publication flow, scheduled lifecycle job invocation, and Production preflight remain unverified.

## K. Readiness decision and next steps

**Do not mark ORDERS-2.3–2.6 Production-ready.** First diagnose and fix the local integration `ECONNRESET` without relaxing assertions. Then complete browser QA in a visible-capable browser against the local API/Worker, including authenticated save/reload/preview for all five templates and the intended synthetic pricing/order lifecycle. Recheck the mobile editor headings and complete keyboard/accessibility checks. Any Production preflight should be a separate, explicitly authorized activity.

## ORDERS-2.7 — QA GAP CLOSURE

### 1. Scope, baseline, and safety

This section adds ORDERS-2.7 evidence without replacing the historical ORDERS-2.3–2.6 findings above.

- Branch: `main`
- HEAD: `5205f730fd0141fb9c8d0697787b700e4bda04ff` (unchanged)
- Worktree changes from this QA attempt remain uncommitted.
- Tests used local synthetic accounts, designs, images, isolated local D1/R2, and the `sepay-test` payment mode. No Production access, deployment, real order, payment, email, or customer data was used.
- The task-created `.dev.vars`, synthetic image files, and isolated browser Worker persistence directory were removed after testing. No `session.json` was accessed.

### 2. Integration `ECONNRESET`: diagnosis and fix

**Original failure:** `npm run test:integration` reproduced `TypeError: fetch failed` / `ECONNRESET` on the anonymous `POST /orders` after local D1 seed operations. The Wrangler child remained alive and earlier requests succeeded, so the evidence did not indicate a startup failure, port collision, worker shutdown, or application process exit. The failure occurred at the next request, not after a request timeout.

**Best-supported cause:** Node/Undici reused a keep-alive connection across the local Wrangler/D1 request sequence, and that connection was reset before the next request. The test-only JSON request helper now sends `Connection: close`, preventing connection reuse. This is supported by the reproducible request location and successful isolated reruns with the change; the underlying socket event was not independently packet-traced, so the precise transport-level cause is not claimed as proven.

**Separate transient:** A final run started concurrently with the other regression gates failed before the Worker became ready with `SQLITE_BUSY_RECOVERY` from local Wrangler SQLite. The Worker was no longer running afterward; rerunning the integration suite alone passed. This startup lock is distinct from the original `ECONNRESET` and is recorded rather than hidden.

**Integration result after the test-only fix:** PASS on isolated reruns. Exact successful output:

```text
Local integration: passed (D1 API and payment contracts, legacy regression, constraints, and batch rollback).
```

Assertions and timeouts were not weakened or increased to obtain a pass.

### 3. Fixes and regression evidence

- `tests/integration.mjs` closes each JSON request connection and customizes, reloads, and previews the primary Our Universe design before the payment contract.
- `templates/our-universe/index.html` now preserves the design ID in private preview URLs, so exiting preview returns to the same design. Its inline-script CSP hash is synchronized in the HTML meta policy, `_headers`, and `vercel.json`.
- `templates/say-yes/say-yes.css` keeps editor visibility rules from overriding recipient-mode hiding on mobile.
- The editor titles in Our Memories, Say Yes, and Distance Means Nothing are H1s, so mobile editor states retain a top-level heading. The related structural test now expects those H1s.
- Love Letter now exposes the opened canvas letter through a visually hidden, polite live status region populated with `textContent` and cleared on close. A real open/close interaction announced the full Vietnamese/emoji/script-like text; the synthetic `<script>` string remained text, with no created script element or execution.
- The Love Letter inline-style and inline-script CSP hashes were recalculated and synchronized across the meta policy, `_headers`, and `vercel.json`. A prior browser reload exposed a stale script hash; after correction, the targeted CSP test passed and the browser reload emitted no CSP violation.
- The existing synthetic Love Letter browser harness continues to use its explicit local `LOCAL_TEST_CATALOG_OVERRIDE:true` flag; this does not change production configuration.

### 4. Five-template interaction matrix

`PASS` below is limited to the specific local interaction and data checked. It is not a WCAG or production certification.

| Template | Render / editor | Input, save, reload | Preview / recipient interaction | Image and invalid-input evidence |
|---|---|---|---|---|
| Our Universe | PASS | PASS — edited Unicode, Vietnamese, emoji, long, and script-like text; saved and reloaded the same design. | PASS — private preview hid the editor; exiting returned to the same design. | PASS — synthetic PNG/JPEG rendered thumbnails; deletion and add-again worked. Unsupported type, corrupt image, and a 5,242,881-byte image were rejected with user-facing messages. Source confirms a 5 MB limit and six-photo maximum. No dedicated in-place replacement control exists; replacement is delete-and-add. |
| Love Letter | PASS | PASS — server-backed synthetic text saved and reloaded, including Unicode and script-like input. | PASS — private preview hid the editor; opening the letter rendered the message on the canvas and announced its text equivalent. | PASS — PNG and JPEG file selection produced two rendered 512×512 thumbnails in the static local browser check; a synthetic backend asset upload and consent/publication path also passed. **NOT TESTED:** thumbnail deletion/replacement via a real visible-browser click; the browser tab was hidden and its actionability/stability checks timed out. The click handler exists, but source inspection is not counted as interaction evidence. |
| Our Memories | PASS | PASS — synthetic fields saved and reloaded. | PASS — private preview and recipient CTA worked; mobile chapter navigation was exercised. | PASS — valid synthetic image rendered; deletion worked. |
| Say Yes | PASS | PASS — synthetic fields saved and reloaded. | PASS — private preview hid the editor; recipient interaction and celebration worked. | PASS — valid synthetic image rendered; deletion worked. |
| Distance Means Nothing | PASS — collapsed story details were opened before interacting with fields; mobile editor tab was selected. | PASS — Unicode and script-like title saved and reloaded. | PASS — private preview displayed inert text; heart panel was operated by keyboard and closed with Escape. | NOT APPLICABLE — source contains no image-upload input or image-upload feature. |

Across tested templates, script-like user input remained text and was not executed. Invalid file type/corrupt-file handling and the configured oversized-file limit were exhaustively checked on Our Universe; those exact rejection cases were not repeated through every template-specific picker.

### 5. Responsive matrix

The homepage and each template were loaded at all requested widths. No unintended horizontal overflow was observed. Main content, navigation/primary CTA, editor or panel controls, and text/image layout remained usable in the measured and inspected states.

| Route | 390 px | 430 px | 768 px | 1024 px | 1440 px |
|---|---|---|---|---|---|
| Homepage | PASS | PASS | PASS | PASS | PASS |
| Our Universe | PASS | PASS | PASS | PASS | PASS |
| Love Letter | PASS | PASS | PASS | PASS | PASS |
| Our Memories | PASS | PASS | PASS | PASS | PASS |
| Say Yes | PASS | PASS | PASS | PASS | PASS |
| Distance Means Nothing | PASS | PASS | PASS | PASS | PASS |

The homepage mobile menu and template CTA navigation were operated. Editor panels and controls were inspected at the configured widths; scrollable panels were scrolled to their lower fields. On Our Memories, the sticky bottom actions can overlay lower content at the initial scroll position, but scrolling the editor exposes the final field fully. These are practical browser checks, not a pixel-perfect visual regression audit.

### 6. Accessibility evidence

- **Tool-assisted semantics:** accessibility snapshots were checked after opening collapsed panels/details. Visible text fields had accessible names/labels; visible buttons had names. No unnamed visible buttons were found in the checked states.
- **Keyboard/manual interaction:** Tab navigation and visible focus styling were checked on the homepage and template controls; Enter opened the homepage mobile menu. Representative main interactions were keyboard-operated. Distance Means Nothing's heart control opened its panel, focused the close control, and Escape closed it.
- **Headings:** mobile editor states for Our Memories, Say Yes, and Distance Means Nothing now expose an H1. The source-level regression assertion was updated and passes.
- **Canvas text:** the Love Letter canvas itself is not a semantic text surface; its message is now also announced through the named polite status region when opening. The region clears on close.
- **Dialogs/overlays:** no native or ARIA dialog roles were found. Existing overlays expose close controls; a modal dialog focus trap was therefore not claimed or tested.
- **Upload deletion:** the Love Letter thumbnail did not complete a reliable visible-browser click in this hidden-tab harness; see the interaction matrix.
- No complete WCAG audit, contrast certification, screen-reader conformance audit, or assistive-technology certification was performed. No WCAG compliance claim is made.

### 7. Upload test results

- Valid synthetic PNG/JPEG files were accepted and rendered as thumbnails in the tested upload UIs; Our Universe rendered 64×48 thumbnails and Love Letter rendered 512×512 canvases.
- Deletion was verified in Our Universe, Our Memories, and Say Yes. Love Letter thumbnail deletion/replacement remains **NOT TESTED** via a reliable real click.
- Unsupported type and corrupt-image rejection were verified with user-facing status on Our Universe. Its 5 MiB+1 fixture was rejected under the source-confirmed 5 MB limit.
- Synthetic backend asset upload, consented public access, and consent withdrawal were verified by the Love Letter fixture flow. This is not a substitute for testing the Love Letter picker’s delete click.
- Tested upload code revokes object URLs on image load/error; no unhandled page error was observed in the successful runs. Browser navigation away from the test pages invoked page cleanup. The synthetic files and isolated persistence were deleted.

### 8. Synthetic order-to-publication contract

**PASS — continuous local API contract; not a browser checkout or real SePay transaction.** `npm run test:integration` exercised the Worker with local D1/R2 and synthetic `PAYMENT_MODE=sepay-test`:

1. Our Universe design creation/customization, persistence reload, and preview.
2. The remaining four template designs with template-specific synthetic content, save/reload, and preview checks.
3. Standard pricing snapshots: 1 month **59,000 VND**, 2 months **69,000 VND**, 3 months **79,000 VND**, 6 months **109,000 VND**, 12 months **169,000 VND**, and Lifetime **199,000 VND**.
4. Server-side order creation, pricing snapshot persistence, idempotency, client-amount/payment-claim rejection, and authentication/ownership isolation.
5. A synthetic HMAC-signed webhook, verification, replay/duplicate handling, fulfillment, publication, and public access.
6. Synthetic expiry/revocation lifecycle checks and legacy regression, database constraints, and batch rollback.

Webhook replay assertions verified one payment, one processed event, one publication, one entitlement, and one fulfillment job. Standard pricing was tested separately from the contract's seeded mock-payment amount; no actual payment was initiated.

**NOT TESTED:** a browser-driven checkout/payment UI, a real SePay request, external email delivery, Production configuration, or an actual scheduled Cron invocation. The expiry/lifecycle assertions used local test hooks; they do not prove a deployed scheduler ran.

### 9. Final regression gates

| Gate | Final result | Exact evidence |
|---|---|---|
| `npm run typecheck` | PASS | `tsc --noEmit` exited 0. |
| `npm test` | PASS | 86 tests passed; 0 failed. |
| `npm run test:integration` | PASS | Isolated reruns emitted the success line in section 2. A concurrent run had the separately recorded local SQLite startup lock. |
| `npm audit --omit=dev` | PASS | `found 0 vulnerabilities`. |
| `node --experimental-strip-types --test tests/security-headers.test.ts` | PASS | 4 tests passed; 0 failed. |
| `git diff --check` | PASS | Exited 0 with no whitespace errors. |

The first full `npm test` after the mobile H1 change exposed a stale assertion expecting the former paragraph element (85 passed, 1 failed). The assertion was corrected to require the H1; the final run passed 86/86.

### 10. Files changed and final state

Files changed by this QA work:

- `_headers`
- `vercel.json`
- `templates/distance-means-nothing/index.html`
- `templates/love-letter/index.html`
- `templates/our-memories/index.html`
- `templates/our-memories/our-memories.js`
- `templates/our-universe/index.html`
- `templates/say-yes/index.html`
- `templates/say-yes/say-yes.css`
- `templates/say-yes/say-yes.js`
- `tests/browser-love-letter.mjs`
- `tests/integration.mjs`
- `tests/template-registry.test.ts`
- `docs/qa/ORDERS-2.3-2.6-FINAL-QA-REPORT.md` (this appended section)

Final branch/HEAD remain `main` / `5205f730fd0141fb9c8d0697787b700e4bda04ff`. The final worktree contains only the listed tracked modifications and this untracked report; `.dev.vars`, synthetic image fixtures, and isolated QA state were removed. No commit, push, merge, reset, or deployment was performed.

Final `git status --short`:

```text
 M _headers
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
 M tests/template-registry.test.ts
 M vercel.json
?? docs/qa/
```

### 11. ORDERS-2.7 readiness

**Final classification: CONDITIONALLY READY.**

All automated local regression gates and the synthetic API order-to-publication contract pass. Before Production preflight, verify Love Letter thumbnail deletion/replacement with a reliable visible browser and complete any separately required operational/provider checks. This classification does not authorize or perform Production access, payment, or deployment.

## ORDERS-2.8 — QA GAP CLOSURE

This section adds ORDERS-2.8 evidence and supersedes the earlier Love Letter image-lifecycle limitation above. All ORDERS-2.3–2.7 findings remain preserved.

### 1. Scope and safety

- Work remained local and synthetic, using an isolated Wrangler Worker, local D1/R2, synthetic customer/design data, and `PAYMENT_MODE=mock` for browser checkout. The integration contract was run separately with local `PAYMENT_MODE=sepay-test` and a synthetic webhook secret.
- No Production resources, real orders, payments, emails, or customer data were used. No deployment, commit, push, merge, or branch reset occurred. `session.json` was not accessed.
- Branch and HEAD remained `main` / `5205f730fd0141fb9c8d0697787b700e4bda04ff`.

### 2. Love Letter image lifecycle

**PASS — synthetic local browser flow.** The thumbnail delete affordance is now a named native button. After a successful design save, the shared editor compares saved asset references and requests deletion only for assets no longer referenced by the saved design. Failed cleanup is surfaced to the user rather than silently treated as success.

- A saved PNG thumbnail was removed through its visible control; after save and reload, the corresponding asset was `DELETED`.
- A replacement JPEG was uploaded, rendered, saved, and restored after reload.
- Attempting to reference that asset from a different synthetic design returned `422 VALIDATION_ERROR`.
- Server logs recorded successful upload/complete/save operations and persisted images rendered. Some browser logs also showed `net::ERR_ABORTED` for asset-content PUTs; the UI, persistence state, and rendered previews succeeded, so the discrepancy remains unexplained rather than being classified as a confirmed upload failure.
- The previous ORDERS-2.7 Our Universe upload checks remain valid: supported PNG/JPEG, thumbnail rendering, delete/add, unsupported type, corrupt image, and a 5,242,881-byte fixture rejected against the source-confirmed limit. Distance Means Nothing has no image-upload feature (**NOT APPLICABLE**, confirmed in source).

### 3. Five-template checkout evidence

Each saved template reached its checkout page, and one local mock order was created through the visible UI for each:

| Template | Checkout and mock order | Result |
|---|---|---|
| Our Universe | PASS | 1-month order created at 59,000 VND; pending mock payment; no QR. |
| Love Letter | PASS | 1-month order created at 59,000 VND; pending mock payment; no QR. |
| Our Memories | PASS | 1-month order created at 59,000 VND; pending mock payment; no QR. |
| Say Yes | PASS | 1-month order created at 59,000 VND; pending mock payment; no QR. |
| Distance Means Nothing | PASS | 1-month order created at 59,000 VND; pending mock payment; no QR. |

The checkout displayed the following standard prices: 1 month **59,000 VND**, 2 months **69,000 VND**, 3 months **79,000 VND**, 6 months **109,000 VND**, 12 months **169,000 VND**, and Lifetime **199,000 VND**. Invalid duration `0` produced the validation message and disabled order submission; correcting it to `2` months recalculated the total to **69,000 VND** and re-enabled submission. No invalid order was submitted.

All five UI orders remain pending in disposable local test state. The UI explicitly stated that mock mode creates no QR or bank transaction. Browser-based settlement, webhook submission, fulfillment, and publication were **NOT TESTED**. The separate continuous synthetic API contract below covers those server-side stages; it is not misrepresented as a browser checkout journey.

During teardown, the final checkout page continued polling after the isolated Worker was stopped and logged repeated `net::ERR_CONNECTION_REFUSED` requests until the browser navigated away. These are teardown-time network failures, not evidence of failed order creation; the teardown event output showed request/resource-load errors and no `pageerror` event.

### 4. Integration contract and lifecycle scheduler

**PASS — local synthetic API contract.** `npm run test:integration` passed and reported:

```text
Local integration: passed (D1 API and payment contracts, legacy regression, constraints, and batch rollback).
```

The contract uses local D1/R2 and `PAYMENT_MODE=sepay-test`; it exercises the all-template design/order contract, pricing and idempotency, signed synthetic webhook verification/replay, fulfillment, publication/public access, and expiry lifecycle. No SePay transaction or external provider call was made.

**PASS — authenticated local Vercel route lifecycle test.** Unit coverage verifies missing and invalid Cron authorization return 401 without opening a database connection; valid synthetic authorization expires an expired publication, preserves active publications, returns 410 for expired public access and 200 for active access, retries derivative/source cleanup failures, completes cleanup, and remains idempotent on rerun.

**NOT TESTED — deployed scheduler invocation.** Local Wrangler does not automatically fire scheduled events during local development, and no deployed Cron was invoked. There is also an unresolved configuration discrepancy: `vercel.json` schedules `/api/cron/publication-lifecycle` daily, while the Vercel handler intentionally returns 404 unless `ENVIRONMENT=staging` and `VERCEL_ENV=preview`. The Cloudflare Worker configs separately schedule maintenance every 15 minutes. Confirm which scheduler is authoritative for each deployment and align/verify the production lifecycle path before preflight; this QA did not change provider or deployment configuration.

### 5. Accessibility and responsive evidence

- The Love Letter deletion control has a programmatic name and native button semantics; structural regression coverage passes. A visible mouse click worked. Keyboard activation of this specific button remains **NOT TESTED**: the prior repeated-Tab attempt did not establish focus on the control, so no keyboard success is claimed.
- The full homepage/template responsive matrix for 390, 430, 768, 1024, and 1440 px, and the practical keyboard/heading findings, remain documented in ORDERS-2.7 §5–6 above; they were not comprehensively repeated during ORDERS-2.8.
- No WCAG conformance, full screen-reader audit, or assistive-technology certification is claimed.

### 6. Final regression gates

| Gate | Result | Exact evidence |
|---|---|---|
| `npm run typecheck` | PASS | `tsc --noEmit` exited 0. |
| `npm test` | PASS | 89 tests passed; 0 failed, cancelled, or skipped. |
| `npm run test:integration` | PASS | Local D1 API/payment contract success line shown in §4. |
| `npm audit --omit=dev` | PASS | `found 0 vulnerabilities`. |
| `git diff --check` | PASS | No whitespace errors. |

### 7. Files changed and final state

The worktree changes include:

- `_headers`
- `shared/customer-editor.js`
- `templates/distance-means-nothing/index.html`
- `templates/love-letter/index.html`
- `templates/our-memories/index.html`
- `templates/our-memories/our-memories.js`
- `templates/our-universe/index.html`
- `templates/say-yes/index.html`
- `templates/say-yes/say-yes.css`
- `templates/say-yes/say-yes.js`
- `tests/browser-love-letter.mjs`
- `tests/integration.mjs`
- `tests/publications.test.ts`
- `tests/scheduler.test.ts`
- `tests/template-registry.test.ts`
- `vercel.json`
- This report at `docs/qa/ORDERS-2.3-2.6-FINAL-QA-REPORT.md`

The synthetic UI orders and isolated test database were removed after the browser checks. The task-created `.dev.vars` copy and isolated `crushify-orders-2-8-*` directory were also removed; the browser navigated away from the test checkout. No local Worker remains listening on ports 8787 or 8789.

Final branch/HEAD remain `main` / `5205f730fd0141fb9c8d0697787b700e4bda04ff`. Final `git status --short`:

```text
 M _headers
 M shared/customer-editor.js
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
 M tests/publications.test.ts
 M tests/scheduler.test.ts
 M tests/template-registry.test.ts
 M vercel.json
?? docs/qa/
```

No commit, push, merge, reset, or deployment was performed.

### 8. ORDERS-2.8 readiness

**Final classification: NOT READY.**

Local regression gates, mock checkout creation for all five templates, Love Letter image deletion/replacement, and the synthetic API lifecycle contract passed. The deployed scheduler behavior remains unverified, and the Vercel Cron schedule/preview-only route mismatch has not been resolved. Do not proceed to Production preflight until the authoritative scheduler and its deployment-specific lifecycle path are confirmed. This is not Production approval and does not authorize Production access, payment, or deployment.

## ORDERS-2.9 — Deployment Architecture & Checkout Verification

This section adds ORDERS-2.9 evidence without replacing historical results above.

### 1. Scope and safety

All new runtime and browser checks used local synthetic data and temporary databases. No Production project, database, storage account, endpoint, or secret value was accessed. The checkout UI created local mock orders only; no SePay request, bank transfer, real email, deployment, or remote migration was performed. No commit, push, merge, or branch reset was performed.

### 2. Integration startup diagnosis

**Initial attempt — BLOCKED before server startup.** The first `npm run test:integration` stopped at the harness precondition because `.dev.vars` was absent:

```text
Error: Copy .dev.vars.example to .dev.vars before running npm run test:integration.
```

This attempt did not start Wrangler or issue an API request, so it did not reproduce an `ECONNRESET` and is not evidence of an application or server-lifecycle failure. Inspection showed the integration harness supplies its required local environment values directly to Wrangler, including a generated webhook secret, and uses an isolated D1 persistence directory. The `.dev.vars` existence check was therefore an unnecessary test-only prerequisite, not a required application configuration.

**Fix — PASS.** Removed only that redundant precondition (and its now-unused imports); no assertions, timeouts, retries, or test coverage were weakened. The rerun completed:

```text
Local integration: passed (D1 API and payment contracts, legacy regression, constraints, and batch rollback).
```

No `ECONNRESET` occurred on the successful run. No application defect was found from this diagnostic.

### 3. Scheduler and deployment architecture

| Surface | ORDERS-2.9 finding |
|---|---|
| Vercel schedule | `vercel.json` declares one publication-lifecycle Cron at `03:00 UTC` daily. Vercel Cron invokes the Production deployment. The protected handler accepts only matching `ENVIRONMENT=production` / `VERCEL_ENV=production` or `ENVIRONMENT=staging` / `VERCEL_ENV=preview` pairs, and checks bearer authorization before connecting to the database. |
| Cloudflare schedule | Removed `triggers.crons` from both Wrangler configs to avoid a second automatic lifecycle runner. The Worker `scheduled()` handler remains in code for rollback compatibility; it is not automatically scheduled by these configs. |
| Handler verification | **PASS — local synthetic.** The Production-pair Vercel route test uses an in-memory Turso-compatible database and storage mock. It covers missing/invalid authorization, expiry, public denial for expired content, active public access, cleanup retries, completion, and idempotent reruns. Scheduler lease and duplicate-schedule config tests also pass. This does not verify a deployed Cron. |
| Preview | **NOT TESTED / no automatic schedule.** Vercel does not invoke Cron on Preview deployments; Preview publication expiry and cleanup therefore have no configured automatic runner. The Worker schedule was removed and no Preview scheduler was deployed. |
| Production configuration | **NOT TESTED.** No `.vercel/project.json` is present; deployment, `CRON_SECRET` presence, provider configuration, database state, Cron invocation, and Cloudinary behavior were not verified. No Production values were inspected or used. |
| Plan eligibility | **BLOCKED for commercial readiness.** The configured daily cadence is within Vercel Hobby's current frequency limit, but Hobby is for non-commercial personal use. Account eligibility and a suitable commercial plan are unverified; see [Vercel Hobby terms](https://vercel.com/docs/plans/hobby) and [Cron usage limits](https://vercel.com/docs/schedules/cron-jobs/usage-and-pricing). |
| Worker recovery | Cloudflare's scheduled code includes fulfillment recovery as well as lifecycle work. The Vercel Cron invokes publication lifecycle only; it is not a pending-webhook recovery runner. No production payment or fulfillment service is enabled. |

Documentation was aligned in `docs/HOSTING_MIGRATION.md`, `docs/VERCEL_STAGING.md`, `docs/PAYMENT_FLOW.md`, `docs/PUBLICATION_AND_DELIVERY.md`, `docs/PRODUCT_ARCHITECTURE.md`, and `docs/STAGING_DEPLOYMENT.md`. The lifecycle route is now compatible with its Production Cron target, but this code change is not a deployment or authorization to deploy.

| Environment | Code/config evidence | Runtime evidence | Lifecycle scheduler |
|---|---|---|---|
| Local synthetic | PASS — Wrangler test harness, isolated D1, generated webhook key, mock payment/browser fixture | PASS — integration and browser checks described below | API lifecycle tests only; no real timed scheduler run |
| Vercel Preview | Configured to require staging/Preview environment pairing and staging-scoped credentials | NOT TESTED — no remote Preview deployment or provider credentials accessed | BLOCKED — Vercel Cron does not run on Preview; no alternate scheduler configured |
| Vercel Production | `vercel.json` declares daily lifecycle Cron; handler requires `CRON_SECRET` | NOT TESTED — no project, secret, DB/storage, or deployment inspected | NOT TESTED — configuration exists, but no deployed Cron invocation or secret verification |

### 4. Checkout browser interaction matrix

**PASS — local browser interaction.** A temporary local Wrangler Worker used an isolated D1 database, synthetic signed-in drafts, `PAYMENT_MODE=mock`, and the local standard pricing policy. Browser actions used actual checkout controls; no DOM mutation was used to claim success.

| Template route | Rendered draft / name | Invalid 0-month input | 1-month mock order | Mock/QR behavior | Fatal page errors |
|---|---|---|---|---|---|
| `our-universe` | PASS — Our Universe | PASS — estimate unavailable; submit disabled | PASS — 59,000 VND | Mock notice shown; no QR | None observed |
| `love-letter` | PASS — Love Letter | PASS — estimate unavailable; submit disabled | PASS — 59,000 VND | Mock notice shown; no QR | None observed |
| `our-memories` | PASS — Our Memories | PASS — estimate unavailable; submit disabled | PASS — 59,000 VND | Mock notice shown; no QR | None observed |
| `say-yes` | PASS — Say Yes | PASS — estimate unavailable; submit disabled | PASS — 59,000 VND | Mock notice shown; no QR | None observed |
| `distance-means-nothing` | PASS — Distance Means Nothing | PASS — estimate unavailable; submit disabled | PASS — 59,000 VND | Mock notice shown; no QR | None observed |

**Template editor interaction detail:** The authenticated synthetic browser session opened all five editor routes, changed a visible field, used the template's save/continue-to-checkout control, and reached checkout before creating the pending mock order. `distance-means-nothing` initially hides editor actions; opening its “Chỉnh sửa” panel first was required and then worked. The selected template was rendered in checkout. An additional attempt to verify a changed editor field after a reload timed out waiting for an obsolete status-label string; the page actually showed “Đã lưu trên máy chủ” and the live preview reflected the changed Our Universe field. That assertion is **NOT TESTED**, not an application failure. Per-template editor-field persistence after reload is therefore not claimed.

Checkout UI pricing was interacted with and read from the rendered totals:

| Hosting selection | Rendered total |
|---|---:|
| 1 month | 59,000 VND |
| 2 months | 69,000 VND |
| 3 months | 79,000 VND |
| 6 months | 109,000 VND |
| 12 months | 169,000 VND |
| Lifetime | 199,000 VND |

**Additional input/security cases:** Love Letter browser controls rejected negative, zero, and fractional month values with “Chưa thể tính” and kept order submission disabled. A browser request tampered with `total_minor: 1` was rejected with HTTP 400; the form stayed available and a later valid retry created the expected 59,000-VND mock order. Missing design ID rendered an explicit error and created no order; malformed and valid-format nonexistent design IDs did not open a usable checkout. These are local synthetic UI checks. Browser double-click/duplicate-submit behavior was **NOT TESTED**; API idempotency/replay coverage is reported separately below.

**PASS — reload restoration.** Reloading the Our Universe checkout restored its synthetic pending order and 59,000 VND total from session storage. The UI-created mock orders deliberately remained `AWAITING_PAYMENT`; the browser run did not settle them or claim publication.

After the isolated Worker was stopped, a status-poll request in the first browser tab logged `net::ERR_CONNECTION_REFUSED` during teardown. The page was then navigated away. No `pageerror` was observed during checkout interactions; the teardown request is not counted as an application runtime pass or failure.

### 5. Responsive and accessibility evidence

Responsive checks apply to the checkout page only, not a repeat of the full homepage/template matrix from prior sections. For each width, the main panel and submit button had positive rendered bounds within the viewport, remained visible, and the document did not overflow horizontally:

| Viewport width | Document scroll width | Main content width | Panel and primary button within viewport |
|---:|---:|---:|---|
| 390 px | 375 px | 355 px | PASS |
| 430 px | 415 px | 395 px | PASS |
| 768 px | 753 px | 720 px | PASS |
| 1024 px | 1009 px | 720 px | PASS |
| 1440 px | 1425 px | 720 px | PASS |

Responsive behavior of the homepage, each editor canvas, collapsed panels, and template-specific previews at these widths is **NOT TESTED** in ORDERS-2.9. The checkout measurements do not establish responsive readiness for those routes.

Tool-assisted accessibility-tree checks found an `h1` followed by the checkout `h2`, a named checkout region, associated labels for the hosting select and numeric input, a named confirmation checkbox, a named submit button, and a polite live status region. Invalid-month feedback is rendered as text and prevents submission. The order panel has an accessible name. The checkout has no modal/dialog; dialog focus behavior is **NOT APPLICABLE**.

Keyboard activation and visible-focus appearance are **NOT TESTED**. Integrated-browser Space/Tab attempts did not produce a reliable checkbox toggle or establish a keyboard-submitted order, and screenshot capture was unavailable. Pointer/Playwright control interaction passed; this does not establish keyboard accessibility. No WCAG conformance claim is made.

### 6. Payment, security, and order-to-publication evidence

**PASS — API-level synthetic end-to-end contracts.** The successful `npm run test:integration` invokes the payment contract with `allTemplates: true` and standard-pricing checks. It exercises local server-calculated order totals, rejection of client-supplied price/payment claims, authentication and ownership boundaries, idempotency, invalid/missing/expired signatures, signed synthetic webhook replay, verified settlement, fulfillment, publication, public access, and lifecycle outcomes. Its webhook uses a generated local HMAC secret and dummy account value; it does not call SePay. The contract's legacy test-price fixtures are synthetic and are not Production pricing. Additional regression assertions now reject negative, zero, fractional, and unsafe month counts; an unsupported storage plan; and a malformed order ID.

| E2E stage | Browser checkout | Local API/integration contract |
|---|---|---|
| Template → design → customization → preview | PASS — synthetic editor flow; no rendered editor-field persistence claim after reload | Design ownership/schema contracts pass |
| Pricing → order | PASS — all five routes created pending mock orders; six standard totals rendered | PASS — server-calculated totals; client price/plan tampering rejected |
| Payment → verified webhook | NOT TESTED — no real payment or browser settlement | PASS — generated local HMAC, valid signature, invalid signature and replay cases |
| Fulfillment → publication → public access | NOT TESTED in browser | PASS — synthetic end-to-end contract; public read and expiry/lifecycle checked |
| Expiry/retry/idempotency | NOT TESTED in browser | PASS — local lifecycle, retries and idempotent API/scheduler contracts |

This is **PASS for the existing API-level synthetic flow**, not a claim that browser checkout itself was settled end-to-end. Browser checkout stopped at mock `AWAITING_PAYMENT`, while verified webhook/publication was exercised by the independent API integration contract. No real payment, customer, email, or Production publication was involved.

The standard VND price grid above was verified through the checkout UI. Additional payment integrity and idempotency tests passed as part of the integration and unit suites. No full independent penetration test or WCAG audit was performed.

**Focused security review — no actionable vulnerabilities found** in the reviewed worktree changes. The review was read-only and limited to checkout/order/payment/webhook/publication and Vercel Cron behavior plus relevant baseline code. It was not a penetration test; deployed behavior and credentials were deliberately out of scope.

### 7. Final regression gates

| Gate | Result | Exact evidence |
|---|---|---|
| `npm run typecheck` | PASS | `tsc --noEmit`; exit code 0. |
| `npm test` | PASS | 90 passed; 0 failed, cancelled, or skipped; exit code 0. |
| `npm run test:integration` | PASS | `Local integration: passed (D1 API and payment contracts, legacy regression, constraints, and batch rollback).` |
| `npm audit --omit=dev` | PASS | `found 0 vulnerabilities`. |
| `git diff --check` | PASS | Exit code 0; no output. |
| Targeted scheduler/publication/Vercel tests | PASS | 15 passed; 0 failed (prior targeted run). |

### 8. ORDERS-2.9 files changed

ORDERS-2.9 changes:

- `src/platform/vercel.ts`
- `wrangler.jsonc`
- `wrangler.staging.jsonc`
- `tests/publications.test.ts`
- `tests/scheduler.test.ts`
- `tests/payment-contract.mjs`
- `tests/integration.mjs`
- `vercel.json`
- `docs/HOSTING_MIGRATION.md`
- `docs/VERCEL_STAGING.md`
- `docs/PAYMENT_FLOW.md`
- `docs/PUBLICATION_AND_DELIVERY.md`
- `docs/PRODUCT_ARCHITECTURE.md`
- `docs/STAGING_DEPLOYMENT.md`
- This report

Earlier ORDERS-2.7/2.8 worktree changes remain preserved and are listed in the historical sections above.

The temporary browser setup script and its isolated local Worker/database were removed after use; no fixture server remains listening on ports 8799 or 54965.

### 9. ORDERS-2.9 readiness

**Final classification: NOT READY.** Local scheduler tests, checkout interactions and pricing, synthetic API payment/publication contracts, and regression gates pass. Production deployment/runtime/secret/provider configuration remains unverified, Preview has no automatic lifecycle scheduler, and Vercel Hobby's non-commercial restriction is unresolved. Keyboard behavior and visible focus are not established. Do not authorize or perform Production preflight, payment, or deployment based on this report.

### 10. Architecture decision record

**Decision (local configuration only):** Vercel Cron is the sole configured automatic publication-lifecycle scheduler. Cloudflare Cron triggers are disabled to prevent duplicate execution; the Worker `scheduled()` implementation remains available for rollback compatibility. The Vercel lifecycle handler accepts matching Production and Preview/staging environment pairs and retains bearer-secret validation.

**Trade-offs and unresolved gates:** Vercel Cron only runs on Production deployments, so Preview has no automatic expiry/cleanup runner. Vercel Cron does not replace Cloudflare's pending fulfillment recovery. The runtime environment, secrets, database/storage separation, commercial-plan eligibility, and actual scheduled invocation have not been verified remotely. Resolve an approved commercial hosting plan and a supported Preview lifecycle strategy, then verify both in a safe staging project before Production preflight. This decision does not authorize deployment.

### 11. Final Git state

Branch and HEAD remain `main` / `5205f730fd0141fb9c8d0697787b700e4bda04ff`. Final `git status --short`:

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
?? docs/qa/
```

No commit, push, merge, reset, or deployment was performed.

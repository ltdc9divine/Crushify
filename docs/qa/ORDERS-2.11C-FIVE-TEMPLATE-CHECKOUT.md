# ORDERS-2.11C — Five-Template Authenticated Checkout

**Run date:** 2026-11-12  
**Classification:** **PASS — local synthetic checkout matrix only**  
**Production readiness:** Not evaluated or authorized.

## Scope and safety

- Ran Playwright Chromium headless against an isolated local Wrangler Worker at `127.0.0.1:8798`, with isolated local D1 persistence.
- Used synthetic customer sessions and designs only. The Worker was configured with `PAYMENT_MODE=mock` and local test flags.
- Did not access Production, call a real payment provider, create a real transaction, deploy, commit, push, merge, or access `session.json`.
- Session and CSRF values were held in memory and were not printed or saved in evidence.
- The pre-existing local server on port 8799 was not stopped or modified.
- The isolated test Worker and its D1 persistence were stopped and removed. Port 8798 was no longer listening; port 8799 remained active.

## Authenticated browser matrix

For each template run in this table, a separate synthetic customer session and Design were created. Playwright loaded the checkout page, checked the displayed template title, selected one month, verified the displayed 59,000 VND estimate, accepted the terms, and submitted through the visible UI. The order response was HTTP 201. After reload, the same order reference and `AWAITING_PAYMENT` status were visible, and the authenticated status endpoint returned HTTP 200 for the same Design and order. The API response confirmed `mock_mode: true`; the mock notice was visible and the QR panel was hidden.

| Template | Template ID | Design ID | Order ID | Checkout / submit | Total | Before / after reload |
|---|---|---|---|---|---:|---|
| Our Universe | `our-universe` | `144dad01-b1d5-498e-b950-016e7a327ccd` | `83403078-0e80-4e65-9a74-9fb2054ea8b4` | HTTP 200 / 201 | 59,000 VND | `AWAITING_PAYMENT` / `AWAITING_PAYMENT` |
| Love Letter | `love-letter` | `726dc10e-e626-4afb-8305-a02fdc93b426` | `8edaf3c4-9a27-45d7-a877-9dc343d5a5b2` | Prior ORDERS-2.11B browser evidence; not rerun | 59,000 VND | `AWAITING_PAYMENT` / `AWAITING_PAYMENT` |
| Our Memories | `our-memories` | `85b8bb81-4120-48b6-88fd-cdddb11a5616` | `80874937-3dd4-4adc-84f1-8a8fc9ea7633` | HTTP 200 / 201 | 59,000 VND | `AWAITING_PAYMENT` / `AWAITING_PAYMENT` |
| Say Yes | `say-yes` | `58b66856-119f-4fa8-9985-7ec65547f030` | `30dcfc5d-3667-48dd-aaa0-aee35b61479f` | HTTP 200 / 201 | 59,000 VND | `AWAITING_PAYMENT` / `AWAITING_PAYMENT` |
| Distance Means Nothing | `distance-means-nothing` | `580210e5-0c81-4471-b8dd-2e76858121ee` | `057e0d7a-c459-41ee-9052-36dfdf7a1210` | HTTP 200 / 201 | 59,000 VND | `AWAITING_PAYMENT` / `AWAITING_PAYMENT` |

Love Letter is carried forward from the prior authenticated ORDERS-2.11B browser run, which reported a successful UI submission, reload persistence, mock-payment note, and no QR. It was intentionally not submitted again. Its prior evidence is not a rerun in this isolated fixture.

For the four new runs, DOM evidence included the expected template title, the rendered price estimate, the post-submit status, the mock-payment notice, and the hidden QR panel. Browser page errors: **0** across the four runs. Browser-observed external HTTP requests: **0**. No screenshot was exported in this run; the evidence is the captured Playwright DOM state and HTTP/API results.

## Duplicate submission and idempotency

| Check | Result | Evidence |
|---|---|---|
| Rapid UI double-click | **PASS for this interaction** | Two pointer clicks on Our Universe produced one browser `POST /orders` and one order. |
| Replay with the same idempotency key | **PASS** | Server returned HTTP 200 with the original Order ID. |
| Two concurrent requests with the same key | **PASS** | Both returned HTTP 200 and the same Order ID. |
| New key on the same Design | **PASS — a distinct order is allowed** | Server returned HTTP 201 and created a second order, `2c2fdd95-8d21-49ef-be9d-719cb1b6107d`. |

The UI double-click result establishes one request for that rapid pointer interaction; it does not by itself establish server-side protection. The same-key replay and concurrent-request API checks establish backend idempotency for a reused key. A distinct idempotency key is not deduplicated by Design ID, so multiple orders on one Design are supported by the observed API behavior.

## Server-side pricing matrix

Pricing requests used the Standard Our Universe synthetic Design. For every valid duration, the server returned HTTP 201 and the returned pricing snapshot was verified again through the order status endpoint.

| Duration | Expected / server total | Create HTTP | Snapshot after status reload |
|---|---:|---:|---|
| 1 month | 59,000 VND | 201 | PASS |
| 2 months | 69,000 VND | 201 | PASS |
| 3 months | 79,000 VND | 201 | PASS |
| 6 months | 109,000 VND | 201 | PASS |
| 12 months | 169,000 VND | 201 | PASS |
| Lifetime | 199,000 VND | 201 | PASS |

Invalid cases returned HTTP 400: `hosting_months` 0, -1, and 1.5; `duration_type=weekly`; unsupported `storage_plan_id=2-months`; and client-supplied `total_minor=1` or `amount=1`. No Premium or Custom Design pricing was tested or inferred from the Standard policy.

## Issues and test setup

- The first fixture attempt supplied schema version 2 for Our Universe, which the registry does not support; design creation correctly returned HTTP 422. Inspection showed the four templates in the new matrix use schema version 1. The fixture was corrected and all four designs were then created successfully. This was a fixture input error, not an application defect; no source code was changed.
- A first isolated Worker startup using a persistence directory under the system Temp path failed with `SQLITE_IOERR_TRUNCATE`. No orders were created in that attempt. Using a fresh persistence directory directly under LocalAppData started the Worker successfully. The successful matrix used that local directory and removed it afterward.
- No application defect was established during this task.

## Not tested

- Love Letter was not rerun; its row relies on the prior ORDERS-2.11B evidence.
- Publication/fulfillment, expiry, real payment provider behavior, and Production/Preview environments.
- Premium or Custom Design pricing.
- Server-process outbound traffic was not independently packet-captured. Mock mode was explicitly configured, the order API reported `mock_mode: true`, the UI displayed the mock notice without QR, and the browser made no external HTTP requests.
- A screenshot artifact; browser evidence was captured from DOM and HTTP/API state instead.

## Files and final worktree

Files changed by this task:

- `docs/qa/ORDERS-2.11C-FIVE-TEMPLATE-CHECKOUT.md` — this report.

No source code was changed. The temporary test runner was removed. Existing worktree changes were preserved; the worktree remains non-clean and no commit was made. Branch: `main`. HEAD: `5205f730fd0141fb9c8d0697787b700e4bda04ff`.

`git diff --check` completed without errors. The new report had no trailing whitespace. Exact final `git status --short --untracked-files=all`:

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
?? docs/qa/ORDERS-2.3-2.6-FINAL-QA-REPORT.md
?? tests/orders-2-10-browser-fixture.mjs
```

**Final classification:** PASS for the five-template authenticated checkout matrix, combining four newly observed local browser runs with the prior Love Letter browser evidence; PASS for the local Standard pricing and invalid-input matrix. This is a scope-limited local QA result, not a Production-readiness assessment.

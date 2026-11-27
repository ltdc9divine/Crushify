# Crushify — Full Project Health and Cleanup Audit

**Scope:** source-level review of the current worktree. No Production or Preview database, account, credential, payment provider, or deployment was accessed. `.env.local` and local database contents were not read. No code cleanup was performed.

## 1. Executive summary

**Decision: NOT READY to accept real paid orders or automated payments.**

Crushify has a substantial product implementation: five interactive templates; server-validated design schemas; customer magic-link authentication; owner-scoped drafts, previews, uploads and orders; a VND catalog; SePay webhook verification and durable settlement evidence; and retryable publication/hosting lifecycle code. These are **source capabilities**, not proof of a currently deployed customer service.

The launch path is deliberately closed in Production. `resolvePaymentEnvironmentPolicy()` disables order creation and SePay webhook settlement in Production, and `publicationMutationsEnabled()` disables publication mutations there. Production automated fulfillment therefore cannot complete an end-to-end order-to-delivery flow. SePay Live, a real Production settlement, and deployment configuration were not verified.

**Highest-priority gaps:** Production payment/publication are disabled; no approved terms/privacy/refund pages exist; payment refund/reconciliation and customer support procedures are incomplete; media metadata is not sanitized at the server boundary; and provider setup, backups/restores, routing and scheduled jobs have not been verified in the target deployment.

## 2. Git baseline and audit constraints

| Item | Baseline |
|---|---|
| Branch | `main` |
| HEAD | `49c648cce83696444a2e5f1edb5e0ddb02390445` |
| Staged changes | None |
| Existing modified files | `docs/API_SPECIFICATION.md`, `docs/FINAL-API-HANDOFF.md`, `scripts/staging-diagnostics.ts`, `scripts/staging-turso.ts`, `src/database/migrations.ts`, `tests/release-manifest.test.ts`, `tests/security-headers.test.ts`, `vercel.json` |
| Existing untracked files | `api/v1.ts`, `docs/HOSTING_PRODUCTION_EVALUATION.md`, `scripts/staging-preflight-report.ts`, `tests/staging-preflight-report.test.ts`, `tests/vercel-api-routing.test.ts` |

These are pre-existing changes and were preserved. One safe static check was run: `npm run typecheck` — **PASS** (`tsc --noEmit`). No unit/integration/browser tests, migration, preflight, service, database, or external provider was run. No runtime, browser console, network, deployed route, or mobile-device result is claimed.

The working directory also contains ignored/local artifact names, including `.env.local` and local database files. Their contents were not inspected and they are not deletion candidates in this audit.

## 3. Current architecture

```text
Static website (index.html, css/, js/)
   ├── five template editors (templates/*)
   ├── shared customer editor + publication bootstrap (shared/)
   ├── checkout, customer websites and admin pages
   └── /api/v1/* ── Vercel Node adapter (api/v1.ts → api/[...path].ts)
                         │
                         ├── shared API/router and domain modules (src/)
                         ├── Turso adapter + versioned SQL migrations
                         ├── selected media adapter (Cloudinary in Vercel source)
                         ├── Resend or mail binding
                         ├── SePay test/webhook and manual-settlement code
                         └── publication/fulfillment/lifecycle jobs

Legacy/alternate execution path: Cloudflare Worker + D1/R2 config (wrangler*.jsonc)
```

- Vercel's API rewrite and the new `api/v1.ts` dispatch the versioned API path; the wrapper forwards to the shared Node adapter. These changes are currently uncommitted. Source tests cover the pure dispatcher, but deployment behavior has not been verified: [vercel.json](../vercel.json), [api/v1.ts](../api/v1.ts), [api/[...path].ts](../api/%5B...path%5D.ts), [tests/vercel-api-routing.test.ts](../tests/vercel-api-routing.test.ts).
- The shared domain router keeps authentication, designs, assets, payments, publications, custom-design and admin logic in separate source modules: [src/index.ts](../src/index.ts).
- Vercel database selection is explicit. Preview takes only `TURSO_STAGING_DATABASE_URL` / `TURSO_STAGING_AUTH_TOKEN`; Production takes only `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`, and source rejects a staging database hostname for Production: [src/platform/vercel.ts](../src/platform/vercel.ts#L480), [src/database/provider.ts](../src/database/provider.ts#L6).
- The Vercel runtime lazily opens and reuses a Turso connection; it does not migrate the database on a request. Foreign-key enforcement is checked: [src/platform/vercel.ts](../src/platform/vercel.ts#L1030), [src/database/turso.ts](../src/database/turso.ts#L88).
- Deployment/project linkage, provider configuration, database schema state, storage durability and all hosted behavior remain **REQUIRES RUNTIME VALIDATION**.

## 4. Folder and file-structure assessment

| Area | Assessment |
|---|---|
| `api/` | Vercel Node function adapters and cron routes; required for deployment, not dead code. |
| `src/` | Shared API/domain, payment, storage, platform and database code; generally separated by responsibility. |
| `templates/` | Five independently rendered experiences. Some pages keep substantial CSS/JS inline; others split assets into modules. Preserve each template's isolation. |
| `shared/` | Cross-template customer-editor and publication-bootstrap code; used by all five. |
| `migrations/` | Ordered schema history 0001–0023, including payment evidence, fulfillment, storage, uploads and custom-design changes. |
| `tests/` | Unit and local integration coverage. Some tests use in-memory libSQL; other fixtures use local Wrangler. The full suite was not run. |
| `scripts/` | Local migration, staging diagnostics, smoke and maintenance utilities. Review each script's side effects before execution; staging scripts were not run. |
| `docs/` | 19 general documents and 56 QA/remediation reports. The history is useful, but older snapshots and overlapping status documents can conflict with current source. |
| `css/`, `js/` | Landing-page implementation. `css/style.css` is heavily minified/packed into long lines, making review and maintenance harder. |
| `wrangler*.jsonc` | Legacy/alternate Worker + D1/R2 configuration remains alongside Vercel/Turso. Docs identify Cloudflare as rollback/legacy; retain until migration/rollback is formally retired. |

No folder move or renaming is needed to launch. The main structural maintenance pressure is file size: payment, publication and Vercel runtime logic are concentrated in large modules; template code is inconsistent between inline and separate assets. Split only behind tests and only where a clear responsibility boundary exists.

## 5. Code usage and cleanup candidates

No file is classified **CONFIRMED_UNUSED** from this source-only audit. Direct import search alone is not sufficient for browser pages, runtime routes, Vercel rewrites, templates, migration history or deployment configuration.

| Candidate | Classification | Evidence and cleanup decision |
|---|---|---|
| `api/v1.ts` | REQUIRED (untracked change) | `vercel.json` rewrites `/api/v1/:path*` to this function; retain and verify with a deployed routing smoke test before release. |
| `api/[...path].ts` | REQUIRED | Shared Vercel HTTP adapter, referenced by `api/v1.ts` and the cron route. |
| `src/database/d1.ts`, `src/index.ts`, `wrangler*.jsonc` | LEGACY_BUT_REQUIRED | Cloudflare Worker/rollback and local D1 paths still use shared code; not safe to delete based on Vercel being the preferred host. |
| `migrations/*.sql` | REQUIRED | Ordered history is consumed by migration tooling and must be retained for schema reconstruction. |
| Staging, smoke and migration scripts | UNKNOWN individually | Some can connect to remote services or mutate databases. Do not remove or run without examining the exact script and explicit approval. |
| Any CSS selector, image, font or Three.js fallback | UNKNOWN | Dynamic/inline usage, CDN fallback and publication rendering prevent safe unused-asset conclusions from import search alone. |
| `docs/qa/*` | LEGACY_BUT_REQUIRED / historical record | Large set of dated audit/remediation reports. Archive/deletion needs a documentation-retention decision and link/reference search. |

### Dependencies

No dependency is **CONFIRMED_UNUSED**. The manifest dependencies have source references: `@libsql/client` for Turso; `qrcode-generator` for publication QR generation. Development dependencies support type checking, Node types, Cloudflare Worker types and Wrangler. No package install, removal, or network vulnerability scan was performed. Version/CVE status needs a separate approved dependency audit.

### Duplication and maintainability

- Template upload, photo-caption, theme, animation and editor-adapter patterns repeat across template modules. Some duplication is intentional to preserve template independence; do not merge template scenes or globalize their CSS/JS.
- The root stylesheet is densely minified, and some template scenes live in `index.html`. This is a **P2 maintainability** candidate, not an immediate launch blocker.
- API routing and runtime behavior are covered by source tests, but no current Vercel deployment was exercised. The pre-existing API rewrite change should remain separate from any broad refactor.

## 6. Product, template and customer-journey status

| Feature | Status | Source evidence / limit |
|---|---|---|
| Homepage and five cards | PARTIAL | Five direct template links and template filters/modal exist in [index.html](../index.html#L80); navigation is source-wired, but no browser run was performed. |
| Catalog and pricing | PARTIAL | Server-defined VND prices: base template 59,000 VND, first month included, extra months 10,000 VND/month, Lifetime 199,000 VND: [src/product-catalog.ts](../src/product-catalog.ts#L3). Catalog is shown even where checkout is disabled. |
| Our Universe | PARTIAL | Editor, recipient view, saved design, preview, upload, personalization, and publication bootstrap are wired in [templates/our-universe/index.html](../templates/our-universe/index.html#L83). Most scene/editor logic is inline. No current device/browser run. |
| Love Letter | PARTIAL | 3D letter, personalization, four-photo handling, shared editor adapter, and schema v1/v2 support are in [templates/love-letter/index.html](../templates/love-letter/index.html#L84). Three.js and application logic are external/inline as shown in the page; no runtime verification. |
| Our Memories | PARTIAL | Separate HTML/CSS/JS; chapter/photo editor, serialization/hydration, 2D fallback, and upload flow are present: [templates/our-memories/index.html](../templates/our-memories/index.html#L70), [templates/our-memories/our-memories.js](../templates/our-memories/our-memories.js#L126). Schema uses three chapters and up to twelve photos. |
| Say Yes | PARTIAL | Separate HTML/CSS/JS, personal fields, interactive proposal, six-photo editor and customer adapter: [templates/say-yes/index.html](../templates/say-yes/index.html#L85), [templates/say-yes/say-yes.js](../templates/say-yes/say-yes.js#L137). No runtime verification. |
| Distance Means Nothing | PARTIAL | Modular `core.js`, `DistanceScene.js`, and `app.js`; time zones, city/distance, messages, memories, responsive tabs and fallback are present: [templates/distance-means-nothing/index.html](../templates/distance-means-nothing/index.html#L12), [templates/distance-means-nothing/app.js](../templates/distance-means-nothing/app.js#L74). No photo upload; no runtime verification. |
| Template validation | READY in source | Schema/version checks and safe public payload mapping exist for all five: [src/template-registry.ts](../src/template-registry.ts#L1). The distance data's internal `templateId: "distance"` differs intentionally from its registry ID `distance-means-nothing`; the editor and validator agree on this, so it is not classified as a defect. |
| Customer input propagation | PARTIAL | Each template registers `serialize`/`hydrate`; the shared editor persists drafts and hydrates server data: [shared/customer-editor.js](../shared/customer-editor.js#L150), template adapters cited above. End-to-end hosted persistence is unverified. |
| Authentication | PARTIAL | Short-lived one-use magic links, hashed tokens, session cookies, CSRF/origin checks, owner-scoped queries and login rate limits are implemented: [src/auth.ts](../src/auth.ts#L265), [src/auth.ts](../src/auth.ts#L347). Email configuration/delivery and hosted behavior are unverified. |
| Preview and checkout | PARTIAL | Customer preview and checkout navigation exist. Order creation recalculates server-side pricing, uses idempotency, and snapshots design/assets: [src/payments.ts](../src/payments.ts#L327), [checkout/checkout.js](../checkout/checkout.js#L356). Production order creation is disabled. |
| Orders and delivery | BLOCKER | Local/Preview code includes payment and fulfillment paths, but Production order creation, webhook settlement and publication are disabled; real delivery cannot complete. |
| Admin/custom design | PARTIAL | Email allowlist + authenticated session + CSRF protect admin endpoints; request review and manual settlement code exist: [src/admin.ts](../src/admin.ts#L96), [src/admin.ts](../src/admin.ts#L481). Custom-design inquiry/review exists, but quoted deposit/balance payment and automated custom fulfillment are not complete. |

### Customer journey

```text
Homepage → select template → personalize → preview
  → authenticate → persist draft/revision → checkout request
  → [Production order creation disabled]
  → signed/verified payment (test/manual paths only)
  → durable fulfillment job → publication snapshot → public URL
  → customer websites dashboard / expiry / renewal
```

The design-to-draft-to-preview path is implemented in source. The payment-to-publication steps are locally/test-gated or Preview-opt-in; Production checkout and public publication writes are closed. Expiration, renewal, unpublish/revoke and customer website management code exists, but requires deployed runtime verification.

## 7. Payment and SePay status

### Implemented in source

- Environment policy explicitly sets Production `mode: null`, `orderCreationEnabled: false`, `sepayWebhookEnabled: false`; Production fulfillment is enabled only for recovery of eligible existing jobs: [src/payments/policy.ts](../src/payments/policy.ts#L22).
- SePay Test-mode QR/instructions and references are generated from configured account settings. The webhook parser authenticates the exact raw body with HMAC-SHA256 and timestamp freshness, rejects stale/future events, and compares signatures in constant time: [src/payments/sepay.ts](../src/payments/sepay.ts#L35).
- Webhook checks include incoming transfer, configured receiving account, exact payment reference, VND, exact amount, pending/unexpired order, duplicate event and provider transaction uniqueness: [src/payments.ts](../src/payments.ts#L935), [src/payments.ts](../src/payments.ts#L1298).
- Verified settlement evidence, payment/order state changes, webhook result and fulfillment job insertion are performed through a durable database batch; conflicting or unmatched events enter manual review: [src/payments.ts](../src/payments.ts#L1010), [migrations/0015_payment_settlement_evidence.sql](../migrations/0015_payment_settlement_evidence.sql#L1).
- Preview and local behavior is fail-closed and separately scoped. Production does not receive Preview payment variables in the Vercel adapter.

### Missing / incomplete

- SePay Live checkout/settlement is not implemented or verified. The current payment adapter is `sepay-test` and policy blocks Production.
- No refund initiation/recording workflow, customer refund policy, or support runbook for charged-but-undelivered orders.
- SePay API v2 reconciliation stores observations but does not authorize settlement; no Production reconciliation scheduler is configured. A protected Preview operator route is source-only and not deployed/verified.
- Provider webhook retry/acknowledgment behavior, Live signature semantics, business account details, fees, payout delays and disputes require official provider/account validation. No real transfer or SePay API was accessed.
- Database uniqueness and conditional state transitions provide idempotency in source; concurrency/retry behavior has not been rerun in this audit.

### State model

```text
Order:   DRAFT → AWAITING_PAYMENT → PAID → FULFILLING → FULFILLED
                       ├→ EXPIRED / CANCELLED / review-required
                       └→ (refund states exist in schema; workflow is missing)

Payment: PENDING → SUCCEEDED
            ├→ FAILED / CANCELLED / review-required
            └→ (refund states exist in schema; workflow is missing)

Fulfillment job: PENDING → PROCESSING → COMPLETED
                              ├→ FAILED → retry with backoff
                              └→ MANUAL_REVIEW after retry limit
```

The order/payment table constraints and later migrations expand this state model. `MANUAL_REVIEW` is represented through review flags/event outcomes rather than a base payment/order enum state.

## 8. Publication, storage and database

### Publication and hosting

- Publication eligibility rechecks customer/design/order consistency, payment state, amount/currency, verified settlement evidence, template/schema/renderer and explicit photo consent: [src/publications.ts](../src/publications.ts#L177).
- Publication stores an immutable snapshot and random bearer URL; public reads expose allowlisted content and consented assets. Links are bearer secrets and should be treated as public once shared: [src/publications.ts](../src/publications.ts#L265), [docs/PUBLICATION_AND_DELIVERY.md](templates/PUBLICATION_AND_DELIVERY.md#L1).
- Fulfillment uses a durable unique job per order, leases/fencing tokens, bounded retries and manual-review exhaustion: [src/publications.ts](../src/publications.ts#L1907), [migrations/0006_storage_entitlements.sql](../migrations/0006_storage_entitlements.sql#L59), [migrations/0009_fulfillment_recovery_leases.sql](../migrations/0009_fulfillment_recovery_leases.sql#L1).
- Hosting duration and renewal snapshots are computed from the server catalog; lifecycle code expires, renews and retains publications. Vercel Production has a daily lifecycle Cron in source; Preview has an operator-triggered path, not a configured Cron: [vercel.json](../vercel.json#L140), [src/platform/vercel.ts](../src/platform/vercel.ts#L980).
- Production publication mutations are disabled: [src/publications.ts](../src/publications.ts#L133). The fulfilled state is therefore not a Production-ready deliverable today.

### Database

- The schema has customer, design/revision, asset, order/item, payment, webhook, settlement evidence, publication, storage entitlement, fulfillment job, audit and custom-design entities: [migrations/0001_initial_schema.sql](../migrations/0001_initial_schema.sql#L8).
- Migration history is numbered 0001–0023; the migration runner enforces consecutive versions, checks applied checksums, uses write transactions and performs a foreign-key check: [docs/MIGRATION_MANIFEST.md](MIGRATION_MANIFEST.md#L1), [src/database/migrations.ts](../src/database/migrations.ts#L30).
- Production/Preview credential-name separation and host checks are implemented in source; actual environment values and remote schema compatibility were not inspected or tested.
- **Backup/restore:** no restore rehearsal or operational backup/recovery evidence was verified. Define backup frequency, retention, access controls, RPO/RTO, restore owner and a tested restore procedure before taking paid orders.
- No migration, seed, database write, or remote/local database connection was made during this audit.

## 9. Security and reliability findings

The following are source findings from the audit baseline, not a penetration test. No confirmed SQL injection, customer ownership bypass or client-controlled payment state was found in the inspected paths. Owner scoping, CSRF, parameterized SQL, schema validation, bounded JSON/image input, explicit media consent and evidence-gated publication are positive controls.

| # | Severity | File | Lines | Vulnerability | Confidence |
|---|----------|------|-------|---------------|------------|
| 1 | 🟠 HIGH | `src/assets.ts`, `src/storage/r2.ts`, `src/storage/cloudinary.ts` | 19-61; 443-510; 48-64; 148-190 | Server accepts JPEG/PNG based on signature/dimensions but does not strip EXIF; publication derivative is copied/uploaded without server-side metadata normalization. A direct API client can bypass the canvas re-encoding used by the normal editor and publish embedded location/device metadata with a consented photo. | 8/10 |
| 2 | 🟡 MEDIUM | `src/assets.ts`, `src/designs.ts` | 79-165; 711-733 | Upload count is capped per design, but no customer-wide upload/storage quota or upload/design-write rate limit was identified. A logged-in account can create many drafts/uploads and consume storage/database resources. | 9/10 |
| 3 | ⚪ LOW | `templates/our-universe/index.html`, `templates/love-letter/index.html`, `templates/our-memories/index.html`, `templates/say-yes/index.html`, `templates/distance-means-nothing/index.html` | 84; 87; 69; 85; 12 | Templates load Three.js from third-party CDNs without Subresource Integrity. CSP constrains allowed CDN URLs/versions but does not verify fetched bytes; CDN compromise or a compromised allowed asset could execute code in the page origin. | 8/10 |

**Post-audit remediation:** These three baseline findings have been addressed in source. Privacy-oriented PNG/JPEG metadata is stripped before private storage and publication while image color/profile chunks are preserved; customer storage and upload/design-write request limits are enforced; Three.js CDN resources are pinned with SRI and the affected CSP hashes were synchronized. Focused local validation passed (`npm run typecheck` and 95 tests across sanitizer, storage, CSP and publication coverage). Browser/CDN runtime behavior remains unverified, and Production payment/publication policy gates remain unchanged.

### Other security controls / open work

- Customer and admin routes require authenticated sessions; admin routes additionally check `ADMIN_EMAILS` allowlisting and CSRF on mutations: [src/admin.ts](../src/admin.ts#L96), [src/admin.ts](../src/admin.ts#L127).
- Uploads are owner-bound, use short-lived hashed capabilities, constrain bytes/dimensions and validate image signatures. The follow-up adds a 64 MiB active-asset quota per customer and upload/design-write limits; content moderation and malware scanning remain unimplemented: [src/assets.ts](../src/assets.ts#L19), [src/assets.ts](../src/assets.ts#L79).
- Vercel and Cloudflare security headers/CSP are configured in source, including frame restrictions and no-sniff. Deployed header coverage and browser CSP compatibility are not verified: [vercel.json](../vercel.json#L14).
- Raw webhook payloads persist account/transaction details for processing and review. Establish access/retention policy and alerts before Production.
- No WAF/abuse limits, general per-customer API throttles, alerting/incident response, dependency vulnerability scan, external security review, or tested restore evidence was verified.
- `docs/SECURITY_PLAN.md:86` still says admin/payment protections are not implemented, conflicting with current admin/session/payment source. This is a documentation accuracy issue; update only after the owner approves a documentation pass.

## 10. Deployment, operations and environment checklist

### Source-defined Vercel variables (names only)

Actual values were not read. Validate each variable in the correct Vercel environment using the platform dashboard; do not copy between Preview and Production.

| Purpose | Current source names |
|---|---|
| Runtime classification/origin | `VERCEL_ENV`, `ENVIRONMENT`, `APP_ORIGIN` |
| Production Turso | `DATABASE_PROVIDER`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` |
| Production storage | `STORAGE_PROVIDER`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `CLOUDINARY_PRODUCTION_CLOUD_NAME` |
| Production email | `MAIL_PROVIDER`, `MAIL_API_KEY`, `MAIL_FROM_EMAIL` |
| Admin access | `ADMIN_EMAILS` |
| Cron/retention | `CRON_SECRET`, `DATA_RETENTION_DAYS` |
| Preview-only examples, never Production fallbacks | `TURSO_STAGING_DATABASE_URL`, `TURSO_STAGING_AUTH_TOKEN`, `PREVIEW_CUSTOMER_FLOW_ENABLED`, `PREVIEW_AUTH_ALLOWED_EMAILS`, `PREVIEW_PAYMENT_MODE`, `PREVIEW_SEPAY_WEBHOOK_SECRET`, `PREVIEW_SEPAY_BANK_CODE`, `PREVIEW_SEPAY_BANK_ACCOUNT`, `PREVIEW_SEPAY_ACCOUNT_NAME`, `PREVIEW_MAIL_PROVIDER`, `PREVIEW_MAIL_API_KEY`, `PREVIEW_MAIL_FROM_EMAIL`, `STAGING_LIFECYCLE_SECRET` |

Production `SEPAY_WEBHOOK_SECRET`, `SEPAY_BANK_CODE`, and `SEPAY_BANK_ACCOUNT` appearing in the general type/interface are **not a Live-enable switch**: current Vercel mapping does not pass them into the Production payment runtime and Production policy disables order/webhook operations. Do not configure or use them as a workaround.

### Operational readiness

- Vercel API function limit: 60 seconds; Vercel Cron configured once daily at `03:00 UTC` (10:00 Vietnam time). Actual deployment, invocation and plan eligibility are **REQUIRES RUNTIME VALIDATION**.
- Email sender, Turso, Cloudinary, admin allowlist, environment origin, cron auth and schema state are unverified.
- Support workflow, refund/dispute handling, payment reconciliation ownership, alerting, backup/restore, incident response and manual fulfillment SLA are missing or incomplete.
- The application has safe structured logging helpers, but operational dashboards/alerts and log-retention configuration were not verified.
- Root docs include older Cloudflare deployment instructions explicitly marked legacy; do not execute those commands as part of this audit.

## 11. Business readiness

| Area | Status | Reason |
|---|---|---|
| Product presentation and five templates | PARTIAL | Source has five distinct experiences and a dynamic catalog; deployed behavior and accessibility/mobile QA are unverified. |
| Pricing | PARTIAL | Source defines clear VND prices and hosting terms, but tax/invoice, payment fees and commercial plan economics are not documented/approved. |
| Checkout | BLOCKER | Production order creation is disabled; no real checkout or order acceptance path. |
| Payment | BLOCKER | SePay Live and Production webhook processing are not enabled or verified. |
| Fulfillment/publication | BLOCKER | Production publication mutations are disabled; URLs cannot be delivered through an enabled Production flow. |
| Legal/privacy/refund | MISSING | No linked Terms of Service, Privacy Policy or Refund/Cancellation Policy found in homepage/footer or checkout. Checkbox only confirms content and hosting term, not agreement to linked terms: [index.html](../index.html#L146), [checkout/index.html](../checkout/index.html#L49). |
| Customer support | PARTIAL | A support email is displayed; homepage itself says mailbox operation must be verified: [index.html](../index.html#L137). No support queue, SLA or refund/dispute workflow verified. |
| Custom design | PARTIAL | Inquiry and admin review/reply paths exist; quote acceptance, deposit/balance payments and deliverables are not a complete automated flow. |
| Operations / recovery | MISSING | No verified backup restore, monitoring/alerts, Production reconciliation or on-call/runbook evidence. |

## 12. Critical blockers before real payment

1. **Production money flow is disabled** — order creation and SePay webhook settlement are false in the Production policy.
2. **Production delivery is disabled** — publication mutation gate allows only local tests or opted-in staging.
3. **Live SePay is not implemented/verified** — current source path is test mode; webhook/account behavior, reconciliation and settlement operations require provider validation.
4. **No approved customer legal terms** — Terms, privacy/retention and refund/cancellation policy are missing; photo-publication consent and data handling need clear wording.
5. **No operational safety net is verified** — refund/support process, payment reconciliation owner, backup/restore, alerts, failure recovery and Production hosting/provider configuration remain unverified.
6. **Photo privacy and abuse controls — remediated in source after this audit:** server-side metadata stripping and customer-level storage/request limits are implemented and covered by focused local tests. Content moderation and malware scanning remain open considerations before broad uploads.

## 13. Proposed target folder structure (no moves made)

Keep the current project shape unless a later implementation phase identifies a concrete need:

```text
api/                    # Vercel entry points and scheduled routes
src/
  auth/                 # optional future split only if it reduces real coupling
  payments/             # provider/policy/reconciliation
  database/             # adapters and migration runner
  storage/              # storage providers and policies
  platform/             # Vercel/Worker environment adapters
  *.ts                  # current domain route modules
templates/
  <template-id>/         # isolated page, style and scene/editor assets
shared/                 # customer editor and publication bootstrap
migrations/             # immutable numbered SQL history
tests/
scripts/
docs/
  qa/                   # historical audit/verification records
```

This is a destination guideline, not a request to create empty folders or force abstractions. Keep the existing five template implementations independent. No folder currently needs to be moved just to satisfy the launch.

## 14. Proposed deletion and refactoring list

### Deletion

**No deletion approved. No `CONFIRMED_UNUSED` file or dependency is proposed.**

The following require owner decision and additional evidence before any removal:

| Candidate | Status | Why not delete now | Verification needed |
|---|---|---|---|
| Older QA reports in `docs/qa/` | UNKNOWN / historical | May contain provenance and prior decisions; other docs can link them. | Search all references, retain an archive index, obtain approval. |
| Cloudflare Worker/D1/R2 configs and scripts | LEGACY_BUT_REQUIRED | Worker and local tests still reference shared code/config. | Confirm no rollback or local development requirement; test Vercel-only release path. |
| Local/ignored artifacts | UNKNOWN | Names exist, contents may contain state or secrets; not inspected. | Separate explicit cleanup review, exclude `.env*`, DBs and provider state unless owner directs. |

### Refactoring (prioritized)

1. Add server-side image normalization/EXIF stripping and verify output before publication.
2. Add per-customer upload/storage quotas and rate limits across design creation, draft saves and upload endpoints.
3. Split large payment/publication/platform modules only after extracting stable, testable boundaries; keep route semantics unchanged.
4. Reformat the minified homepage stylesheet and move very large inline template code only as isolated per-template changes.
5. Reconcile documentation statements in `docs/SECURITY_PLAN.md` and legacy deployment docs against current source.

## 15. Testing and verification record

| Check | Result |
|---|---|
| Source inspection | Completed for homepage, shared editor, all five template entry points/adapters, API/domain modules, migrations, tests/scripts inventory, Vercel/Worker configuration and key docs. |
| `npm run typecheck` | PASS — `tsc --noEmit`, no diagnostics. |
| Unit/integration/browser tests | NOT RUN in this audit. No test result is inferred from historical documentation. |
| Post-audit remediation validation | PASS — `npm run typecheck` and 95 focused local tests; no remote database, provider, browser or deployment access. |
| Remote database, migration, payment, email or deployment | NOT ACCESSED. |
| Browser console/network/mobile device | NOT VERIFIED. |
| Production/Preview environment values and secrets | NOT READ. |
| Git mutations | No stage, commit, push, reset, stash or revert. Existing dirty worktree preserved. |

## 16. Prioritized implementation roadmap

| Priority | Work | Dependency / acceptance |
|---|---|---|
| P0 | Keep Production payment and publication disabled while blockers remain. | Already enforced by policy gates in source; verify deployed environment does not bypass them. |
| P1 | Approve Terms, Privacy/retention and Refund/Cancellation policy; make checkout consent link to the approved wording. | Business/legal owner approval; no database required. |
| P1 | Complete — add metadata stripping, customer storage/request quotas, SRI and focused tests. | Implemented and locally validated without remote database access; browser/CDN runtime still requires a separate check. |
| P1 | Prepare isolated Preview environment and validate Vercel rewrite, email, Turso schema, storage, login, draft, uploads, checkout, SePay Test/manual review and publication on test data. | Explicit approval and provider provisioning required; never use Production credentials. |
| P1 | Build runbooks for “paid, not published”, refund/chargeback, duplicate/mismatched transfer, account/data deletion and manual fulfillment. | Operations and policy decisions. |
| P1 | Configure and rehearse backups/restores, monitoring, alerts and scheduled lifecycle behavior. | Provider configuration and safe isolated runtime validation. |
| P1 | Only after acceptance, implement an explicitly approved Production payment and publication enablement design with reconciliation and rollback controls. | Owner authorization; separate change plan and code review. |
| P2 | Accessibility, external device and real mobile testing; verify CDN/CSP behavior and Three.js dependency integrity. | Browser/device test plan; no database required. |
| P2 | Custom quote/deposit/balance fulfillment and customer support tooling. | Product and pricing approval. |
| P3 | Revenue experiments, referral/analytics, template expansion and internationalization. | Soft-launch evidence and privacy-safe analytics plan. |

## 17. Shortest safe Vietnam soft-launch path

1. **Do not turn on Production today.** Keep current fail-closed Production policy.
2. Complete legal, privacy/retention, photo consent, refund, hosting-duration and support decisions.
3. Configure and verify a strictly isolated Vercel Preview environment, separate staging Turso/storage/email/payment settings, and route/API deployment. No Production fallback is acceptable.
4. Run the five-template customer journey in Preview on synthetic/Test-mode data; test duplicate, stale, partial, excessive, late and unmatched payment events, failed publication, retry and expiry.
5. Validate manual reconciliation, support escalation, backup/restore, alerts, accessibility and physical mobile devices.
6. Review SePay Live onboarding and official webhook specification against the current code. Implement required Live behavior only after that review and explicit authorization.
7. Conduct a small controlled launch only after production checklist approval, with order caps, daily reconciliation, a human operator, and a documented stop/rollback procedure.

## 18. Work that can proceed without touching a database

- Draft/approve legal and customer-facing policy content, support/refund runbooks and pricing copy.
- Completed after the audit: server-side image metadata stripping, customer upload/request quotas, and focused local tests; no remote migration was run.
- Review accessibility, reduced-motion behavior, keyboard flows and mobile layout in an isolated browser.
- Completed after the audit: pinned Three.js SRI and synchronized CSP hashes; browser/CDN runtime behavior remains unverified.
- Reconcile stale documentation and produce a production variable-name checklist.
- Add source-only tests for policy gates, API routing, validation and error states.
- Create a backup/restore plan and acceptance checklist; actual provider restore rehearsal requires a separately approved isolated environment.
- Refactor code formatting or module boundaries only in a separately approved implementation phase.

## 19. Revenue roadmap toward 100,000,000 VND/month

This is arithmetic, not a forecast. It excludes tax, payment fees, refunds, support, hosting, marketing spend and custom-design delivery cost.

| Illustrative average gross order value | Orders/month needed for 100M VND gross sales |
|---:|---:|
| 59,000 VND (standard template + included first month) | 1,695 |
| 100,000 VND (illustrative blended AOV, not currently evidenced) | 1,000 |
| 199,000 VND (Lifetime package) | 503 |

No conversion rate, market size, AOV mix, demand or paid-acquisition economics are verified. Recommended stages:

1. **Validation:** interview users, measure template completion and willingness to pay; manually fulfill only after legal/payment readiness.
2. **Vietnam soft launch:** narrow templates and clear hosting duration; cap orders to support capacity; track payment and delivery failures.
3. **Growth:** use privacy-respecting funnel metrics, referrals and content experiments; compare contribution margin by product/hosting plan.
4. **Scale:** automate reconciliation/support only after sustained reliability; increase capacity and pricing based on measured costs.
5. **International:** validate currencies, taxes, privacy/legal requirements, payment methods, localization and support before selling cross-border.

## 20. Final answers

1. **Can Crushify accept real customer orders today?** **No, not through the verified source flow.** Production order creation is disabled; deployment and customer-facing service status are unverified.
2. **Can it safely accept automated payments today?** **No.** Production SePay webhook settlement is disabled and SePay Live is not implemented/verified.
3. **Top five blockers:** Production payment gate; Production publication gate; unverified SePay Live and hosted environment; missing legal/refund/support terms; missing verified backup/reconciliation/operations.
4. **Shortest safe soft launch:** approve policies → isolated Preview setup → synthetic/Test-mode end-to-end acceptance across all templates → rehearsal of failure/support/restore → explicit Live review → controlled, capped launch.
5. **Can proceed without database access:** legal/docs, accessibility/mobile work, source tests, runbooks and non-invasive code organization. Image sanitation, customer quotas and CDN integrity/CSP hardening were completed in the post-audit follow-up.

**Audit disposition:** this report records the read-only audit baseline. The owner later authorized and received the security remediations summarized above; broader cleanup and Production enablement remain out of scope.

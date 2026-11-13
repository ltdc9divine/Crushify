# Crushify Security Plan

**Status:** target controls plus local-only order/webhook and publication/delivery prototypes. Local synthetic tests cover payment verification and publication access/lifecycle on D1; no provider account, live transaction, production secrets, or production deployment has been used. This is not a security certification. Review with a qualified security/privacy professional before launch.

## 1. Threat model and assets

Protect customer contact details, private drafts/briefs, uploaded originals, preview capabilities, published gift access, orders/payment references, admin credentials and provider secrets. Threats include IDOR, guessed/shared URLs, stolen sessions, malicious uploads, XSS in love-note content, replayed/forged payment webhooks, brute force, denial of service, leaked drafts, admin compromise and third-party CDN compromise.

## 2. Admin authentication and access

- Put admin routes behind Cloudflare Access using a managed identity provider, MFA and allowlisted operator identities.
- Enforce application roles (`support`, `designer`, `finance`, `admin`) and least privilege; Access authentication alone does not replace authorization.
- Step-up MFA/dual review for refunds, manual payment reconciliation, deletion, role changes and unpublishing.
- Short-lived secure sessions, revocation, audit all privileged actions; no shared accounts.
- Secrets only in environment-specific server-side secret stores (currently none are configured for Vercel, Netlify, Turso, Cloudinary or SePay); rotate/revoke and never include in GitHub/browser/logs.

## 3. Customer authentication and authorization

- Start with email magic links/OTP or another verified identity flow; tokens are random, single-use, short-lived, stored only as hashes, rate-limited, and invalidated on use.
- Session cookie: `Secure`, `HttpOnly`, appropriate `SameSite`, narrow scope, expiry and rotation; protect cookie-authenticated writes with CSRF defenses/origin checks.
- Every resource query scopes to authenticated customer ID. Use opaque IDs plus authorization; opaque identifiers are not access control.
- Return indistinguishable `404` for non-owned drafts/orders/assets. Never put raw D1 ID in a public capability URL as the only guard.
- Prevent account enumeration in login/reset responses; throttle by IP and normalized identifier.
- The shared auth boundary enables customer authentication only for the already-classified `local` and `production` runtimes. Vercel Preview (`staging`) and unknown/ambiguous environments reject login-link request/consumption and all session acceptance before database, token, or email side effects; `getSession()` never accepts a Preview cookie. Production and local behavior remain enabled. Preview logout only clears browser cookies without looking up or revoking server-side sessions.

## 4. Preview tokens and public slugs

- Preview token: CSPRNG with at least 128 bits entropy, hash at rest, scope to one design/revision/action, short expiry, revocable, single-purpose; never log it or expose it to referrers/analytics.
- Set preview `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, restrictive referrer policy and avoid third-party scripts on private previews.
- Public slug: random high entropy, non-sequential and unrelated to customer/email/design IDs. Ensure uniqueness at insert; do not derive it from a name, timestamp or counter.
- Public URL is intentionally accessible to anyone who has it; state that link is a bearer secret unless an access code feature is explicitly implemented. Provide revoke/rotate.
- Published routes return only the chosen published content and public renditions. Draft routes must never fall through to public read logic.

## 5. Payment security

- No client-side `PAID` field or “success URL” can grant entitlement. Amount and currency come from catalog/accepted quote on the Worker.
- Verify provider signatures on raw request bytes, timestamps and merchant account; compare amount/currency/reference to the expected local record. Current SePay webhook accepts JSON only, verifies HMAC-SHA256 on exact bytes before strict UTF-8/JSON parsing, checks the ±300-second timestamp, and compares the digest in constant time.
- Idempotency at webhook event and business-operation level; handle duplicate, delayed, replayed and out-of-order events. Unique provider/event and provider/transaction constraints plus atomic D1/libSQL batches protect state changes. A retained `RECEIVED` event is reprocessed on provider retry; an internal bounded recovery function exists but has no scheduled/operator runner yet.
- Separate sandbox/live secrets and endpoints; restrict webhook route/body size, validate provider IP only as supplementary defense, not a substitute for signature validation.
- Prefer hosted checkout. Do not store card data. Restrict finance actions and log reconciliation reason/evidence references without secrets.

## 6. Upload and private media

- Accept only image formats actually required; validate declared type and file signature, decode successfully, constrain dimensions/pixel count/bytes/quantity, strip EXIF/GPS, normalize to safe raster rendition and reject SVG/active formats unless safely transformed.
- Upload into unpredictable private object IDs; never accept a client-chosen bucket key or Cloudinary `public_id`. The R2 adapter preserves legacy key compatibility; the Cloudinary adapter uses signed `authenticated` uploads and server-generated IDs. Keep API secrets server-side. Per-customer quotas, concurrency/rate limits and abandoned-upload lifecycle cleanup remain required.
- Stage in `QUARANTINED`; verify checksum, size, ownership and malware/content policy before `READY`. Consider image scanning/moderation for public content.
- Keep originals private. R2 media is delivered through the authorized Worker proxy. Cloudinary uses authenticated assets and short-lived private download URLs behind the same owner/preview authorization checks; real-account behavior and account feature availability have not been verified. Published renditions are intentionally public and separated.
- CORS allows exact Crushify origins only. Avoid bucket-wide public access; do not treat CORS as authorization.
- Vercel API preflight allows only the configured application origin and a fixed method/header set; credentialed CORS never uses `*`. Configure `APP_ORIGIN` explicitly, especially when using custom Preview aliases.
- Deletion marks metadata pending before provider deletion and marks it deleted only after success; failed binary deletion remains pending for retry. Uploads attempt binary cleanup if the metadata write fails; failed cleanup is also marked pending. Provider changes require a separate binary migration; there is no automatic cross-provider fallback.

## 7. Application security controls

- Validate all JSON against allowlisted schemas, size limits and safe text rules; output encode by context. Do not insert customer text with `innerHTML`.
- Per-page CSP is configured for the homepage, five templates and publication shell through Cloudflare `_headers`, Vercel `vercel.json`, and the publication Worker response. Policies use inline hashes and exact required font/Three.js sources; local Chrome checks passed with no CSP violations. Vercel Production route responses remain unverified because deployment SSO blocked unauthenticated requests, and the committed configuration has not been deployed.
- Use dependency lock/pinning for backend; audit updates and scan for known vulnerabilities. No CDN `latest` references for production app dependencies.
- Static pages and assets configure `X-Content-Type-Options`, frame restrictions, `Referrer-Policy`, Permissions Policy, and page-appropriate caching. Vercel's HTTPS edge supplied HSTS on the observed SSO redirects; do not add a competing HSTS rule without verifying the deployed HTTPS response. API responses retain their application-level `no-store` and security headers. Generic unmatched Vercel static errors and hosted page responses still require deployment-level verification.
- Rate limit login, draft writes, upload/session creation, preview generation, inquiry, checkout and search. Add CAPTCHA only where risk warrants it.
- Parameterized D1 statements, indexed queries, bounded pagination and safe error responses. No dynamic SQL from customer input.

## 8. Logging, retention and incident handling

- Correlate with request IDs; redact email where feasible, all tokens, cookies, signatures, upload URLs and provider secrets.
- Audit authentication/admin actions, state changes, payment event outcomes and publication/revocation. Restrict logs and set retention.
- Define retention/deletion by data class: abandoned drafts, originals, published assets, brief/contact records, payment evidence and legal/audit records. Do not promise erasure that conflicts with required records; explain exceptions.
- Alert on invalid signature spikes, authorization denials/IDOR patterns, upload failures/quota anomalies, D1/storage-provider errors, webhook backlog, unusual admin actions and cost anomalies.
- Document incident triage, key rotation, payment reconciliation, customer notification, publication revocation and restore procedure.

## 9. Required pre-launch tests

The local Phase 5B regression now includes owner-isolated order reads and creation, independent server pricing, missing/wrong/stale/future HMAC checks, content-type and UTF-8 validation, exact payment matching, over/underpayment and cancelled/expired rejection, duplicate transaction collision, concurrency, and database failure/retry recovery on local D1 and Turso. These are isolated synthetic tests, not an external provider certification or penetration test.

Local responsive browser regression on 2026-11-05 exercised the homepage and five template routes at 1366×768, 1440×900, 390×844, and 375×812 on synthetic/local data. No remote Turso or Cloudinary credentials were configured; these checks do not establish hosted-provider or production security.

IDOR across every entity; preview expiry/revocation; public slug collision; XSS payloads in all template fields/captions; upload MIME/polyglot/oversize/decompression abuse; CSRF; brute-force; webhook bad signature/replay/amount mismatch/duplicate/out-of-order; concurrent coupon/order redemption; stale revision conflict; publication cache leak; backup restore and deletion workflow.

## 10. Phase 2 implementation limits

- Local email testing logs a one-time sign-in link to the Wrangler console. The Resend provider adapter is implemented but has no credentials/sender configured; non-local login fails closed until those are configured. Magic-link tokens are placed in URL fragments, not HTTP query strings.
- The upload URL is a short-lived application capability, not a browser-facing Cloudinary signature or presigned R2 URL. `STORAGE_PROVIDER=r2|cloudinary` selects exactly one adapter and fails closed if its binding/credentials are missing. Cloudinary uses signed authenticated upload requests from the selected API runtime; only mocked adapter tests have run. No Cloudinary credentials/account, actual Cloudinary upload/read/delete, provider compatibility test, or storage migration has been performed.
- The Vercel Node adapter caps image request bodies at 4 MiB, checks JSON/binary body bounds, times out incoming body reads, and rejects unsupported HTTP methods. Vercel functions reuse one Turso connection per warm module instance; failed initializations are retried and credentials never enter the response. A process-local mock storage provider is only accepted for local development with `LOCAL_TEST_MODE=true`; it is not allowed in Preview or Production.
- Local Node HTTP integration tests verify multi-cookie session/CSRF flow, API contract, CORS allow/deny, and safe Turso errors. No hosted Vercel test, real Turso test, or Cloudinary account test has occurred. Vercel Hobby is for personal/non-commercial development only; no payment/checkout is enabled.
- Production R2 bucket, CORS, lifecycle, quotas, abandoned-upload cleanup, image normalization/scanning and operational retry monitoring are not configured. Switching providers does not move existing binaries; a separate migration and reconciliation plan is required. Do not assume changing the provider setting is a safe rollback after writes.
- Session cookies are `Secure` outside explicit local test mode. `ENVIRONMENT=staging` disables local mail mode even if `LOCAL_TEST_MODE` is accidentally set. Preview capabilities are passed in the Authorization header; the browser link carries the token in its fragment. These flows have local integration coverage only.
- No admin authentication, checkout/payment protection, published media, production rate limiting/WAF policy, backup/restore, deletion-retention policy, security assessment, or production secrets/deployment is implemented.

## 11. Staging preparation status

- A dedicated staging D1 database exists in APAC with migrations `0001` and `0002` applied and no customer data. Remote `PRAGMA foreign_key_check` returned no violations.
- `wrangler.staging.jsonc` uses the staging-only Worker/D1/R2 names; the Worker is not deployed. R2 is not enabled on the Cloudflare account, so no bucket has been created and no cloud media test has run.
- No email API key or verified sender identity is configured. The staging checklist is in [STAGING_DEPLOYMENT.md](STAGING_DEPLOYMENT.md). No production resources have been used.

## 12. Database migration stage

- The D1 adapter remains the active Cloudflare Worker database path. The Turso adapter checks/enables foreign-key enforcement and uses parameterized libSQL statements and atomic batches.
- The Turso migration CLI validates migration checksums, applies migrations transactionally, and runs `PRAGMA foreign_key_check`. It refuses an existing application schema without a migration ledger.
- Tests use isolated local Wrangler D1 and local Turso/libSQL databases. The shared API contract covers authentication, design/revision, preview, and asset ownership flows; D1 verifies foreign keys, uniqueness, and rollback after a forced revision-write failure, while Turso adapter tests cover constraints, atomic batch rollback, `RETURNING`, result metadata, and parameter normalization.
- No Turso URL/token was supplied; no remote Turso connection, D1 data export/import, or remote schema change has occurred. The D1 source remains the active Worker database and is not deleted or rewritten.
- `.env.example` contains placeholders only. Do not copy production credentials into checked-in files; configure secrets server-side for each environment.
- A future data transfer must use an encrypted export outside the repository, a reviewed data-classification/transform plan, an isolated destination, row-count and foreign-key reconciliation, and a restore rehearsal. Never copy session, login-token, rate-limit, upload-capability, or preview-capability state without an explicit security/retention decision. See [HOSTING_MIGRATION.md](HOSTING_MIGRATION.md).

## 13. Phase 5 payment limits and controls

- Order and webhook routes fail closed unless the runtime is local, `LOCAL_TEST_MODE=true`, `PAYMENT_MODE=mock|sepay-test`, and a local-only `SEPAY_WEBHOOK_SECRET` is configured. The Vercel adapter does not pass payment mode or secrets from Preview/Production into the shared API.
- The server only reads price from `template_prices`; migration 0003 adds the empty catalog and deliberately seeds no prices. Never activate an assumed price or use test fixtures outside a disposable local database.
- Orders require owner session, CSRF and a request-bound idempotency key. Amount/currency/status fields from the browser are rejected. Order lookup is owner-scoped and non-enumerable.
- SePay callbacks are limited to 64 KiB, authenticate exact raw bytes using HMAC-SHA256 and a ±300-second timestamp, and persist the event before processing. Database uniqueness/conditional updates protect provider transaction idempotency and concurrent retry behavior.
- A payment can become successful only for an incoming transfer with exact payment reference, configured receiving account, exact amount, unique transaction ID, and an unexpired pending order. Unmatched, malformed, mismatched and late events enter manual review; browser redirects cannot change state.
- Raw webhook JSON includes financial account/transaction information. Current prototype has no production retention/access policy, alerting, dead-letter queue, scheduled reconciliation or admin review UI. Do not expose it to customer endpoints or logs.
- Local unit and integration tests use generated per-run HMAC secrets, a synthetic `0000000000` receiving-account fixture, and an artificial VND 50,000 price in isolated databases. No bank transfer or SePay endpoint is contacted by tests.
- No live checkout, published pricing, production entitlement/fulfillment, refund handling, admin reconciliation, or production publication exists. A valid local test payment only changes local order/payment status.

## 14. Phase 6 publication controls and limits

- Publication mutations fail closed unless `LOCAL_TEST_MODE=true` and `ENVIRONMENT` is unset or `local`. This guard is not a substitute for production authorization, operations, or a staged rollout.
- Before publish and on each public content/media read, the service rechecks the owner/design/order chain, paid self-service order, successful payment, matching processed webhook event, amount/currency, active template/schema, and renderer version. The browser cannot supply payment state.
- Public slugs are random bearer capabilities. The implementation stores the slug in D1 so the authenticated owner dashboard can reconstruct its link, and stores a hash for public-route lookup; protect D1 access/backups as sensitive bearer secrets. The public renderer receives allowlisted template data, not customer/design/order identifiers or creator controls. Responses are `no-store` and `noindex`.
- Original uploaded images remain private. A distinct derivative is created only for an explicitly consented asset and served only while the matching publication and consent remain active. Withdrawal, unpublish, revoke, expiry, or design deletion denies access; binary cleanup failures are recorded as pending.
- Lifecycle mutations use expected lifecycle revisions to reject stale/concurrent changes. Design deletion revokes publications and removes derivatives before final archive; source-media cleanup failures leave deletion pending rather than returning success.
- Expiration is checked on public reads; no scheduled expiry/cleanup worker or operator retry interface is configured. Retention, media moderation/scanning, rate limits, alerting, production logging policy, and public-link privacy/support policy remain launch gates.
- Local integration tests use synthetic D1 rows for paid-order evidence. They prove code paths, not real provider settlement, external-device delivery, remote storage behavior, or a production security boundary.

# Crushify API Specification

**Status:** proposed full-product contract. A local-only Our Universe subset is implemented through the shared database contract and the Cloudflare D1 adapter. The Turso adapter is available for database work, but Vercel/Netlify HTTP adapters and production APIs are not configured.
**Base path:** `/api/v1`. JSON over HTTPS. Public gift reads are separate from private customer APIs.

## 1. Common contract

- Require `Content-Type: application/json` for JSON writes, except binary upload routes.
- Require authenticated customer session for all private design/order/project operations. Scope every query by authenticated `customer_id`.
- Require `Idempotency-Key` for create checkout, order, quote acceptance, and other retryable mutation operations.
- Responses include `request_id`; errors use `{ "error": { "code": "...", "message": "...", "fields": {} }, "request_id": "..." }`.
- Stable codes include `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `PAYMENT_PENDING`, `UPLOAD_REJECTED`, and `INTERNAL_ERROR`. Never return provider secrets or stack traces.
- Validate allowed fields, template schema version, maximum lengths/counts and byte-size limits server-side. Ignore/reject client price, paid state, owner ID and role fields.

## 2. Route catalog

| Method / path | Access | Purpose and result |
|---|---|---|
| `GET /catalog/templates` | Public | Active template IDs, published schema/renderer versions and purchasable package display info. |
| `GET /templates/{templateId}/versions/{schemaVersion}` | Public | Defaults/editor metadata permitted for client authoring; no private data. |
| `POST /customers/session` | Public, rate-limited | Request email login link/OTP; generic response prevents account enumeration. |
| `POST /customers/session/verify` | Public, rate-limited | Consume one-time token and create secure session cookie. |
| `DELETE /customers/session` | Customer | Revoke current session. |
| `GET /customers/me` | Customer | Minimal profile and entitlements. |
| `POST /designs` | Customer | Create draft after validating an active template/version; returns opaque design ID and revision. |
| `GET /designs/{designId}` | Owner | Retrieve draft and asset references for the owner only. |
| `PUT /designs/{designId}` | Owner | Save validated JSON with `If-Match`/expected revision; returns incremented revision or `409 CONFLICT`. |
| `POST /designs/{designId}/preview-token` | Owner | Issue short-lived, scoped, high-entropy preview capability. |
| `GET /preview/{token}` | Token | Render an unpublished design; no index/cache, short expiry, revocable. |
| `POST /uploads` | Customer | Create upload session for a private image; returns asset ID and short-lived upload instruction. |
| `PUT /uploads/{assetId}/content` | Upload capability | Receive bytes through Worker, or use a short-lived signed R2 PUT URL if its signing/finalization flow is implemented. |
| `POST /uploads/{assetId}/complete` | Owner | Verify R2 object exists, size/checksum/type and image decode; mark ready or reject. |
| `DELETE /assets/{assetId}` | Owner | Mark deletion pending; asynchronous R2 deletion and audit. |
| `POST /orders` | Customer | Create order from server-selected SKU and design revision; price never comes from client. |
| `POST /orders/{orderId}/checkout` | Owner | Create provider checkout/payment attempt; return provider URL and expiry. |
| `GET /orders/{orderId}` | Owner | Read order/payment summary; never accept state mutation from client. |
| `POST /webhooks/payments/{provider}` | Provider signature | Verify raw-body signature, record unique provider event, idempotently update payment/order/project. |
| `POST /custom-projects` | Customer | Submit inquiry/brief and optional existing design/assets. |
| `GET /custom-projects/{projectId}` | Owner | View own project, current quote, permitted preview and event summary. |
| `POST /custom-projects/{projectId}/quotes/{quoteId}/accept` | Owner | Accept an unexpired issued quote; creates deposit order idempotently. |
| `POST /custom-projects/{projectId}/revisions` | Owner | Request a revision against preview-ready work; enforce quote's included rounds/scope. |
| `GET /g/{slug}` | Public | Render only a published, non-revoked revision with public media. |

### Admin-only API (host identity gateway + application role; currently Cloudflare Access for the Worker)

- `GET /admin/inquiries`, `GET /admin/projects/{id}`: review and queue work.
- `POST /admin/projects/{id}/quotes`: create/issue a versioned quote; record scope and revision count.
- `POST /admin/projects/{id}/transitions`: request a valid audited transition; no arbitrary status assignment.
- `POST /admin/payments/{id}/reconcile`: audited recovery/reconciliation requiring evidence and elevated role; never a public endpoint.
- `POST /admin/publications/{designId}` / `POST /admin/publications/{id}/revoke`: authorize publish/revoke after entitlement checks.
- `POST /admin/assets/{id}/review`: approve/reject quarantined uploads.

Admin handlers validate role, transition, reason, and actor; require step-up/MFA for payment reconciliation, refunds, and publication controls.

## 3. Example payloads

Create draft:

```json
{
  "template_id": "love-letter",
  "schema_version": 1,
  "data": { "from": "Minh", "to": "Linh", "message": "..." }
}
```

Save design:

```json
{
  "expected_revision": 4,
  "schema_version": 1,
  "data": { "from": "Minh", "to": "Linh", "message": "..." },
  "asset_ids": ["opaque-asset-id"]
}
```

Create order:

```json
{
  "sku": "template.standard",
  "design_id": "opaque-design-id",
  "design_revision": 5,
  "coupon_code": "optional"
}
```

No client field for `amount`, `currency` authority, `paid`, `customer_id`, `order.status`, or `role` is accepted.

## 4. Webhook processing contract

1. Read exact raw request bytes; enforce content-size limit.
2. Validate provider signature/timestamp using the provider's official verifier and secret.
3. Parse only after signature validation; insert `(provider,event_id)` under a unique constraint.
4. Compare provider transaction, amount, currency, merchant/account, and expected order/payment reference to server state.
5. Apply an allowed state transition atomically; duplicate event returns success without duplicate fulfillment.
6. Persist a redacted event outcome and enqueue/retry fulfillment separately. Alert on invalid signature, mismatch, repeated processing failure, or reconciliation backlog.

## 5. Pagination, rate and privacy

- Cursor pagination (`created_at,id`) and bounded `limit`; never unbounded collection reads.
- Apply per-IP and per-account throttles to login, design writes, upload creation/finalization, checkout and custom inquiries. Webhook limits are provider-aware.
- Avoid public endpoints for drafts, assets, design IDs, customer lookup, or order lookup.
- Return non-enumerable 404 for resources not owned by the caller.
- Gift route exposes only published content explicitly intended for the recipient; no customer email/order/payment/brief data.

## 6. Compatibility and rollout

Keep the present static pages usable while progressively calling the API. Introduce a browser adapter interface (`loadDraft`, `saveDraft`, `uploadAsset`, `createPreview`, `createCheckout`, `publishStatus`) and retain current local-only behavior until each endpoint is ready. API and template schema versions must be explicit; see [TEMPLATE_ENGINE.md](TEMPLATE_ENGINE.md).

The database adapter refactor does not change the existing Our Universe request/response contract. Cloudflare remains the current HTTP runtime until a separately tested Vercel development adapter is added.

## 7. Current local implementation (Phase 2)

The following routes are implemented for the Our Universe pilot. Local integration tests use Wrangler D1/R2 emulation. The staging D1 has both migrations applied, but no staging Worker or R2 bucket is deployed yet:

| Method / path | Access | Implemented behavior |
|---|---|---|
| `POST /customers/session` | Public, rate-limited | Request a one-time email link; local adapter writes the link to the Wrangler console only. |
| `POST /customers/session/verify` | Public | Consume a hashed, expiring, one-time token and set session/CSRF cookies. |
| `DELETE /customers/session` | Customer + CSRF | Revoke the current session. |
| `GET /customers/me` | Customer | Return minimal account data and CSRF token. |
| `POST /designs` | Customer + CSRF | Create an Our Universe schema-v1 draft. |
| `GET /designs/{designId}` | Owner | Read the private draft. Non-owners receive 404. |
| `PUT /designs/{designId}` | Owner + CSRF | Validate and save the draft using `expected_revision`; stale writes return 409. |
| `DELETE /designs/{designId}` | Owner + CSRF | Start the design deletion workflow and remove its private media. |
| `POST /designs/{designId}/preview` | Owner + CSRF | Create a short-lived, revocable preview capability. |
| `GET /previews` | Preview bearer token | Read the preview; token is sent in the Authorization header. |
| `POST /assets/upload-url` | Customer + CSRF | Create an opaque upload capability for a private image. |
| `PUT /assets/{assetId}/content` | Upload capability | Validate PNG/JPEG signature, dimensions and size, then stream to the configured private storage provider. |
| `POST /assets/{assetId}/complete` | Owner + CSRF | Recheck stored object size, type, digest and dimensions before marking it ready. |
| `GET /assets/{assetId}` | Owner | Read private media through the Worker. |
| `DELETE /assets/{assetId}` | Owner + CSRF | Delete unreferenced private media. |

`GET /previews/assets/{assetId}` serves media only with the preview bearer. The Cloudflare Worker selects exactly one private storage adapter with `STORAGE_PROVIDER=r2|cloudinary`; missing configuration fails closed, with no cross-provider fallback. Local integration coverage exercises the Worker and R2 emulator. Adapter tests mock Cloudinary's signed authenticated upload, bounded private download and deletion; they do not prove compatibility with a real Cloudinary account. Production mail delivery requires a configured provider. Catalog, order, checkout, payment, publication, customer-requested erasure orchestration, and admin routes remain unimplemented. See [SECURITY_PLAN.md](SECURITY_PLAN.md), [STAGING_DEPLOYMENT.md](STAGING_DEPLOYMENT.md), and [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) for deployment gaps.

### Storage adapter contract

Business routes use `Storage` for private binary upload, read, deletion and private URL generation; database asset metadata remains in the selected database adapter. `R2StorageAdapter` keeps the existing private Worker-proxied R2 behavior, including legacy R2 object-key compatibility. `CloudinaryStorageAdapter` creates authenticated (`type=authenticated`) image assets using server-generated public IDs, signed requests and short-lived private download URLs. The Cloudinary API secret stays server-side. The upload API remains Worker-proxied and keeps its current request/response format; it does not expose a direct signed upload URL to the browser.

Cloudinary is selected only when `STORAGE_PROVIDER=cloudinary` and all three server-side values are set: `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`. R2 requires `STORAGE_PROVIDER=r2` and the `MEDIA` binding. Do not switch providers against existing asset rows without a separately planned binary migration: each adapter reads only its own provider's objects, and a config flip is not a data migration. Upload cleanup is attempted if metadata persistence fails; failed cleanup is marked `DELETION_PENDING` for retry. Deletion likewise records pending state before deleting the binary and marks metadata `DELETED` only after successful storage deletion.

### Database adapter compatibility

The routes above call the shared `Database` interface and retain their existing request/response behavior. The same API contract runner exercises auth/session, design/revision conflict, preview, and asset ownership flows on local Wrangler D1 and local Turso/libSQL. The Cloudflare Worker is still the only deployed-style HTTP adapter and remains D1-only; selecting Turso is currently supported by the local adapter test harness, not by a Vercel/Netlify API runtime. See [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md) for the value, batch, and error-mapping contract.

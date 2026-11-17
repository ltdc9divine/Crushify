# Publication and Customer Delivery

**Status:** implemented and integration-tested locally. Source also allows publication mutations in Vercel Preview only behind the complete explicit customer-flow gate and an available storage adapter; Production mutations remain disabled. No Preview or Production deployment is verified by this document.

## 1. Publication flow

```text
Owned design revision
  → eligible paid self-service order
  → publication snapshot + explicit photo consent
  → publish after payment recheck
  → /p/{random-slug} recipient shell
  → template-specific renderer loads safe published data
```

The order/checkout prototype is local-only and is not enabled for real payments. All five template pages have editor adapters and checkout navigation in source. Tests use synthetic order, payment, and processed-webhook rows in disposable local D1. No browser endpoint can set an order or payment to `PAID`, and no real payment provider or live transaction is involved.

## 2. Eligibility and lifecycle

Creating and publishing a publication verifies that the authenticated customer owns the design and matching order; the order is `SELF_SERVICE` and `PAID`; payment is successful, not under review, and matches the order amount/currency; a processed webhook event matches the provider transaction; the order item identifies the same template/schema; and the active template/schema/renderer is supported. Publish and recipient reads repeat the critical checks rather than trusting a previous client-side result.

The publication stores a snapshot of the exact template, schema, renderer, and design revision. Lifecycle transitions carry an expected lifecycle revision so stale mutations fail with a conflict. The implementation supports publish, unpublish, republish, permanent revoke, snapshot update while unpublished, optional expiry, and dashboard listing.

Renewal creation requires the publication's latest storage entitlement to be `ACTIVE` or `EXPIRED`; the order-insertion transaction and fulfillment path repeat the entitlement check. A renewal entitlement is bound to its paid order, publication, and plan so recovery reuses the recorded extension rather than applying it twice. The account dashboard stores an idempotency key in tab-scoped session storage across retries/reloads of the same request, and clears it after a successful response.

Public slugs are random bearer links. D1 stores the slug for the authenticated owner dashboard to reconstruct the recipient URL and stores a hash for public-route lookup; protect D1 and its backups as containing bearer-link secrets. Treat a shared link as public to anyone who receives it. Public responses expose only validated recipient data and safe media paths, not customer identity, draft IDs, order/payment metadata, or private originals.

The bounded lifecycle runner expires publications at the exact UTC boundary (`expires_at <= now`), skips lifetime entitlements (`expires_at = NULL`), and retains content until its configured deletion date. Retention cleanup defers while a valid pending, paid, or fulfilling order exists, claims the design against new checkout before deleting source assets, and retries failed media deletion. It also defers cleanup when a source asset is still referenced by another active or retained publication. A renewal accepted before the retention deadline restores the existing publication and stable slug; a paid renewal after the deadline cannot revive retained data.

## 3. Media consent and deletion

Original uploaded objects remain private. A media item is copied to a publication-specific derivative only when the customer explicitly consents to that asset. The API serves a derivative only while its publication is active, the related payment remains eligible, the source asset is ready, and consent has not been withdrawn.

Unpublish, revoke, expiry, consent withdrawal, and design deletion immediately deny public reads. Derivative/source deletion is tracked in D1; a failed deletion leaves cleanup pending and does not produce a success response for design deletion. The Cloudflare Worker retains a scheduled maintenance handler for rollback, but both Wrangler cron triggers are disabled. The Vercel Production Cron is the sole configured lifecycle schedule. Vercel Preview has no scheduled lifecycle. Its manual `POST /api/ops/staging/publication-lifecycle` requires a Preview-only `STAGING_LIFECYCLE_SECRET` (exactly 64 hexadecimal characters), independently generated from Production secrets; `CRON_SECRET` alone cannot authorize it. The route also requires an available storage adapter and fails closed before database access when storage is unavailable. Preview storage is configuration-gated and its remote availability is unverified. Local synthetic tests cover the route's fail-closed behavior and the unchanged local lifecycle retry/cleanup behavior; no deployed scheduler or manual lifecycle execution was verified.

When retention cleanup or customer-requested design deletion fails, the customer website list keeps the retained design visible with a cleanup-pending state. A draft with no protected financial/publication history can be retried by its owner; physical cleanup checkpoints each successfully removed source asset and archives/clears the draft only after cleanup completes. It is blocked while an order or fulfillment is in progress and while another active or retained publication references one of its assets.

A customer deletion request for a design with a paid/refunded order, publication, or storage entitlement is a soft deletion: active publication access is removed, publication derivatives are cleaned up with retryable state, and the original design data, source media, entitlement history, and payment/order ledger remain intact. The entitlement and payment state are not revoked or rewritten. Finite hosting continues to expire at its persisted UTC expiry and enters the normal retention lifecycle; lifetime hosting is never time-expired. The request does not issue a refund or permanently erase protected data. The owner must approve a refund policy and any longer-term erasure/retention policy before adding those actions.

## 4. Routes and UI

- `POST /api/v1/publications`: create from an eligible order/revision and consent list.
- `GET /api/v1/publications`: owner-scoped list for the websites dashboard.
- `GET /api/v1/publications/{publicationId}`: owner-scoped status.
- `PATCH /api/v1/publications/{publicationId}`: update an unpublished snapshot.
- `POST /api/v1/publications/{publicationId}/publish|republish|unpublish|revoke`: lifecycle actions.
- `POST /api/v1/publications/{publicationId}/assets/{assetId}/consent`: withdraw media consent.
- `POST /api/v1/orders`: create an owner-scoped initial or storage-renewal order with server-calculated pricing and idempotency.
- `GET /api/v1/orders/{orderId}/status`: inspect the authenticated customer's order and fulfillment state.
- `DELETE /api/v1/designs/{designId}`: owner/CSRF-protected design deletion; pending cleanup is retryable from the account dashboard.
- `GET /api/v1/publications/{slug}` and `/assets/{assetId}`: recipient data and consented derivative.
- `GET /p/{slug}`: static recipient shell.
- `/account/websites/`: customer dashboard with consent selection and lifecycle actions.
- `POST /api/ops/staging/publication-lifecycle`: Preview-only operator lifecycle trigger; not a customer or generic database-mutation API.

Publication mutations are enabled for local test mode or for Vercel Preview only when `ENVIRONMENT=staging` and `PREVIEW_CUSTOMER_FLOW_ENABLED=true`; they also require an available storage adapter. Production and other runtimes remain disabled. The customer dashboard and source gate are not evidence that a remote publishing service is configured or enabled.

## 5. Template integration boundary

All five templates have schema-v1 server validators, safe public-data conversion, and renderer-version mappings. Each existing template page loads the shared publication bootstrap but retains its own CSS, JavaScript, and scene. The bootstrap fetches current publication data before hydrating the page; it does not trust stale browser session state.

All five template editors are connected in source to customer authentication, owner-scoped draft save/reload, private preview, and checkout navigation. Our Universe has its own adapter; Love Letter, Our Memories, Say Yes, and Distance Means Nothing register adapters with the shared customer-editor module. Photo-capable editors also serialize private media through the shared asset APIs. This is source-level capability, not evidence that a Vercel Preview is configured or that the customer journey has been remotely deployed and verified. Publication and checkout remain independently gated by runtime policy.

## 6. Verification and remaining work

Local integration covers synthetic paid-order eligibility, owner isolation, publication creation, publish/unpublish/republish/revoke, lifecycle revision sequencing, snapshot updates, photo consent and withdrawal, public derivative access, design-deletion cleanup, and dashboard listing. Tests exercise Cloudflare local D1/R2; they do not prove remote Cloudflare behavior.

The local browser check returned 200 for the homepage and all five template paths at desktop and mobile viewport sizes, with no horizontal overflow or JavaScript page errors. Representative editor/scene controls were exercised. Unauthenticated editor sessions issue the expected `GET /api/v1/customers/me` 401 before showing sign-in. Our Universe's cold 3D initialization kept its loading overlay over controls for multiple seconds in the tested browser; it cleared after the scene initialized, but load-time performance should be measured and improved before launch.

Still required before staging/commercial delivery:

- Verify the five editor adapters end-to-end against the isolated Preview runtime; local source wiring does not prove deployment-level authentication, media, or browser behavior.
- Configure and validate isolated staging D1/R2 and deploy a staging Worker; no remote resource was used for this implementation.
- Test external-device delivery, real storage, expiry/retry operations, security headers/logging, accessibility, reduced motion, and physical mobile devices.
- Approve terms, privacy/retention, support, custom-service scope/pricing, and payment-provider operations. Standard-template prices are defined in `src/product-catalog.ts`; no production checkout or publication should be enabled before the remaining gates pass.

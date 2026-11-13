# Publication and Customer Delivery

**Status:** implemented and integration-tested in local Worker/D1/R2 mode only. Publication mutations are deliberately disabled outside local test mode. This document does not record a staging or production deployment.

## 1. Publication flow

```text
Owned design revision
  → eligible paid self-service order
  → publication snapshot + explicit photo consent
  → publish after payment recheck
  → /p/{random-slug} recipient shell
  → template-specific renderer loads safe published data
```

The current order/checkout prototype is limited to Our Universe and is local-only. Tests use synthetic order, payment, and processed-webhook rows in disposable local D1. No browser endpoint can set an order or payment to `PAID`, and no real payment provider or live transaction is involved.

## 2. Eligibility and lifecycle

Creating and publishing a publication verifies that the authenticated customer owns the design and matching order; the order is `SELF_SERVICE` and `PAID`; payment is successful, not under review, and matches the order amount/currency; a processed webhook event matches the provider transaction; the order item identifies the same template/schema; and the active template/schema/renderer is supported. Publish and recipient reads repeat the critical checks rather than trusting a previous client-side result.

The publication stores a snapshot of the exact template, schema, renderer, and design revision. Lifecycle transitions carry an expected lifecycle revision so stale mutations fail with a conflict. The implementation supports publish, unpublish, republish, permanent revoke, snapshot update while unpublished, optional expiry, and dashboard listing.

Public slugs are random bearer links. D1 stores the slug for the authenticated owner dashboard to reconstruct the recipient URL and stores a hash for public-route lookup; protect D1 and its backups as containing bearer-link secrets. Treat a shared link as public to anyone who receives it. Public responses expose only validated recipient data and safe media paths, not customer identity, draft IDs, order/payment metadata, or private originals.

The bounded lifecycle runner expires publications at the exact UTC boundary (`expires_at <= now`), skips lifetime entitlements (`expires_at = NULL`), and retains content until its configured deletion date. Retention cleanup defers while a valid pending, paid, or fulfilling order exists, claims the design against new checkout before deleting source assets, and retries failed media deletion. It also defers cleanup when a source asset is still referenced by another active or retained publication. A renewal accepted before the retention deadline restores the existing publication and stable slug; a paid renewal after the deadline cannot revive retained data.

## 3. Media consent and deletion

Original uploaded objects remain private. A media item is copied to a publication-specific derivative only when the customer explicitly consents to that asset. The API serves a derivative only while its publication is active, the related payment remains eligible, the source asset is ready, and consent has not been withdrawn.

Unpublish, revoke, expiry, consent withdrawal, and design deletion immediately deny public reads. Derivative/source deletion is tracked in D1; a failed deletion leaves cleanup pending and does not produce a success response for design deletion. The Cloudflare Worker retains a scheduled maintenance handler for rollback, but both Wrangler cron triggers are disabled. The Vercel Production Cron is the sole configured lifecycle schedule. Vercel Preview has no scheduled lifecycle. Its manual `POST /api/ops/staging/publication-lifecycle` requires a Preview-only `STAGING_LIFECYCLE_SECRET` (exactly 64 hexadecimal characters), independently generated from Production secrets; `CRON_SECRET` alone cannot authorize it. Although authorization remains isolated, the route returns `STORAGE_UNAVAILABLE` before database access because Preview has no approved durable media provider, so it performs no lifecycle mutation. Preview durable storage is unavailable until a separate staging provider is approved and configured. Local synthetic tests cover the route's fail-closed behavior and the unchanged local lifecycle retry/cleanup behavior; no deployed scheduler or manual lifecycle execution was verified.

## 4. Routes and UI

- `POST /api/v1/publications`: create from an eligible order/revision and consent list.
- `GET /api/v1/publications`: owner-scoped list for the websites dashboard.
- `GET /api/v1/publications/{publicationId}`: owner-scoped status.
- `PATCH /api/v1/publications/{publicationId}`: update an unpublished snapshot.
- `POST /api/v1/publications/{publicationId}/publish|republish|unpublish|revoke`: lifecycle actions.
- `POST /api/v1/publications/{publicationId}/assets/{assetId}/consent`: withdraw media consent.
- `GET /api/v1/publications/{slug}` and `/assets/{assetId}`: recipient data and consented derivative.
- `GET /p/{slug}`: static recipient shell.
- `/account/websites/`: customer dashboard with consent selection and lifecycle actions.
- `POST /api/ops/staging/publication-lifecycle`: Preview-only operator lifecycle trigger; not a customer or generic database-mutation API.

All publication mutations require `LOCAL_TEST_MODE=true` and an unset or `local` `ENVIRONMENT`. Otherwise the API returns `PUBLICATION_DISABLED`. The customer dashboard is not evidence that a remote publishing service is enabled.

## 5. Template integration boundary

All five templates have schema-v1 server validators, safe public-data conversion, and renderer-version mappings. Each existing template page loads the shared publication bootstrap but retains its own CSS, JavaScript, and scene. The bootstrap fetches current publication data before hydrating the page; it does not trust stale browser session state.

Only Our Universe currently uses server-backed customer authentication, draft save/reload, private image upload, and bearer preview. The other four editors still rely on their existing browser-side authoring/persistence flows; their editor changes and photos are not saved to these APIs. Recipient rendering support must not be presented as complete commerce-ready creator support.

## 6. Verification and remaining work

Local integration covers synthetic paid-order eligibility, owner isolation, publication creation, publish/unpublish/republish/revoke, lifecycle revision sequencing, snapshot updates, photo consent and withdrawal, public derivative access, design-deletion cleanup, and dashboard listing. Tests exercise Cloudflare local D1/R2; they do not prove remote Cloudflare behavior.

The local browser check returned 200 for the homepage and all five template paths at desktop and mobile viewport sizes, with no horizontal overflow or JavaScript page errors. Representative editor/scene controls were exercised. Unauthenticated editor sessions issue the expected `GET /api/v1/customers/me` 401 before showing sign-in. Our Universe's cold 3D initialization kept its loading overlay over controls for multiple seconds in the tested browser; it cleared after the scene initialized, but load-time performance should be measured and improved before launch.

Still required before staging/commercial delivery:

- Connect all four remaining editors to server-backed save/reload, uploads, and preview.
- Configure and validate isolated staging D1/R2 and deploy a staging Worker; no remote resource was used for this implementation.
- Test external-device delivery, real storage, expiry/retry operations, security headers/logging, accessibility, reduced motion, and physical mobile devices.
- Approve product pricing, terms, privacy/retention, support, and payment-provider operations. No production checkout or publication should be enabled before these gates pass.

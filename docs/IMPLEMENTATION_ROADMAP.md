# Crushify Implementation Roadmap

**Status:** migration sequence in progress. The Cloudflare Worker/D1/R2 Our Universe foundation remains active and is integration-tested locally. A shared database contract, D1 adapter, Turso/libSQL adapter and guarded migration CLI are implemented and tested locally; no remote Turso migration or data transfer has occurred. Estimates assume one experienced full-stack engineer with product/design decisions available. Production capability is not configured.

## 1. Priority before launch

1. Resolve policy/business decisions: market/legal entity, approved VND pricing, refunds/cancellation, privacy/retention, terms, publication duration, custom-service scope and support.
2. Fix product claims and paths: homepage prices/CTA currently are provisional and not connected to checkout; make this explicit until live.
3. Keep the existing Cloudflare backend available for rollback; verify migration/backup plans before moving any remote data.
4. Implement the Turso database adapter/migrations, then host adapters and storage adapters as separate tested stages before storing real customer data there.
5. Implement durable drafts/assets/recipient delivery before checkout; then payment and fulfillment.
6. Add custom-service workflow atop shared customer/order/payment/asset services.

## 2. Proposed sprint plan

### Sprint 0 — Product decisions and release baseline (1 week)

- Approve catalog/prices/entitlements, support/refund/retention policy, custom scope/quote definitions and launch market.
- Baseline current five templates with desktop/mobile/reduced-motion fixtures and route checks.
- Select Cloudflare account/domain, GitHub repository permissions, email and candidate payment provider; validate provider account eligibility.
- Deliver: signed-off product decisions, risk register, fixture inventory, environments plan.

### Sprint 1 — Platform foundation (1–2 weeks)

- Add TypeScript Worker/API skeleton, Wrangler config, environment bindings, CI checks and reviewed staging deploy.
- Configure separate staging/production D1 and private/public R2 buckets; secrets and Access admin gate.
- Implement structured errors/request IDs, safe logging, health checks, rate-limit strategy and initial schema migrations.
- Deliver: staging-only Worker/static homepage, migration/rollback procedure, automated smoke test.

**Progress:** the repository now has a TypeScript Worker skeleton, local Wrangler/D1 configuration, initial numbered schema migration, liveness/readiness routes and unit checks. Staging/production resources, secrets, Cloudflare Access, CI and remote smoke deployment are not configured; Sprint 1 is in progress, not complete.

**Database migration progress:** D1-specific code is now behind a small database interface; the Cloudflare D1 adapter preserves the existing runtime, while the Turso/libSQL adapter and checksum-checked migration runner reuse the immutable SQLite migrations. Local libSQL tests cover repeat application, checksum drift, foreign keys and rejection of an untracked existing schema. No remote resource has been contacted or changed.

### Sprint 2 — Identity and durable drafts (1–2 weeks)

- Local Our Universe pilot: customer magic-link/session lifecycle, owner-scoped draft CRUD, schema validation and optimistic revision conflict handling are implemented.
- Still needed: production email service, account lifecycle/privacy, catalog/template registry and server schema mapping for the other four apps.
- Implement restore/save status and account deletion request foundations.
- Our Universe is the first adapter pilot; four other templates remain unconnected. No checkout.

### Sprint 3 — Assets and private preview (1–2 weeks)

- Local Our Universe upload authorization/finalization, PNG/JPEG checks, private R2-compatible access/deletion, and expiring preview tokens are implemented and integration-tested.
- Still needed: production bucket, image decode/normalization and scanning policy, quotas/cleanup operations, adaptation of other photo templates, security review, renderer version pinning, and production device/browser QA.

### Sprint 4 — Publication and template rollout (1–2 weeks)

- Implement publish/revoke by immutable design revision and random slug, public media renditions and cache policy.
- Integrate shared adapter into remaining four templates without unifying their UI/CSS/3D scenes.
- Compatibility fixtures for old schema/renderer; privacy and slug enumeration tests.
- Deliver: end-to-end draft → preview → publish on staging, still no real checkout.

### Sprint 5 — Checkout/payment (1–2 weeks plus provider onboarding)

- Provider adapter, server-priced catalog/SKUs, order snapshots, hosted checkout, signed webhooks, idempotency, reconciliation/refund paths.
- Test sandbox duplicates/replay/timeout/out-of-order/amount mismatch and fulfillment retry.
- Turn on a limited private beta only after finance, support, terms and operational alerts are ready.

### Sprint 6 — Custom design workflow (1–2 weeks)

- Inquiry/brief, admin queue, immutable quote versions, acceptance, deposit/balance orders, revision counters, preview/approval, delivery and project event timeline.
- Role-gated admin UX or restricted admin APIs; begin with manual human review.
- Test transition guards and deposit/balance accounting.

### Sprint 7 — Commercial hardening and launch (1–2 weeks)

- Load/cost tests, D1 query/index review, restore and deletion drills, accessibility, mobile physical device coverage, browser compatibility, provider payout/reconciliation test.
- Security review/penetration test proportionate to risk, incident/support runbook, privacy/legal review, staged rollout/rollback.
- Enable public purchase CTA only after launch checklist owner signoff.

## 3. Work estimates and dependencies

Foundational code through a staging self-service flow is roughly 6–10 engineering weeks; production launch plus custom workflow roughly 9–15 engineering weeks for one engineer, excluding waiting on provider accounts, legal work, copy/design, and external review. A team can parallelize frontend adapters, but schema/payment/publication decisions are dependencies, not safe parallel guesses.

## 4. Definition of done per module

- Unit and integration tests for validation, owner authorization and state transitions.
- Browser test for desktop/mobile and at least one reduced-motion path for all five renderers.
- Database migration is forward-only, checksummed and has recovery instructions; validate foreign keys and restore from backup before any remote migration.
- No secret in source or build artifacts; staging/production resources are distinct.
- Logs/alerts, documented support behavior, cost metric and rollback plan exist.
- No payment or publish state depends on client-provided success.

## 5. Rollout/rollback

- Use staging with synthetic data; production rollout behind server-side feature flags by template/market.
- Deploy backward-compatible schema expansion before new code; deploy readers/writers; backfill; contract only in a later migration.
- Keep previous Worker and renderer bundles available for rollback. Do not roll back by deleting D1/R2 objects.
- Disable checkout or publication independently if incidents arise; maintain customer support and payment reconciliation.

## 6. Current commercial readiness verdict

Current project is a **static catalog plus a local-only backend prototype**. Our Universe now has locally tested authentication, durable D1 drafts, private media and preview; the other four templates remain on their prior client-side flows. Nothing is commerce-ready: production identity/storage, paid entitlement, checkout/payment, durable publication, admin operations, privacy/retention, and production deployment/recovery are absent. Do not accept real orders until the relevant roadmap gates pass.

## 7. Cost and quota monitoring

Indicative Cloudflare list-price snapshot checked 2026-11-04; prices/limits can change and account/region/tax conditions apply:

- Workers Paid has a **$5 USD/month minimum account charge**; Standard includes 10 million dynamic requests/month and 30 million CPU milliseconds, then listed overage rates apply. Static asset requests are listed as free/unlimited when served as assets; Worker invocations/caching behavior differ. Keep API routes separate from static assets.
- D1 on Workers Paid lists the first 25 billion rows read/month, 50 million rows written/month and 5 GB storage included, with overage pricing beyond those amounts. Unindexed scans increase rows-read billing; check query metrics.
- R2 Standard lists 10 GB-month, 1 million Class A ops and 10 million Class B ops/month free, then $0.015/GB-month, $4.50/million Class A and $0.36/million Class B; internet egress is listed free. Image transformations, operation mix, lifecycle, and third-party services still have costs.
- Dynamic billing only is not the whole launch budget: domain, transactional email, payment provider processing/settlement/refunds, accounting/tax, support, monitoring and any image scanning/service costs are separate.
- Budget monitoring must alert on Worker invocations/CPU, D1 reads/writes/storage, R2 stored bytes/operations, email volume, payment fees and abnormal upload traffic. Keep per-account/customer quotas to bound abuse.

Official references (verify before procurement): [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/). Pricing snapshot is indicative, not a quote or total monthly forecast.

## 8. Database abstraction phase 1B

Business services now depend on the provider-neutral database interface; D1 types remain at the Cloudflare Worker boundary and in the D1 adapter. Local test evidence covers the shared API flows on D1 and Turso/libSQL plus Turso adapter constraints, atomic rollback, result metadata, and parameter handling. The Worker still runs on D1; Turso is not connected to a Vercel/Netlify runtime.

**Still required before any data migration or host cutover:** implement and review a data importer, rehearse encrypted backup/restore, validate a non-production target with real export/import, add the target host's HTTP adapter, and perform separately authorized remote checks. No remote database has been connected, and no data has been migrated. See [HOSTING_MIGRATION.md](HOSTING_MIGRATION.md) for the gated runbook.

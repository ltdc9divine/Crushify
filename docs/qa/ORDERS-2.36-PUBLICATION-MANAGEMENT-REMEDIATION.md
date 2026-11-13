# ORDERS-2.36 — Publication Management & Lifecycle Operations Remediation

**Verdict: PARTIAL — REMOTE VERIFICATION REQUIRED**

This report records local source-code and synthetic-database verification only. It is not a Production-readiness approval.

## Initial Git baseline

- Branch: `main`, tracking `origin/main`.
- HEAD: `4f4aaa354893309dd8ed325882bfa461058aa9d3`.
- Staged changes: none.
- Before ORDERS-2.36 edits: 9 modified tracked files and 2 untracked files, all preserved from ORDERS-2.35:
  - Modified: `docs/DATABASE_SCHEMA.md`, `docs/PAYMENT_FLOW.md`, `src/index.ts`, `src/logging.ts`, `src/publications.ts`, `tests/database-contract.test.ts`, `tests/database.test.ts`, `tests/payment-contract.mjs`, `tests/vercel.test.ts`.
  - Untracked: `docs/qa/ORDERS-2.35-FULFILLMENT-RECOVERY-REMEDIATION.md`, `migrations/0009_fulfillment_recovery_leases.sql`.
- The ORDERS-2.33, ORDERS-2.34, and ORDERS-2.35 reports and the publication, payment, entitlement, scheduler, authentication, UI, and lifecycle implementations were reviewed before editing.

## Existing capabilities and verified defects

The existing implementation already had server-side customer ownership checks, authenticated order status, signed payment webhook processing, server-calculated renewal pricing, order idempotency, persisted fulfillment retries with leases, exact UTC expiry comparisons, lifetime exclusion, shared-asset retention, and cleanup retry states. The 2.35 recovery changes were preserved.

Verified defects addressed:

1. Renewal order creation could proceed when the publication had no current renewable entitlement or its latest entitlement was in an ineligible state.
2. Fulfillment did not independently verify the prior entitlement before creating a renewal entitlement, and a pre-existing renewal entitlement was not checked against the order's publication and plan.
3. Retention cleanup could archive a design after a media failure while removing it from the customer's website list.
4. Customer design deletion could begin while an order was pending or still being fulfilled; a partial source-media failure also left successfully deleted objects uncheckpointed, and the deletion path did not revoke storage entitlements.
5. The dashboard generated a new renewal idempotency key on each click, so retrying the same request could create a second order.

No evidence justified changing approved prices, adding a migration, enabling Production checkout/publication mutations, or changing the scheduler configuration.

## Route and authorization inventory

| Operation | Route / method | Authentication and ownership | Environment gate and mutations | Payment, cleanup, and idempotency |
|---|---|---|---|---|
| List customer websites and entitlements | `GET /api/v1/publications` | Customer session; database queries are scoped to the session customer. | Read-only; no local-publication mutation gate. | Returns each owned publication, entitlement history, and cleanup-pending visibility. No mutation idempotency applies. |
| Inspect a publication | `GET /api/v1/publications/{publicationId}` | Customer session; owner-scoped publication lookup. | `requireLocalPublishing` blocks this route outside local test mode. | Read-only. Foreign-owner lookup returns not found. |
| Create, publish, unpublish, revoke, update snapshot, or withdraw consent | `POST /api/v1/publications`, `POST /api/v1/publications/{id}/{publish|republish|unpublish|revoke}`, `PATCH /api/v1/publications/{id}`, `POST /api/v1/publications/{id}/assets/{assetId}/consent` | Customer session, CSRF, server-side owner checks, and expected revision checks. | Publication creation and ID-based management remain local-test-only. No gate was bypassed. | Creation rechecks paid-order evidence and consent; mutations update publication/design/consent rows. Cleanup failures are reported and retryable; revision checks reject stale replays. |
| Publicly read a published website or derivative | `GET /api/v1/publications/{slug}`, `GET /api/v1/publications/{slug}/assets/{assetId}`, `GET /p/{slug}` | Intentionally public bearer-link reads, not customer-management routes. | Existing public-read eligibility checks remain unchanged. | Requires eligible paid-order evidence, active publication and consent; derivatives are publication-specific. No payment state is changed. |
| Create initial or renewal order | `POST /api/v1/orders` | Customer session and CSRF; the server scopes design/publication to the authenticated customer. | Existing payment-environment policy controls whether order creation is enabled. | Prices are server-calculated; idempotency key and request fingerprint are persisted. Renewal now requires the latest entitlement to be `ACTIVE` or `EXPIRED`, checked both before insertion and in the insertion transaction. |
| Inspect order | `GET /api/v1/orders/{orderId}/status` | Customer session and owner-scoped order lookup. | Existing payment policy remains in force. | Read-only; returns fulfillment/payment state without allowing the customer to set it. |
| Settle payment and fulfill/renew | `POST /api/v1/payments/sepay/webhook`; internal fulfillment recovery | Webhook requires verified provider signature and matching processed payment evidence; recovery is system/scheduler-driven. | Existing payment and fulfillment environment gates are unchanged. | Fulfillment rechecks payment evidence. Renewal reuses an entitlement already written for that order and now checks its publication/plan association. Durable fulfillment job/lease state supports retries without a second publication or a second extension. |
| Delete a design and its publications/media | `DELETE /api/v1/designs/{designId}` | Customer session, CSRF, and owner-scoped design lookup. | Existing customer design route; it is not gated by `requireLocalPublishing`, and this task did not introduce or change a Production gate. | Now blocks while an unexpired awaiting-payment order or a paid/fulfilling order exists. Revokes publications and applicable entitlements, checkpoints each deleted source asset, preserves payment records, and leaves a retryable `DELETION_PENDING` state on media failure. |
| Delete a private asset | `DELETE /api/v1/assets/{assetId}` | Customer session, CSRF, owner-scoped asset lookup. | Existing asset route; requires configured storage. | Rejects referenced design/publication assets; uses `DELETION_PENDING` on storage failure and returns success for an already deleted object. |
| Expire and retain publications | Internal `runPublicationLifecycle`; Vercel `GET /api/cron/publication-lifecycle`; legacy Worker scheduled handler | Cron bearer authorization on Vercel; Worker handler is not customer-accessible. | Vercel Cron is Production-only and validates environment/database/storage. Worker scheduled execution requires explicit Production scope; Wrangler Cron triggers remain disabled. | Uses persisted UTC expiry (`expires_at <= now`), excludes lifetime entitlements, defers for in-flight orders/shared assets, and records cleanup retry state. Repeated lifecycle runs are idempotent. |
| Manually trigger staging lifecycle | `POST /api/ops/staging/publication-lifecycle` | Preview-only operator bearer secret; not a customer route. | Validates Preview scope and staging database configuration. It currently returns `STORAGE_UNAVAILABLE` before database access because Preview durable storage is not configured. | No lifecycle mutation was attempted in this task. |
| Recover failed cleanup or fulfillment | Owner retry via `DELETE /api/v1/designs/{id}` for design deletion; scheduler/recovery workers for retention and fulfillment | Owner route remains owner/CSRF-scoped; system recovery is not customer-controlled. | Existing lifecycle/payment gates remain unchanged. | Failed design cleanup is now visible in the account list and can be retried. Retention cleanup and fulfillment continue through their existing durable retry/lease mechanisms. |

There is no customer route to directly set expiry or alter payment settlement. An expired publication can be renewed through the paid renewal path; the existing renewal fulfillment behavior restores the same publication identity/URL. Lifetime publications remain outside ordinary expiry. Customer actions do not directly run scheduled expiration or retention cleanup.

## Changes implemented

- **Renewal entitlement eligibility:** the latest publication entitlement must be `ACTIVE` or `EXPIRED`; the order-insertion transaction repeats this check. Fulfillment refuses to create a new renewal entitlement without an eligible prior entitlement and validates an existing renewal entitlement against the order's publication and plan.
- **Renewal retry safety:** the customer dashboard reuses a tab-scoped session-storage idempotency key for retries/reloads with the same publication and plan/duration, clearing it only after a successful response. Dashboard event lookup now identifies the exact publication row.
- **Cleanup inspectability:** archived designs whose expired/revoked publication still has retention cleanup pending, and designs in `DELETION_PENDING`, remain visible to their owner. Cleanup-pending cards do not expose stale photos, editor, or publication actions; deletion-pending cards expose only the owner retry action.
- **Design deletion safety:** the state transition is conditional on there being no unexpired awaiting-payment, paid, or fulfilling order. Entitlements are revoked without changing orders/payments. Each source asset is marked deleted immediately after its storage deletion succeeds; publication snapshots are cleared after all media cleanup succeeds.
- **Existing behavior preserved:** approved prices, Production checkout/fulfillment/publication gates, scheduler triggers, webhook settlement logic, and environment configuration were not changed.

## Files changed for ORDERS-2.36

- `src/payments.ts`
- `src/publications.ts` (also contained preserved ORDERS-2.35 edits)
- `src/designs.ts`
- `account/websites/websites.js`
- `tests/payment-contract.mjs` (also contained preserved ORDERS-2.35 edits)
- `tests/publications.test.ts`
- `tests/integration.mjs`
- `tests/vercel.test.ts` (also contained preserved ORDERS-2.35 edits)
- `docs/PUBLICATION_AND_DELIVERY.md`
- `docs/qa/ORDERS-2.36-PUBLICATION-MANAGEMENT-REMEDIATION.md`

No migration was added. The existing untracked `migrations/0009_fulfillment_recovery_leases.sql` is ORDERS-2.35 work and was preserved; it was not run against a remote database.

## Verification

All tests use synthetic records/local adapters:

- `node --experimental-strip-types --test tests/publications.test.ts tests/vercel.test.ts` — **PASS**, 19 tests, 0 failures (focused run).
- `npm test` — **PASS**, 143 tests, 0 failures, 0 skipped.
- `npm run test:integration` — **PASS**, local Wrangler/D1 integration: “D1 API and payment contracts, legacy regression, constraints, and batch rollback.”
- `npm run typecheck` — **PASS** (`tsc --noEmit`).
- `node --check account/websites/websites.js` — **PASS**.
- `node --check tests/payment-contract.mjs` — **PASS**.
- `node --check tests/integration.mjs` — **PASS**.
- `git diff --check` — **PASS**.

The integration suite initially exposed a synthetic paid-but-not-fulfilled order in its design-deletion case. The test fixture was corrected to represent a completed order before asserting deletion; the final local integration run passed. No test was weakened to obtain a pass.

## Tests and operations intentionally not run

- No remote migration, provider preflight, deployment, promotion, cron trigger, or production/staging route invocation.
- No Production database/storage access, real SePay call/transaction, email delivery, customer notification, or publication/expiration/deletion against a remote service.
- No full browser-driven UI test; the account script received a JavaScript syntax check, while API/persistence behavior was exercised through local unit/integration suites.

## Remaining risks and remote verification requirements

- Vercel Preview/Production, legacy Worker, Turso, and Cloudinary resource identity and deployed behavior remain unverified. Local tests do not prove remote isolation.
- Publication create/detail/mutation routes remain local-test-only. Do not bypass these existing gates to make Production management appear functional; any future enablement needs a separately approved policy and remote verification.
- Preview lifecycle remains non-operational until isolated durable staging storage is separately approved and configured. No remote resource configuration was attempted.
- The existing authenticated customer `DELETE /api/v1/designs/{id}` route has no local-publication environment gate. This task preserved its existing availability; its Production customer-deletion policy should be explicitly confirmed before relying on it operationally.
- The Production Vercel Cron and legacy Worker scheduled handler were not invoked. No Worker Cron trigger was added or enabled.
- Manual operational procedures for resolving `MANUAL_REVIEW` fulfillment jobs and shared-asset retention conflicts remain operational prerequisites; this task did not add an administrative mutation route.

## Final Git state and safety confirmation

- Branch and HEAD remained `main` / `4f4aaa354893309dd8ed325882bfa461058aa9d3`.
- Final staged changes: none. Final worktree: 15 modified tracked files and 3 untracked files (the two preserved ORDERS-2.35 files plus this report).
- No commit, push, merge, rebase, reset, checkout, clean, stash, deployment, or remote migration was performed.
- All pre-existing ORDERS-2.35 modifications and untracked files were preserved.
- No Production or remote provider operation was performed.
- Verdict remains **PARTIAL — REMOTE VERIFICATION REQUIRED**; local tests alone do not establish Production readiness.

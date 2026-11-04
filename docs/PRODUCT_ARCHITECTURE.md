# Crushify Product & System Architecture

**Status:** design proposal; no backend or payment code is implemented.
**Audit basis:** repository contents and local browser checks on 2026-11-04.
**Decision boundary:** this design does not select a payment provider, set production prices, or claim legal/compliance approval.

## 1. Product scope

Crushify offers two products over one commerce core:

1. **Self-service template:** template → editor → preview → checkout → verified payment → publish.
2. **Custom Design Service:** inquiry/brief → human review and quote → deposit → development → preview/revisions → approval → balance payment → delivery.

Both use the same customer identity, design/assets, order/payment ledger, and publication service. Custom work adds project/quote/revision records; it is not a second payment system.

## 2. Audited starting point

At the original audit baseline, the repository was a static HTML/CSS/JavaScript website with five standalone templates and no backend toolchain or deployment configuration. A local-only foundation has since been added: TypeScript Worker entrypoint, Wrangler config, D1 migration, health routes, and basic tests. No Cloudflare staging/production resources, R2 bindings, CI/deployment workflow, customer account, draft API, server-side upload, order service, payment integration, or publishing service is configured or implemented.

The homepage shows sample prices of 39,000/79,000/129,000 VND and links to the template gallery; its own note labels them provisional. It does not create an order or start checkout. The homepage contains a preview-modal shell/handler but has no `.preview-btn` trigger in its current gallery; card links navigate to the templates directly. The previous integration findings are recorded in [PRODUCT-INTEGRATION-AUDIT.md](../PRODUCT-INTEGRATION-AUDIT.md).

## 3. Target topology

```text
Browser (current HTML/CSS/JS + template-specific renderers)
   ├── static GET ───────────────> Cloudflare Workers Static Assets
   └── /api/v1/* ────────────────> TypeScript Cloudflare Worker
                                      ├── D1: customers, designs, orders,
                                      │       payments, projects, audit trail
                                      ├── R2 private: original uploads/drafts
                                      ├── R2 public: optimized published media
                                      ├── payment provider adapter
                                      └── email provider adapter

Payment provider ── signed webhook ──> Worker webhook endpoint
Admin (MFA/Access protected) ─────────> Worker admin API
Published gift URL ───────────────────> Worker public renderer + D1/R2
GitHub ── reviewed CI/deploy ─────────> Cloudflare staging / production
```

### Runtime boundaries

- Keep the present frontend and each template's own CSS, JavaScript, and 3D experience. Add only small shared browser modules/adapters when a template opts in.
- Use Workers Static Assets for the homepage, template source files, and versioned static assets. Static assets are not a per-customer HTML publishing database.
- Route `/api/v1/*`, authenticated preview routes, payment webhooks, and gift slugs to Worker code. Keep public static routes cacheable independently of API responses.
- Use D1 for metadata and state transitions only. Never put image bytes/base64 in D1.
- Keep original and draft media private in R2. Serve published renditions through an authorization-aware Worker or a deliberately public published-media hostname.
- A published gift uses a high-entropy slug, e.g. `/g/<random-token>`. The public renderer resolves a published design version and its pinned template version. Do not expose a draft or an enumerable D1 ID.

### Environments

Create separate `development`, `staging`, and `production` Worker/D1/R2 resources, credentials, webhook endpoints, and payment-provider modes. Never point local/staging deployments at production customer data or buckets. Production deployment is a reviewed GitHub workflow, not an ad hoc local command.

## 4. Request/data flows

### Self-service

1. Browser obtains public catalog/template metadata and creates an anonymous or email-verified customer session.
2. Browser loads template defaults and edits local data. Draft operations send versioned JSON to the Worker; the server validates against that template's registered schema.
3. Images upload to private R2 through short-lived upload sessions; Worker validates authorization, limits, object key, checksum and finalization.
4. Preview uses the same pinned recipient renderer and a short-lived preview capability, but reads a draft only after authorization. Preview URLs are not gift URLs.
5. Checkout is created server-side from an enabled catalog price and the current design version. Browser-submitted amounts are ignored.
6. Payment confirmation comes only from a verified provider webhook or a documented, audited admin reconciliation. The success/return page is informational.
7. Once paid, Worker atomically finalizes the order, pins immutable design/template versions, assigns a random slug and queues/records publishing. Publish is idempotent and can be retried.

### Custom Design

1. Customer submits a brief and references/uploads assets; status is `BRIEF_SUBMITTED`.
2. Admin reviews scope, risks, deliverables, revision allowance, dates, and price; issues a versioned quote with expiry.
3. Customer accepts the quote; a deposit order/payment is created. Verified deposit changes project to `DEPOSIT_PAID`.
4. Admin records start, preview-ready, revision requests and approvals as explicit transitions with actor/time and revision count.
5. Approval creates or confirms the balance-due order. Verified balance payment enables delivery.
6. Delivery attaches final artifacts/publication reference and moves project to `DELIVERED`.

## 5. Design principles

- Server is authoritative for customer ownership, allowed template/version, quote/order amounts, payment states, access, and publication.
- Data contracts are template-specific and schema-versioned. Never infer a new schema from arbitrary client JSON.
- Published content is immutable/version-pinned; edits create a new draft/revision and republish after entitlement checks.
- Explicit state transitions with audit records; reject invalid transitions instead of silently coercing statuses.
- Keep user-provided copy as text, validate shape/length, and render with safe DOM/text APIs. Never interpolate untrusted content as HTML or script.
- Measure paid Worker requests/CPU, D1 row metrics, R2 storage/operations, image processing, payment fees, email and support costs. See [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md).

## 6. Production gates before launch

- Confirm legal entity, terms, privacy/retention policy, refund/cancellation rules, tax/accounting obligations, provider eligibility and data-location expectations for target markets.
- Confirm actual package prices, discount policy, custom scope and service-level expectations. Current homepage prices are not approved catalog data.
- Select payment and email providers only after account, settlement currency, refund, webhook, fee, and compliance checks.
- Add automated tests, backup/restore drills, monitoring/alerts, rate limits, incident/rollback procedure, accessibility and real-device testing.
- Pin or locally bundle CDN dependencies and document licenses. Test CSP/integrity against the existing inline-script templates before tightening policy.

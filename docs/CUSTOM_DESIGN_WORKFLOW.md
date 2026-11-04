# Custom Design Service Workflow

**Status:** admin-operated v1 workflow design. No project portal, quote or custom-payment backend exists yet.

## 1. State graph

Required customer-facing progression:

```text
INQUIRY
 → BRIEF_SUBMITTED
 → QUOTED
 → DEPOSIT_PAID
 → IN_PROGRESS
 → PREVIEW_READY
 → REVISION_REQUESTED ──> IN_PROGRESS ──> PREVIEW_READY
 → APPROVED
 → BALANCE_DUE
 → DELIVERED
```

Additional terminal/admin states: `QUOTE_EXPIRED`, `ON_HOLD`, and `CANCELLED`. Payment exceptions remain payment/order states with a corresponding project event; they are not a project state. These states must not be used to bypass required payment or approval gates.

## 2. State semantics and guards

| State | Owner/action | Required evidence/guard | Next allowed states |
|---|---|---|---|
| `INQUIRY` | Customer submits contact and request | Rate-limited, validated contact/consent, inquiry ID | `BRIEF_SUBMITTED`, `CANCELLED` |
| `BRIEF_SUBMITTED` | Customer confirms complete brief; admin reviews | Scope, references, budget/timing constraints and asset rights captured | `QUOTED`, `CANCELLED`, `ON_HOLD` |
| `QUOTED` | Admin issues immutable quote version; customer accepts | Scope/deliverables/exclusions, currency, total, deposit, balance, revisions, due date, quote expiry; acceptance recorded | `DEPOSIT_PAID` only after verified deposit; new quote version if changes |
| `DEPOSIT_PAID` | System after provider webhook; admin starts work | Exact deposit payment success and quote version match | `IN_PROGRESS`, `ON_HOLD`, `CANCELLED` only under policy |
| `IN_PROGRESS` | Admin/design team | Work notes/task evidence; no work beyond scope without approved change quote | `PREVIEW_READY`, `ON_HOLD` |
| `PREVIEW_READY` | Admin releases scoped preview | Preview capability is private/expiring; revision allowance and deadline shown | `REVISION_REQUESTED`, `APPROVED`, `IN_PROGRESS` |
| `REVISION_REQUESTED` | Customer requests changes | Request tied to preview revision; count within quote allowance or additional quote accepted | `IN_PROGRESS`, `ON_HOLD` |
| `APPROVED` | Customer approves final preview | Explicit approval of exact immutable revision and scope | `BALANCE_DUE` |
| `BALANCE_DUE` | System creates balance order | Amount equals accepted quote total minus verified deposit/refunds/credits | `DELIVERED` only after verified balance and ready deliverables |
| `DELIVERED` | System/admin completes delivery | Balance paid, final URL/files recorded, recipient/publication checked | Terminal; later corrections follow support/revision policy |

All changes create an append-only `custom_project_events` row (actor, prior/new state, timestamp, request ID, redacted note). Reject invalid transitions at API and database/service layer; no admin “set arbitrary status” form.

## 3. Brief and quote contents

### Brief

- Customer/contact reference and consent.
- Desired template or custom platform/behavior, story/content fields, audience and privacy intent.
- Required pages/features, integrations, asset/photo/music references and ownership/permission confirmation.
- Supported device/browser expectations, accessibility needs, languages.
- Desired delivery date, budget range, dependencies and approval contact.
- Explicitly no passwords, payment-card information, or unrelated sensitive data.

### Quote

- Immutable quote version, validity/expiry and customer acceptance timestamp.
- Itemized deliverables, exact in-scope features, exclusions, assumptions/dependencies and acceptance criteria.
- Total currency/amount; deposit amount/percentage; balance amount and payment conditions.
- Included revision rounds with definition of a round, turnaround expectations and out-of-scope change process.
- Schedule estimates, delivery format/hosting/ownership, maintenance/support limits, cancellation/refund policy and any recurring charges.
- Quote edits create a new version; never silently mutate an accepted quote.

## 4. Revision accounting

- A revision round is a consolidated, scope-conforming customer request against one preview version; admin records request and response.
- Update `used_revision_rounds` once per accepted request, idempotent on request ID. Keep content of request only as long as needed for service/retention.
- If request exceeds included rounds or scope, pause the relevant work and issue a change quote. Do not start/charge extra work without acceptance.
- Publish only the exact revision the customer approved. Later modifications create a new version/approval.

## 5. Initial manual operation

1. Inquiry can begin from a form that creates a project and sends notification; a human reviews and contacts the customer.
2. Admin checks brief, assets, scope and capacity, then issues quote from a reviewed template.
3. Customer accepts online. System creates deposit order and hosted payment; no manual “paid” checkbox visible to customer.
4. Admin performs design/build manually and uploads a private preview.
5. Customer submits revision request or approval in project portal/email confirmation recorded by admin. Require authenticated confirmation for approval.
6. System creates balance checkout; after verified payment, admin/system releases final delivery and publication.

Manual work does not mean manual payment state. If accepting offline transfer, define a restricted audited reconciliation process and verify funds independently.

## 6. Data model linkage

- `custom_projects.customer_id` links customer; optional `design_id` links a template-based/custom renderer data set.
- `custom_quotes(project_id, version)` stores immutable quote versions.
- `orders` use `CUSTOM_DEPOSIT` and `CUSTOM_BALANCE`; `order_items` snapshot quote/amount.
- `payments` and webhook events use the same provider integration as self-service.
- Project events/audit logs record transitions; assets remain in the common R2 flow.

## 7. Operational metrics

Track inquiry response time, quote acceptance/expiry, deposit-to-start delay, preview-to-approval time, included/excess revision frequency, unpaid balances, delivery lead time, cancellations/refunds and support cases. Use aggregate reporting; restrict access to customer briefs.

# ORDERS-2.39 — Independent Publication Deletion Safety Audit

**Audit type:** Read-only local source and test audit
**Verdict: FAIL — a deletion/upload race can leave private source media attached to an archived design.**
**Remote/Production status:** NOT VERIFIED

## 1. Executive summary

The ORDERS-2.38 remediation materially improves deletion safety: authenticated owner-scoped deletion, CSRF/origin validation, protected payment and fulfillment history, paid-site unpublishing, entitlement preservation, shared-publication asset checks, and retryable storage cleanup are present.

However, deletion does not fence concurrent upload registration or later upload stages. `createUpload` checks that the design is `DRAFT`, then inserts an asset and upload session without rechecking that state. `deleteDesign` can claim and archive the design during that gap. The upload content and completion handlers do not require the design to remain `DRAFT`. This allows an upload to survive or finish after deletion has started, leaving media and an asset row on an archived design. Existing tests do not exercise this interleaving.

No source, test, migration, or configuration files were changed for this audit. The only intended addition is this report.

## 2. Git baseline and final state

Baseline captured before audit inspection:

- Repository: `C:\Users\ltdc9\OneDrive\Desktop\crushify`
- Branch: `main` (tracking `origin/main`)
- HEAD: `4f4aaa354893309dd8ed325882bfa461058aa9d3`
- Staged changes: none
- Existing worktree: 18 modified tracked files and 5 untracked files

Baseline tracked modifications:

- `_headers`
- `account/websites/websites.js`
- `docs/DATABASE_SCHEMA.md`
- `docs/PAYMENT_FLOW.md`
- `docs/PUBLICATION_AND_DELIVERY.md`
- `src/designs.ts`
- `src/index.ts`
- `src/logging.ts`
- `src/payments.ts`
- `src/publications.ts`
- `templates/our-universe/index.html`
- `tests/database-contract.test.ts`
- `tests/database.test.ts`
- `tests/integration.mjs`
- `tests/payment-contract.mjs`
- `tests/publications.test.ts`
- `tests/vercel.test.ts`
- `vercel.json`

Baseline untracked files:

- `docs/qa/ORDERS-2.35-FULFILLMENT-RECOVERY-REMEDIATION.md`
- `docs/qa/ORDERS-2.36-PUBLICATION-MANAGEMENT-REMEDIATION.md`
- `docs/qa/ORDERS-2.37-FINAL-PRODUCTION-READINESS-AUDIT.md`
- `docs/qa/ORDERS-2.38-PUBLICATION-DELETION-ENTITLEMENT-SAFETY-REMEDIATION.md`
- `migrations/0009_fulfillment_recovery_leases.sql`

The existing changes were preserved. The audit does not claim they are all from ORDERS-2.38; the remediation report identifies its files as `src/designs.ts`, `src/publications.ts`, `account/websites/websites.js`, `templates/our-universe/index.html`, `tests/publications.test.ts`, `tests/integration.mjs`, `_headers`, `vercel.json`, `docs/PUBLICATION_AND_DELIVERY.md`, and its own report.

At audit completion, the same 18 tracked files remain modified and the same 5 untracked files remain present, plus this new report. No files were staged. HEAD and branch are unchanged.

## 3. Findings

### HIGH — Upload registration and completion are not fenced by deletion

**Affected code:** `createUpload`, `uploadContent`, and `completeUpload` in [`src/assets.ts`](../../src/assets.ts); `deleteDesign` in [`src/designs.ts`](../../src/designs.ts).

`createUpload` reads the design with `status = 'DRAFT'` before checking asset count. Its later batch inserts into `assets` and `asset_upload_sessions` without a conditional `EXISTS` check for the design still being `DRAFT` and without an atomic design-state claim. Meanwhile, `deleteDesign` transitions the design to `DELETION_PENDING` and marks only assets that already exist in its transaction as `DELETION_PENDING`; it subsequently reads and deletes the asset list, then archives the design.

Concrete interleaving:

1. An upload request passes the `DRAFT` lookup in `createUpload`.
2. Deletion claims `DELETION_PENDING` and updates the then-existing assets.
3. The upload inserts its asset/session after that transaction. The new asset is still `PENDING`.
4. If insertion precedes deletion's asset scan, deletion may delete the key but its DB update changes only `DELETION_PENDING` assets; the new `PENDING` row is not transitioned to `DELETED`. If insertion follows the scan, it is omitted from cleanup entirely.
5. `uploadContent` checks the upload capability, expiry, and asset `PENDING` state but not the design state. It may store the object and move the asset to `QUARANTINED`. `completeUpload` may then move it to `READY` without checking the design state.
6. The design can be `ARCHIVED` while a private source object and usable asset record remain.

This is a lifecycle/data-integrity defect; the audited path does not establish cross-customer access. It nevertheless violates the deletion and cleanup contract and can retain data the customer requested be removed.

**Existing test coverage:** deletion retry and paid-site retention are covered by `tests/publications.test.ts` (including “physically deletes an unpaid draft idempotently and keeps cleanup retryable” and “soft-deletes a paid website…”). Those tests use sequential operations; no test coordinates upload registration/content/completion with deletion. `tests/integration.mjs` likewise does not establish this concurrent interleaving.

**Recommendation (not implemented in this read-only audit):** make upload registration conditional on the design still being `DRAFT` at the insert/claim point, and fence content persistence and completion against deletion state. Ensure deletion claims or invalidates outstanding upload sessions and handles each asset state with retry-safe conditional updates. Add deterministic barrier-based race tests for insertion before/after the deletion asset scan and for upload completion during deletion.

### MEDIUM — Required concurrency scenarios lack direct regression tests

The code uses conditional database updates and provider delete operations that are idempotent, but the reviewed suite does not run competing deletion requests or coordinate deletion with renewal, fulfillment, webhook settlement, or lifecycle cleanup. Sequential state tests are useful but do not prove these interleavings. The upload race above is a concrete example of why those tests matter.

Before considering deletion concurrency fully verified, add local synthetic tests that coordinate the competing operations at their DB/storage boundaries. This audit did not add or modify tests.

## 4. DELETE route and customer ownership

| Area | Assessment | Evidence |
|---|---|---|
| Authentication | PASS | `deleteDesign` calls `requireSession` before processing. |
| CSRF/origin | PASS | `deleteDesign` calls `requireCsrf`; `tests/publications.test.ts` checks unauthenticated, invalid-CSRF, and invalid-Origin requests. |
| Ownership / ID guessing | PASS | Initial design lookup is scoped by both `id` and `customer_id`; absent/foreign IDs return the same 404. Test confirms Customer A cannot delete Customer B's design. |
| Pending order/fulfillment | PASS for tested sequential states | Conditional deletion guards use `designHasProtectedHistory` and `noDesignDeletionInProgress`; tests cover awaiting payment and a processing fulfillment job. |
| Paid order/payment ledger | PASS | Protected history takes the soft-deletion path. It unpublishes, cleans publication derivatives, and returns retained-data state; it does not delete orders/payments or mark successful payment differently. A regression test asserts `SUCCEEDED`, `FULFILLED`, entitlement, snapshot, and ledger remain. |
| Entitlement | PASS for DELETE path | Protected deletion does not revoke the storage entitlement; the paid-site test asserts it remains `ACTIVE`. Explicit revoke is a separate operation and must not be conflated with deletion/unpublishing. |
| Shared assets | PASS for existing references | `noSharedPublicationAsset` and a subsequent reference query prevent physical source deletion where another active or retained publication references it. A regression test covers a shared source asset. The upload race is a separate way to miss an asset, not a demonstrated cross-publication reference bypass. |
| Cleanup retry | PASS for covered storage failures; race limitation remains | Failure returns retryable state and a later request retries cleanup. Cloudinary/R2 deletion is idempotent in the local adapters. The newly inserted asset race is not covered by this retry logic. |
| Customer-facing result | PASS with limitation | Dashboard retains the website/design record and exposes retry status. Paid deletion says data is retained; the UI distinguishes retrying public-media cleanup from draft deletion. Remote/browser UX is not verified. |

Deleting a paid site is currently an unpublish/data-retention request, not erasure of its order, payment ledger, entitlement, design snapshot, or source media. The code does not claim that paid customer data has been permanently erased.

## 5. Race-condition review

| Interleaving | Source assessment | Test evidence |
|---|---|---|
| DELETE vs renewal | Conditional design-state and order/publication checks appear to prevent a renewal from being created or applied after deletion claims the design. | No direct concurrent DELETE/renewal test. |
| DELETE vs fulfillment | Deletion guard checks protected order/job history; fulfillment uses persisted job/order state and conditional claims. | Sequential pending-job guard exists; no coordinated race test. |
| DELETE vs payment webhook | Webhook settlement requires a valid signature and eligible pending order/payment state; deletion protects pending order history. | Payment tests cover settlement/idempotency separately; no concurrent DELETE/webhook test. |
| DELETE vs publication lifecycle | Deletion changes a published publication to `UNPUBLISHED` with a lifecycle revision update; lifecycle uses persisted expiry/retention state. | Expiry/unpublish tests exist, but no concurrent DELETE/lifecycle test. |
| DELETE vs cleanup retry | Deletion state and storage retry are visible and repeated provider deletion is idempotent. | Sequential retry test exists; no simultaneous retry test. |
| Two DELETE requests | Both can enter while design is `DELETION_PENDING`; storage deletes are idempotent and DB updates are conditional. No exclusive deletion lease was found. | No simultaneous DELETE test. |
| Two publications sharing an asset | Existing active/retained cross-publication references block physical deletion; publication reference records are checked. | Shared-asset preservation test exists, but no concurrent reference-creation test. |
| DELETE vs upload | Upload registration and later upload phases do not revalidate design state; deletion may miss or fail to transition the new asset. | No race test; **HIGH finding above**. |

The design/order guards provide meaningful protection, but absence of direct concurrent tests means this table is source-level reasoning, not proof of all database interleavings. The confirmed upload race prevents a PASS verdict.

## 6. Publication, expiry, retention, and recovery

- Protected paid deletion unpublishes the publication while retaining order/payment evidence, entitlement, snapshot, and source assets.
- Unpublished websites remain present in the customer account listing with renewal history and available retry/status information.
- Renewal is available only for eligible publication/entitlement states; lifetime hosting is not offered a renewal action.
- Lifecycle code handles `UNPUBLISHED` expiration and preserves lifetime hosting without an expiry boundary. Tests cover finite expiry and lifetime behavior.
- Failed publication derivative cleanup remains represented as pending and can be retried through the existing lifecycle/deletion path.
- No migration was added for ORDERS-2.38.
- These are local-source and synthetic-test observations. Remote Cron execution, production lifecycle behavior, and remote storage cleanup are **NOT VERIFIED**.

## 7. CSP and template integrity

The inline-script SHA-256 for `templates/our-universe/index.html` was checked against the configured CSP values in `_headers` and `vercel.json`; the current hash matches. The policy was not relaxed. Existing template/security tests pass, and no template-registry change is part of this remediation.

The separate command `node --check templates/our-universe/index.html` is not applicable: Node rejects `.html` as an unsupported JavaScript file extension. This is not a project test failure. The dashboard JavaScript syntax check (`node --check account/websites/websites.js`) passed; the inline HTML script was checked via the CSP hash comparison rather than by passing the HTML document to Node.

## 8. Verification evidence and limitations

Local checks completed:

- `npm run typecheck` — PASS.
- `npm test` — PASS, 148 tests across 27 suites; 0 failures.
- `npm run test:integration` — PASS using isolated local synthetic database/storage and local sinks.
- `node --check account/websites/websites.js` — PASS.
- CSP hash comparison — PASS.
- `git diff --check` — PASS before adding this report; rerun after report creation as final worktree validation.

The unit and integration results are local-only. They are not browser, remote Preview, provider, or Production evidence. No remote database, storage, payment provider, scheduler, or Production resource was accessed. No migration, payment, deployment, or real customer operation was performed.

## 9. Final verdict and required action

**FAIL — remediation needs a follow-up code change before deletion safety can be considered verified.**

The primary blocker is the HIGH upload/deletion race in `src/assets.ts` and `src/designs.ts`. Fix and add deterministic local regression coverage for it before relying on physical draft deletion. Also add the MEDIUM concurrent-operation tests listed above; then rerun the local suite. Remote/Production validation remains a separate release requirement and was not performed in this audit.

No additional business policy decision is required to identify this technical defect. The existing distinction remains: paid-site deletion unpublishes and retains records; draft deletion can physically remove its design media. The owner should continue to treat that distinction as the active product policy until explicitly changed.

# ORDERS-2.38 — Publication Deletion & Entitlement Safety Remediation

## Verdict

**PARTIAL — local remediation and synthetic verification are complete; owner policy decisions and remote/Production verification remain outstanding.** No deployment, remote migration, provider call, real order, or real payment was performed.

## Git baseline

Captured before the ORDERS-2.38 inspection:

- Repository: `C:\Users\ltdc9\OneDrive\Desktop\crushify`
- Branch: `main`
- HEAD: `4f4aaa354893309dd8ed325882bfa461058aa9d3`
- Staged changes: none
- Pre-existing modified tracked files (15): `account/websites/websites.js`, `docs/DATABASE_SCHEMA.md`, `docs/PAYMENT_FLOW.md`, `docs/PUBLICATION_AND_DELIVERY.md`, `src/designs.ts`, `src/index.ts`, `src/logging.ts`, `src/payments.ts`, `src/publications.ts`, `tests/database-contract.test.ts`, `tests/database.test.ts`, `tests/integration.mjs`, `tests/payment-contract.mjs`, `tests/publications.test.ts`, and `tests/vercel.test.ts`.
- Pre-existing untracked files (4): the ORDERS-2.35, ORDERS-2.36, and ORDERS-2.37 QA reports, plus `migrations/0009_fulfillment_recovery_leases.sql`.

All pre-existing changes and untracked files were preserved. The final worktree remains uncommitted; its exact status is reported in the completion message.

## Final Git state

- Branch: `main`
- HEAD: `4f4aaa354893309dd8ed325882bfa461058aa9d3` (unchanged)
- Staged changes: none
- Modified tracked files: 18 (the 15 baseline files plus `_headers`, `templates/our-universe/index.html`, and `vercel.json`)
- Untracked files: 5 (the four baseline files plus this report)
- No commit, push, merge, or deployment was performed.

## Root cause and prior behavior

`DELETE /api/v1/designs/{designId}` in [`src/designs.ts`](../../src/designs.ts) already required a customer session, CSRF/origin validation, and an owner-scoped design lookup. It blocked some pending/paid orders, but allowed deletion after `FULFILLED`: it revoked publications and entitlements, deleted source media, cleared snapshots/design data, and archived the design. This mixed public unpublishing, entitlement revocation, and physical erasure, while retaining the financial ledger. The route also lacked a shared-source-asset reference guard.

The existing schema already supported `DELETION_PENDING`, `UNPUBLISHED`, and retryable derivative states; no schema migration was needed.

## Chosen safe deletion policy

1. **Draft with no protected history:** physical cleanup is allowed only if there are no draft/awaiting/paid/fulfillment/refund-pending orders, no in-flight or recoverable fulfillment job, no publication/entitlement history, and no active or retained publication sharing its source assets.
2. **Any paid/refunded order, publication, or entitlement history:** deletion is a soft request. Active publications become `UNPUBLISHED`, derivative cleanup is attempted with retryable state, and the design data, source media, order/payment ledger, and entitlement rows/statuses remain unchanged. The request does not issue a refund or erase paid content immediately.
3. **Pending work:** every `AWAITING_PAYMENT` order is treated as in progress even if its expiry timestamp is past; deletion waits until the order is explicitly moved to a terminal state. `PENDING`, `PROCESSING`, `FAILED`, and `MANUAL_REVIEW` fulfillment jobs also block deletion. This avoids races with delayed settlement/recovery.
4. **Later expiry:** a soft-deleted finite publication remains eligible for ordinary lifecycle expiry at its persisted `expires_at`; the lifetime entitlement remains excluded. Existing retention cleanup may erase content after its configured retention deadline, but it never deletes orders or payment evidence.

This default preserves customer and accounting data while making the paid website private immediately. It does not create a refund, statutory retention, or permanent-erasure policy.

## Authorization, state, and cleanup safeguards

- Session and CSRF/origin checks still precede mutation. The database transition is conditional on the authenticated customer ID; missing and foreign IDs return the same `404`.
- The existing route's environment policy was not broadened or bypassed. It remains without a local-only gate, as noted in ORDERS-2.37; any Production policy change requires an owner decision.
- Database batches claim `DELETION_PENDING` and distinguish protected-history from physical-cleanup paths. Checkout/renewal and fulfillment eligibility continue to require the design's eligible state, preventing a new operation after the deletion claim.
- Paid deletion never updates payment/order state or revokes entitlement status. It only unpublishes public access and cleans publication derivatives. Failure remains represented by `CLEANUP_PENDING`; the customer list exposes that state and offers a retry without implying that paid source data is being erased.
- Draft media is marked `DELETION_PENDING` before provider deletion. Each successful object deletion is checkpointed. Provider failure leaves the design retryable; retry and repeated completed requests are idempotent.
- Source media is not removed if an active or retained publication references it. Lifecycle retention also blocks while orders or recoverable fulfillment work are pending.
- [`src/publications.ts`](../../src/publications.ts) now considers `UNPUBLISHED` finite publications for ordinary expiry, so a deletion request does not bypass the stored hosting expiry. Existing lifetime exclusion is preserved.

## Files changed for ORDERS-2.38

- `src/designs.ts` — protected soft-delete, pending-work guards, shared-reference checks, checkpointed draft cleanup.
- `src/publications.ts` — retry-state reporting, expiry of finite soft-unpublished publications, and retention guards.
- `account/websites/websites.js` and `templates/our-universe/index.html` — truthful customer messaging and retry UX.
- `tests/publications.test.ts` and `tests/integration.mjs` — persisted database and local D1 deletion regressions.
- `_headers`, `vercel.json`, and the Our Universe CSP meta policy — synchronized the inline-script hash required by the changed deletion UX.
- `docs/PUBLICATION_AND_DELIVERY.md` — documented deletion and retention semantics.
- This QA report.

## Migration status

**No migration added or executed.** Existing schema status values and relations were sufficient. No remote database was accessed.

## Verification evidence

Commands were confirmed local-safe before execution:

- `npm run typecheck` — passed.
- `npm test` — passed, 148 tests, 0 failures.
- `npm run test:integration` — local Wrangler Worker with local D1/R2 and a local email sink only; no remote provider or Production resource.
- `node --check account\websites\websites.js` — passed.
- Inline Our Universe application script parsed successfully.
- `git diff --check` — passed.

Focused persisted-state coverage includes:

- Unauthenticated, invalid-CSRF, invalid-origin, and cross-customer/guessed-ID deletion rejection.
- Paid deletion preserves `FULFILLED` order, `SUCCEEDED` payment, active entitlement, snapshot, and source object while unpublishing the website.
- Derivative-cleanup failure remains retryable; repeated retry does not remove source data or duplicate state changes.
- Draft physical cleanup checkpoints failure, retries successfully, and is idempotent.
- Shared source assets are retained while another active publication references them.
- Awaiting payment (including an expired timestamp), active/recoverable fulfillment, and renewal-style pending orders block deletion.
- Finite soft-unpublished hosting expires at its persisted boundary; lifetime hosting does not expire.
- Local D1 integration confirms public reads stop after a paid deletion request while protected source and ledger state remain.

These are local synthetic/database tests, not browser, remote Preview, provider, or Production verification.

## Known limitations and owner decisions

- Confirm whether a customer deletion request should ever initiate a refund; this implementation never does.
- Approve the permanent-erasure and retention policy for paid content and confirm the existing `DATA_RETENTION_DAYS` lifecycle is appropriate. The request itself retains protected source data until normal expiry/retention cleanup.
- Confirm customer-facing terminology and support handling for a paid website that is unpublished but still retains its content and hosting entitlement.
- The customer `DELETE` route still has no local-only environment gate. That existing deployment behavior was deliberately not changed; verify/approve its Production policy before relying on it.
- Remote credentials, actual database/storage configuration, deployed CSP, Production scheduling, and remote deletion behavior were not inspected or tested. No Production readiness claim is made.

## Remote/Production verification required

Before any Production rollout of this remediation, the owner must review the deletion/refund/retention decisions, then test on isolated Preview resources: owner and CSRF denial, paid unpublish, failed derivative/source cleanup retry, shared-asset retention, and finite/lifetime lifecycle behavior. Confirm deployment CSP hashes and operational visibility/retry behavior. Do not enable checkout or webhook settlement as part of this verification.

# ORDERS-2.20 — Staging Blocker Resolution Plan

## Purpose and verdict

This is a local, read-only implementation plan based on the current checkout and
the QA evidence available in the repository. No provider, dashboard, remote
database, email service, deployment, or Production resource was accessed.

**Verdict: PLAN COMPLETE — USER DECISIONS REQUIRED.**

The code contains useful local safeguards, but there is no evidence here that
Preview resources are provisioned or isolated remotely. In addition, the current
Preview origin fallback and the local-only catalog/payment/publication gates
prevent safe end-to-end staging verification as currently implemented. This
plan does not claim staging or Production readiness.

## 1. Git baseline and evidence freshness

At the start of this task:

| Item | Recorded state |
|---|---|
| Branch | `main` |
| HEAD | `a81d5788069751ed10a52a980add3b4f3c291f39` |
| Staged changes | None |
| Modified tracked files | None |
| Untracked files | `docs/qa/ORDERS-2.19-STAGING-INFRASTRUCTURE-READINESS.md` |
| Tracked file count | 138 |

The local `origin/main` tracking ref also pointed to `a81d578`; no fetch was
performed, so this is not confirmation of current GitHub state.

The recent history establishes the report-baseline discrepancy:

| Commit | Subject |
|---|---|
| `a81d578` | Complete staging QA and Cloudinary isolation |
| `5205f73` | Refactor Say Yes template and enhance photo management features |
| `0ac84ba` | Integrate order pricing and improve template flows |
| `a2c3343` | Harden hosting and local security boundaries |
| `245a40f` | fix(local): isolate staging and mock customer workflows |
| `f867f01` | fix(database): create local SQLite parent directory |
| `a86c50b` | fix(staging): isolate local staging credentials |
| `f0322b4` | fix(staging): restore secure Vercel staging ops |
| `808a7bb` | chore(staging): remove temporary operations access |
| `8340964` | fix(vercel): route nested runtime endpoints |

`a81d578` is a child of `5205f73` and contains the ORDERS-2.18B remediation
commit contents. Therefore, the HEAD recorded in the 2.18B report is its
pre-commit snapshot, not evidence that the remediation is absent. The
ORDERS-2.19 report is untracked at this task's baseline. No tracked code or
configuration changes were present after `a81d578`.

The actual ORDERS-2.16 report is
[ORDERS-2.16-FINAL-PRODUCTION-READINESS.md](ORDERS-2.16-FINAL-PRODUCTION-READINESS.md);
the `...-REVIEW.md` spelling in the earlier task is not present.

## 2. Current architecture and evidence boundary

- The intended Preview target is the Vercel Node runtime with Turso. The
  Cloudflare Worker, D1, and R2 configuration is documented as a legacy or
  alternate path. See [PRODUCT_ARCHITECTURE.md](../PRODUCT_ARCHITECTURE.md),
  [VERCEL_STAGING.md](../VERCEL_STAGING.md), and
  [STAGING_DEPLOYMENT.md](../STAGING_DEPLOYMENT.md).
- Vercel selects the Turso adapter and obtains Preview credentials from
  `TURSO_STAGING_DATABASE_URL` and `TURSO_STAGING_AUTH_TOKEN`; generic Production
  Turso credentials are rejected on the Preview path. This verifies code
  selection, not the database account, actual resource, token scope, or Vercel
  configuration.
- `src/storage/cloudinary-policy.ts` and the Vercel storage path reject
  Cloudinary in staging. Vercel can use process-local mock storage; the existing
  R2 adapter uses a Worker binding and is not a Vercel R2 adapter.
- `vercel.json` declares the lifecycle Cron route. Repository evidence does not
  establish that a Preview deployment has a scheduler or that any deployed Cron
  has run.
- The Worker staging configuration includes D1/R2 and an email-provider
  setting. Current staging email code returns a discard sink or no mail service
  before generic provider delivery logic; that static setting is not evidence
  that staging mail is delivered. The legacy deployment document contains
  historical instructions that must not be used as evidence of current Preview
  behavior.
- No remote account identity, Vercel environment variable assignment, migration
  execution, storage operation, email delivery, payment, or Cron execution was
  verified. No credential or environment-variable value was read or recorded.

### Findings added after reviewing the current code

1. **Preview-origin risk:** `originFromEnvironment` in
   [vercel.ts](../../src/platform/vercel.ts) prefers `APP_ORIGIN`, then
   `VERCEL_PROJECT_PRODUCTION_URL`, then `VERCEL_URL`. In Preview, if
   `APP_ORIGIN` is absent, a Production project URL can therefore be selected
   ahead of the deployment-specific Preview URL. A Production `APP_ORIGIN` is
   also not rejected solely because the runtime is Preview. The environment
   validator checks that an origin is present and valid but does not establish
   that a Preview callback origin is non-Production. Whether the deployed
   Preview currently has the relevant values is unverified. Correct and test
   this before enabling Preview email login or magic-link flows.
2. **End-to-end checkout/publication is disabled outside local mode:**
   [product-catalog.ts](../../src/product-catalog.ts) sets
   `STANDARD_CATALOG_ENABLED` to false, while the pricing override in
   [payments.ts](../../src/payments.ts) is local-test-only. Payment mode is
   restricted to local testing by the Vercel guard. In
   [publications.ts](../../src/publications.ts), publication mutations require
   local test mode and a local environment. As a result, a Preview cannot
   currently exercise a complete catalog → checkout → synthetic settlement →
   publication flow. This is a missing staging capability, not a reason to
   enable real payment processing.

## 3. Blocker resolution plans

Statuses below describe the **current evidence**, not a future implementation.
Every recommended remote verification remains unperformed.

### A. Dedicated Preview database and safe migration target

**Current status: PARTIAL.**

**Evidence.** Vercel selects Turso and the staging-specific credential names.
Preview validation rejects generic Production Turso credentials and fails
before database initialization when required staging configuration is absent.
The staging validation in `scripts/staging-config.ts` checks expected staging
metadata and a database-host pattern. That pattern and self-supplied
confirmation metadata do not prove the remote resource's identity or account.
No remote connection was made.

**Plan.**

1. Have the owner provision a separate, empty Preview database and a
   database-scoped token. Do not copy Production credentials or point a Preview
   alias at Production.
2. Independently confirm the provider-side organization, database/resource
   identity, region, account, and token scope. Record only non-secret identity
   evidence in the authorized runbook; never record a token.
3. Keep the Vercel Preview credential contract limited to
   `DATABASE_PROVIDER`, `TURSO_STAGING_DATABASE_URL`, and
   `TURSO_STAGING_AUTH_TOKEN`. Do not define generic Production Turso
   credentials in Preview.
4. Tighten local preflight to compare the configured target with an
   owner-approved, exact non-secret resource identity; do not treat a broad
   hostname pattern or confirmation string as proof. Verify the connection
   against a staging identity marker or equivalent provider-verified identity
   before any migration is allowed.
5. Add tests proving that missing configuration, Production credential
   fallback, a wrong expected identity, and a mismatched runtime scope fail
   before a database connection or write.
6. Run a read-only preflight first. Only after explicit user authorization,
   verify that the target is empty and staging-owned, then apply migrations
   using the single selected Turso staging command. Verify migration checksums,
   schema version, and application health afterward.

**Files for a later implementation:** `src/platform/vercel.ts`,
`scripts/staging-config.ts`, `scripts/staging-turso.ts`,
`tests/vercel.test.ts`, `tests/staging-config.test.ts`, and
`docs/VERCEL_STAGING.md`.

**Required names only:** `DATABASE_PROVIDER`,
`TURSO_STAGING_DATABASE_URL`, `TURSO_STAGING_AUTH_TOKEN`. The staging migration
script also uses confirmation variables; those are not substitutes for
provider-side identity verification.

**Cost and security:** Database plan, quotas, backup retention, and billing were
not checked. A distinct database and database-scoped token reduce cross-
environment exposure; they do not prove safety until provider ownership is
verified.

### B. Preview authentication, email, and callback origin

**Current status: PARTIAL.**

**Evidence.** The Vercel Preview guard rejects generic mail credentials and
local-test email settings. `createEmailService` selects a Preview discard sink
or no service; it does not fall through to the generic production mail provider.
The discard path does not provide an interactive login link. Existing code
protects magic-link responses from returning the token, but Preview login cannot
be considered operational merely because a mail setting exists. The origin
precedence issue described above creates a conditional risk that a Preview link
could point to the Production origin. The local tests do not cover the
combination of a Preview deployment URL and the Production project URL with no
explicit Preview origin.

**Plan.**

1. Fix origin resolution so Preview accepts only its explicit, deployment-
   scoped origin. Reject Production aliases and malformed or untrusted origins
   at environment validation; do not rely on precedence alone.
2. Add a regression test that exercises the real Vercel handler with Preview
   and Production URL inputs together, no explicit Preview origin, and a
   Preview-origin request. Assert the exact allowed-origin behavior and that
   invalid Production-origin combinations fail closed. Add tests for callback
   link origin and token non-disclosure through response and logs.
3. Choose between no interactive Preview login and a dedicated email sandbox.
   If login is needed, use separate sandbox credentials, provider-side
   recipient restrictions, a code-level synthetic-recipient allowlist, and a
   Preview-only sender/origin. Never expose magic tokens through a public API,
   exception, or log.
4. Verify cookies remain secure, environment-scoped, and isolated from
   Production. Protect the Preview deployment itself; a test recipient
   allowlist does not replace deployment access control.
5. Clean up the legacy Worker email-provider declaration in a separately
   authorized configuration change, or document why it remains inert. Do not
   introduce a Production fallback.

**Files for a later implementation:** `src/platform/vercel.ts`, `src/auth.ts`,
`src/types.ts`, `tests/vercel.test.ts`, `tests/pre-staging-security.test.ts`,
and `docs/VERCEL_STAGING.md`. The legacy Worker setting is in
`wrangler.staging.jsonc`.

**Candidate names only** (proposed, not currently supported):
`PREVIEW_MAIL_PROVIDER`, `PREVIEW_MAIL_API_KEY`, `PREVIEW_MAIL_FROM_EMAIL`,
`PREVIEW_MAIL_ALLOWED_RECIPIENTS`. If the owner chooses not to provision a
sandbox, leave Preview login disabled and retain the discard/unavailable
behavior.

**Cost and security:** Email sandbox plan and per-message limits were not
checked. A sandbox with recipient allowlisting is preferred to a token-retrieval
endpoint or a sink that exposes links.

### C. Persistent staging media storage

**Current status: PARTIAL.**

**Evidence.** Preview Cloudinary is intentionally blocked by the shared staging
policy. The Vercel mock adapter is process-local and ephemeral. The existing
R2 implementation requires a Cloudflare Worker binding and is not selected by
Vercel. Production Cloudinary behavior is retained. The local policy prevents
the known Cloudinary paths from selecting it in staging, but no remote
Cloudinary account identity or credentials were examined.

**Plan.**

1. Prefer a separately provisioned Cloudinary staging account/cloud with
   distinct credentials if the product owner selects Cloudinary for Vercel
   Preview. Verify account ownership and credential identity independently;
   cloud-name comparison alone is insufficient.
2. Keep Production Cloudinary variables absent from Preview. After owner
   approval, permit only a complete staging-specific configuration with
   conflicting, incomplete, or Production-identical configuration rejected.
   Do not add a boolean that merely asserts account separation.
3. Test provider selection through both the Vercel factory and every direct
   adapter/legacy Worker entry point. Assert that no fallback silently selects
   Cloudinary or another provider when validation fails.
4. Use synthetic media only, verify private originals/public derivatives and
   deletion in the staging account, then verify no Production resource was
   touched. Do not use real customer data.
5. If the owner instead chooses R2 for Vercel, plan and review a Vercel-
   compatible adapter as a separate architecture change; the current Worker
   binding is not sufficient.

**Files for a later implementation:** `src/storage/cloudinary-policy.ts`,
`src/platform/vercel.ts`, `src/types.ts`, storage/security tests, and the
staging documentation. Do not change `src/storage/cloudinary.ts` without a
specific adapter defect.

**Required names only:** Existing Cloudinary credential names are referenced by
the source policy and must not be copied into Preview. Any new staging-specific
Cloudinary names require a separate implementation and owner approval; this
plan intentionally does not invent an active credential contract.

**Cost and security:** Cloudinary account plan, transformation quotas, storage
limits, and R2-compatible Vercel cost were not checked. A separate account is
the clearest isolation boundary; a folder prefix in a shared Production cloud
is not equivalent to a separate account.

### D. Lifecycle scheduling and expiration

**Current status: PARTIAL.**

**Evidence.** The lifecycle handler validates a bearer `CRON_SECRET` and
environment scope before operating on the selected database. The scheduler uses
a lease and bounded, retryable lifecycle work. Public publication and asset
paths enforce expiration independently of cleanup, so inaccessible expired
content does not depend solely on Cron. `vercel.json` declares one lifecycle
Cron, but repository configuration does not establish a Preview Cron. No
deployed Cron was invoked or observed. The Worker scheduler is a separate
legacy path and must not be conflated with Vercel/Turso scheduling.

**Plan.**

1. Keep Production's existing schedule and secret unchanged.
2. For controlled Preview testing, use the existing authenticated lifecycle
   endpoint with a distinct Preview `CRON_SECRET`, protected Preview access,
   and the verified Preview database. Invoke it manually from an approved
   runner; do not put the bearer token in URLs, logs, or shell history.
3. Test the authorized and rejected cases, duplicate invocation, lease
   contention, retry after transient failure, and expired-publication and
   asset denial before cleanup. Confirm the handler cannot select Production
   credentials from Preview.
4. Only if recurring staging cleanup is needed, select a dedicated scheduler
   after confirming the chosen platform's Preview support and plan limits.
   Do not assume the Production Cron schedule runs for Preview.
5. Keep Worker/D1 scheduled recovery as a separately documented legacy
   workflow; it does not become a Vercel Preview scheduler.

**Files for a later implementation:** `api/cron/publication-lifecycle.ts`,
`src/platform/vercel.ts`, `src/scheduler.ts`, `src/publications.ts`,
`vercel.json`, and scheduler/publication tests.

**Required name only:** `CRON_SECRET`; use distinct values by environment
without recording or exposing them.

**Cost and security:** Vercel Cron availability for Preview and any dedicated
scheduler price/limits were not verified. Manual invocation is sufficient for
controlled test runs and avoids claiming unattended Preview scheduling.

### E. One authoritative migration workflow per database

**Current status: PARTIAL.**

**Evidence and distinction.**

- `scripts/migrate-turso.ts` is local SQLite-only: it requires a `file:` URL and
  rejects a remote auth token. It is not a remote Turso migration command.
- `scripts/staging-turso.ts` is the remote Turso staging preflight/migration
  path. It checks staging configuration, migration state/checksums, and schema
  verification. Its self-supplied confirmation inputs and broad host check do
  not prove provider-side identity.
- `db:apply:staging` invokes Wrangler against the legacy Worker/D1 configuration.
  It targets a different database engine and is a separate workflow, not a
  second Turso migration route.
- These scripts share migration machinery and ledger checks, but they target
  different databases. Runtime application startup does not automatically run
  migrations. Migrations are applied per migration; a later failure can leave
  earlier migrations committed, so recovery must use the recorded ledger and
  rerunnable migration behavior rather than assume a single all-or-nothing
  batch.

**Plan.**

1. Declare `scripts/staging-turso.ts` the only remote migration route for Vercel
   Preview/Turso. Keep `scripts/migrate-turso.ts` local-only and state this in
   its command documentation.
2. Retain the Wrangler D1 command only if Worker staging remains authorized.
   Label it explicitly as Worker/D1 and require a separate verified D1
   identity/preflight. Do not route it through a Turso confirmation guard or
   imply that it operates on Vercel Preview.
3. Strengthen Turso preflight to verify the exact owner-approved target before
   migration and fail before writes on any mismatch. Require a reviewed
   read-only preflight record before the separately authorized migration.
4. Test no-remote/no-write behavior for local commands, wrong-target rejection
   for staging commands, checksum mismatch, partial migration recovery, and
   already-applied migrations using isolated local test databases.
5. Document backup/recovery ownership and the point at which the user must
   explicitly authorize a remote migration. No migration is part of this plan's
   execution.

**Files for a later implementation:** `scripts/staging-config.ts`,
`scripts/staging-turso.ts`, `scripts/migrate-turso.ts`, `package.json`,
`tests/staging-config.test.ts`, `tests/migrate-turso.test.ts`, and migration
documentation.

**Required names only:** `TURSO_STAGING_DATABASE_URL`,
`TURSO_STAGING_AUTH_TOKEN`, `TURSO_DATABASE_URL`, and the existing staging
confirmation variable names in the scripts. No values are included here.

**Cost and security:** Backup support, retention, recovery point objectives,
provider plan, and cross-region recovery were not checked. Production rollback
must not be attempted by applying reverse SQL blindly; restore/forward-fix
must follow a separately reviewed recovery procedure.

### F. Staging-only synthetic checkout and publication capability

**Current status: BLOCKED.**

**Evidence.** `STANDARD_CATALOG_ENABLED` is false in
[product-catalog.ts](../../src/product-catalog.ts); approved local pricing
overrides are local-test-only in [payments.ts](../../src/payments.ts).
Vercel does not enable the Preview payment path, and
[publications.ts](../../src/publications.ts) rejects publication mutations
outside local test mode. Thus the current Preview cannot satisfy a full
synthetic order-to-publication acceptance test. SePay Live is not implemented
and no real payment is appropriate for this work.

**Plan and decision point.** If the owner requires the complete flow in
Preview, design an explicit synthetic-only provider/catalog path restricted to
the protected Preview deployment and verified staging database. It must not
use SePay credentials, must not accept real funds, and must not be possible to
enable in Production even if a flag is mistakenly copied. Settlement should be
driven only by an authenticated test harness or a separately signed synthetic
event, not a public "mark paid" endpoint. Use synthetic orders/users/media and
test-only values, not the production catalog or customer records.

Add negative tests proving that the synthetic settlement and publication path
reject Production, local/unknown scopes, missing staging identity, unsigned or
replayed synthetic events, and non-test orders. Add positive Preview-scope
tests with an isolated local database and mocked provider. Keep the existing
production payment architecture unchanged.

If that staging-only capability is not approved, limit Preview acceptance to
editor, persistence, media, and disabled-payment behavior; keep the paid
publication contract in local synthetic tests and mark full Preview checkout
as blocked.

**Files for a later implementation:** `src/product-catalog.ts`,
`src/payments.ts`, `src/payments/provider.ts`, `src/platform/vercel.ts`,
`src/publications.ts`, and focused payment/publication integration tests.

**Security and cost:** No external payment provider is needed for this
capability. It still creates a high-impact staging-only privileged path and
requires explicit design review, deployment protection, synthetic data, and
Production-negative tests.

## 4. Safe target architecture

1. **Application:** Vercel Preview only, protected by deployment access control;
   explicitly reject Production origin and credentials.
2. **Database:** Dedicated, owner-verified Turso Preview database and scoped
   token. No Production database URL/token fallback.
3. **Storage:** Dedicated Cloudinary staging account only after independent
   account verification, or keep mock storage and limit media persistence
   testing. Do not reuse a Production cloud with only a folder prefix.
4. **Authentication:** Preview origin is explicit and deployment-scoped.
   Either disable interactive login or use a sandbox mail provider with a
   synthetic-recipient allowlist and separate credentials.
5. **Payments:** No real provider credentials and no real payments. Full
   checkout/publication requires a separately approved synthetic-only test
   path; otherwise retain disabled payment in Preview.
6. **Lifecycle:** Manual authenticated Preview invocation for tests using the
   Preview database and a distinct secret. Keep Production Cron unchanged.
7. **Migrations:** One selected Turso Preview preflight/migration workflow.
   Keep local SQLite and optional Worker/D1 paths explicitly separate.

## 5. Implementation phases and gates

These are future phases only; none was executed.

### Phase 0 — Local readiness and decisions

- **Prerequisites:** Owner chooses the target runtime (Vercel/Turso is the
  documented recommendation), storage, Preview login policy, synthetic
  checkout requirement, and migration owner.
- **Steps:** Resolve the origin precedence finding; add failing-closed tests for
  Preview/Production origin combinations; review the migration command map;
  agree on non-secret resource identities and recovery ownership.
- **Pass criteria:** Target architecture and owners are documented; tests
  demonstrate Production resources are rejected from Preview; no provider
  values are exposed.
- **Rollback:** No remote change occurs in this phase; revert only the
  separately reviewed code change if tests fail.

### Phase 1 — Provider staging verification

- **Prerequisites:** Explicit owner authorization and provider access by the
  owner/operator; no Production changes.
- **Steps:** Provision/verify dedicated Turso, Cloudinary if selected, email
  sandbox if selected, and deployment protection. Confirm account/resource
  identity, credential scope, quotas, and recovery options without copying
  secrets into reports.
- **Pass criteria:** Written non-secret evidence shows each Preview resource is
  distinct and credentials are scoped; Production variables are absent from
  Preview; preview recipients and storage are restricted.
- **Rollback:** Disable the Preview integration, revoke only staging
  credentials, preserve Production resources, and do not migrate/upload until
  the target is reverified.

### Phase 2 — Vercel Preview configuration

- **Prerequisites:** Phase 0 origin fix and Phase 1 resource identity approval.
- **Steps:** Configure Preview-only variables by name and scope; deploy to
  Preview only after user authorization; run read-only health and database
  preflight; verify origin, cookies, database identity, and storage selection.
- **Pass criteria:** Preview uses only its approved database and storage;
  invalid/missing variables fail closed; no Production callback URL, database,
  storage, email, payment, or Cron credential is selected.
- **Rollback:** Disable the Preview deployment or remove the Preview-only
  configuration; do not modify Production variables or use Production
  credentials as fallback.

### Phase 3 — Migration and data recovery readiness

- **Prerequisites:** Verified empty staging database, backup/recovery plan, and
  explicit user approval for a remote staging migration.
- **Steps:** Run staging Turso preflight, inspect its non-secret target
  identity, apply migrations using the selected command, then verify checksums,
  schema version, and a synthetic health query. Do not copy Production data.
- **Pass criteria:** Only the approved staging database changes; migration
  ledger and schema match the repository; recovery owner and restore procedure
  are documented.
- **Rollback:** Stop on identity/checksum mismatch. Use the approved staging
  restore or forward-fix procedure; never point Preview at Production.

### Phase 4 — Storage and authentication verification

- **Prerequisites:** Phases 1–3 pass; selected storage and login options
  approved.
- **Steps:** Use synthetic test accounts and media. Verify allowed recipients,
  callback origin, cookie scope, token expiry/non-disclosure, private original,
  public derivative, and deletion in the staging account.
- **Pass criteria:** No token or user content appears in logs/responses;
  Preview links resolve only to the Preview origin; all assets remain in the
  approved staging resource.
- **Rollback:** Disable login or media upload, revoke staging-only credentials,
  remove only known synthetic assets through the approved cleanup path, and
  preserve Production.

### Phase 5 — Lifecycle verification

- **Prerequisites:** Phase 3 passes and a distinct Preview `CRON_SECRET` is
  configured by the owner.
- **Steps:** Manually invoke the authenticated Preview endpoint. Test expired
  reads, cleanup, duplicate calls, lease contention, retry, and rejection of
  Production scope/database selection.
- **Pass criteria:** Expired content and assets are denied independently of
  cleanup; cleanup is idempotent and only affects the staging database/storage;
  no Production scheduler setting changes.
- **Rollback:** Stop the Preview invocation, remove/rotate the staging secret,
  and leave Production scheduling untouched.

### Phase 6 — Synthetic checkout and publication acceptance

- **Prerequisites:** Owner explicitly approves the synthetic-only capability
  described in blocker F, or accepts that full paid flow remains untested in
  Preview.
- **Steps:** With the synthetic-only option, use allowlisted test accounts and
  orders, no SePay or real funds. Test order creation, authoritative amount,
  signed test settlement, replay/duplicate rejection, publication, public URL,
  expiry, cleanup, and retry. Also verify the same test endpoint cannot settle
  or publish in Production.
- **Pass criteria:** The entire synthetic flow passes on staging only; client
  price cannot override the server price; replay, mismatch, wrong scope, and
  expired-order cases fail closed. If the feature is not approved, mark
  Preview paid publication as blocked rather than claiming success.
- **Rollback:** Disable the staging-only capability, reject further synthetic
  settlements, and remove only synthetic staging records/assets using the
  approved cleanup procedure. Do not alter the Production payment architecture.

### Phase 7 — Limited launch decision

- **Prerequisites:** Staging evidence is accepted, Production preflight is
  separately reviewed, payment-provider onboarding and rollback are complete,
  and the owner explicitly authorizes any real transaction or public launch.
- **Steps:** This plan does not authorize or execute a real transaction,
  Production configuration, or launch.
- **Pass criteria:** A new, explicitly authorized readiness review accepts
  evidence for the actual Production resources and provider.
- **Rollback:** Must be defined in that separate Production plan; no rollback
  action is authorized by this report.

## 6. Readiness matrix

| Area | Current status | Evidence and next action |
|---|---|---|
| Preview database code selection | PARTIAL | Turso Preview path is explicit and generic Production credential fallback is rejected. Verify actual resource identity, token scope, and Vercel Preview assignment. |
| Turso account/database isolation | NOT TESTED | No provider access. Provision and owner-verify a dedicated Preview database and scoped token. |
| Preview migrations | PARTIAL | Guarded remote Turso script exists; exact remote target is not independently proven. Strengthen exact-identity preflight and authorize separately. |
| Local SQLite migration separation | PASS | Local script requires a file database and rejects a remote token. Keep it local-only. |
| Worker/D1 migration separation | PARTIAL | Wrangler path is a separate legacy D1 workflow. Label and verify its target independently if retained. |
| Preview callback origin | BLOCKED | Current origin precedence can choose Production URL in Preview under specified missing/ambiguous configuration. Fix and add runtime-path regression tests. |
| Preview login/email | PARTIAL | Preview discards or disables delivery; no remote sandbox verified. Choose disabled login or a dedicated allowlisted email sandbox. |
| Cloudinary account isolation | NOT TESTED | Staging Cloudinary is blocked locally; no remote account identity is verified. Provision and verify a distinct account before enabling. |
| Vercel persistent media storage | BLOCKED | Mock is ephemeral; current R2 adapter is Worker-bound; staging Cloudinary remains blocked. Select and verify a persistent Vercel-compatible staging backend. |
| Lifecycle expiry enforcement | PASS | Code denies expired publication/asset reads independently of cleanup. Retain current tests and verify on staging. |
| Preview lifecycle invocation | PARTIAL | Authenticated endpoint supports scoped execution; no Preview run or schedule was verified. Perform an approved manual run with staging-only secret/database. |
| Preview Cron schedule | NOT TESTED | No Preview schedule or deployed execution evidence. Use manual staging invocation or verify an approved separate scheduler. |
| Preview standard catalog/checkout | BLOCKED | Catalog is disabled and the pricing override is local-only. Approve a synthetic-only Preview path or limit acceptance. |
| Preview payment settlement | BLOCKED | Payment mode is local-only; SePay Live is not implemented. Do not use real payments; design a synthetic-only path if required. |
| Preview publication mutation | BLOCKED | Mutation guard only enables local test mode. Add a separately gated staging test path or keep paid publication local-only. |
| Production payment changes | PASS | This task proposes no Production payment changes; no real provider or transaction was used. Reassess separately before launch. |
| Preview email-provider separation | PARTIAL | Current code does not fall through to generic delivery, but deployed variables and provider state were not inspected. Verify and remove ambiguous legacy configuration. |
| Backup/recovery | NOT TESTED | No remote backup settings or restore drill were inspected. Owner must verify retention and run a staging restore exercise. |
| Monitoring/support/quotas | NOT TESTED | No remote observability, support workflow, or provider limits inspected. Define owners and thresholds before public launch. |

## 7. User decisions and authorization boundaries

| Decision | Options and recommendation | Needed before |
|---|---|---|
| Target runtime | Vercel Preview/Turso (recommended by current architecture) or retain a separately isolated legacy Worker/D1 Preview. Do not mix migration or storage assumptions. | Provider provisioning |
| Preview database | Separate Turso database/account boundary with scoped token; owner verifies identity. | Any remote preflight or migration |
| Persistent media | Dedicated Cloudinary staging account (preferred if Cloudinary remains the product provider), retain ephemeral mock, or separately design Vercel-compatible R2. | Any persistent media test |
| Preview login | Keep disabled/discard-only, or provision a sandbox mail provider with recipient allowlisting. No public magic-token retrieval. | Interactive Preview auth |
| Checkout/publication | Approve a protected synthetic-only Preview provider/catalog, or explicitly leave the full paid flow blocked in Preview and rely on local contract tests. | Full staging E2E |
| Scheduler | Manual authenticated Preview invocation for controlled tests, or an owner-approved dedicated scheduler for recurring work. Keep Production Cron unchanged. | Any Preview lifecycle operation |
| Migration execution | Authorize one exact staging target after identity preflight; keep local SQLite and Worker/D1 commands separate. | Any remote schema write |
| Resource costs | Have owners verify provider tiers, storage/egress/transformation quotas, email limits, backup retention, and Cron support. No prices or quotas were checked. | Staging provisioning and launch |
| Deployment or real transaction | Requires a separate explicit authorization and a new review. This report grants none. | Any deploy, Production change, or real payment |

## 8. Verification and rollback checklist

### Required before any Preview deployment

- [ ] Resolve and test Preview-origin selection; reject Production-origin input
      in Preview.
- [ ] Confirm protected Preview access and environment-scoped cookies.
- [ ] Owner-verifies a separate database identity and token scope; no Production
      fallback.
- [ ] Select storage; if Cloudinary, verify account identity independently and
      use distinct credentials.
- [ ] Choose disabled login or a restricted sandbox email provider.
- [ ] Decide whether synthetic checkout/publication is in scope.
- [ ] Review the selected migration command and staging backup/recovery path.
- [ ] Keep Production payment variables, scheduler, and resources unchanged.

### Required before staging E2E

- [ ] Run typecheck and targeted security/configuration tests.
- [ ] Use only synthetic users, orders, and media.
- [ ] Verify missing, malformed, conflicting, Production-identical, and
      wrong-scope configuration fails closed.
- [ ] Verify the actual staging database, storage account, email sandbox, and
      callback origin by approved non-secret identity evidence.
- [ ] If synthetic payment is approved, test amount mismatch, wrong order,
      duplicate/replayed event, and Production rejection without provider calls.
- [ ] Verify expiration denial before lifecycle cleanup and retry/idempotency
      after cleanup.
- [ ] Record exact commands and observed results; do not infer remote readiness
      from local tests.

### Rollback principles

- Disable or protect the Preview deployment before changing credentials.
- Revoke/rotate only staging credentials; never modify Production credentials
  as a rollback shortcut.
- Stop on resource-identity mismatch before any migration, upload, deletion,
  email, or settlement.
- Restore only from a verified staging backup, or use a reviewed forward-fix
  migration; do not assume a migration batch is globally atomic.
- Delete only identified synthetic staging records/assets through the
  approved application/provider workflow.
- Do not roll back a Production deployment or alter Production resources under
  this plan.

## 9. Execution and final state

**Executed in this task:** local repository inspection and `npm run typecheck`.
The command ran `tsc --noEmit` and passed. No test suite was run because some
repository tests write local databases; no disputed claim required running
them for this planning deliverable. `git diff --check` passed; there are no
tracked diffs. The new, untracked report was separately checked for trailing
whitespace and passed.

**Not executed:** provider/dashboard access, Vercel or Turso environment
inspection, database connection or migration, Cloudinary operation, email
delivery, payment/webhook, lifecycle invocation, deployment, Production
operation, commit, push, or merge.

**Final Git state:** branch `main`, HEAD
`a81d5788069751ed10a52a980add3b4f3c291f39`; no staged or modified tracked
files. The only untracked files are the pre-existing
`ORDERS-2.19-STAGING-INFRASTRUCTURE-READINESS.md` and this report,
`ORDERS-2.20-STAGING-BLOCKER-RESOLUTION-PLAN.md`. No source, test, or
configuration files were changed.

**Final verdict: PLAN COMPLETE — USER DECISIONS REQUIRED.** This is an
implementation plan, not a staging-readiness or Production-readiness approval.

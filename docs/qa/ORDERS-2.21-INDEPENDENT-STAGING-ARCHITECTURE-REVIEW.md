# ORDERS-2.21 — Independent Staging Architecture Review & Implementation Blueprint

## 1. Executive summary

**Verdict: REVIEW COMPLETE — USER DECISIONS REQUIRED.**

ORDERS-2.20 is directionally sound: its Vercel Preview, database, storage,
authentication, lifecycle, migration, and synthetic-checkout blockers are
mostly confirmed by the current code. This independent review found one
confirmed Preview-origin defect and two conditional risks in the legacy
Cloudflare Worker path. No deployed resource was accessed, so this report does
not claim that any risk is active in a remote deployment.

The current Vercel adapter does not silently select generic Production
database, Cloudinary, email, or payment configuration for Preview. However,
resource names and environment scopes alone cannot prove that a
staging-named URL or credential actually belongs to an isolated provider
resource. Vercel Preview currently has no persistent supported storage path,
interactive email delivery, checkout/payment mode, or publication mutations.
Repository configuration also does not establish an independent Preview
lifecycle schedule.

Recommended target: protected Vercel Preview, exact Preview origin, a
separately provisioned and owner-verified Turso database, and persistent
staging storage using a separately verified Cloudinary account. Keep Cloudinary
disabled until that verification is complete. Retain the existing
authenticated manual lifecycle endpoint for controlled Preview runs. Use a
recipient-restricted email sandbox if interactive login is approved. A
synthetic-only checkout/publication path requires separate design approval;
SePay Test Mode must remain distinct from that path and Production.

No application code was changed. No provider, dashboard, remote database,
email service, payment system, migration, Cron, deployment, or Production
resource was accessed.

## 2. Git baseline

Initial `git status --short --untracked-files=all`:

```text
?? docs/qa/ORDERS-2.19-STAGING-INFRASTRUCTURE-READINESS.md
?? docs/qa/ORDERS-2.20-STAGING-BLOCKER-RESOLUTION-PLAN.md
```

| Item | Initial state |
|---|---|
| Branch | `main` |
| HEAD | `a81d5788069751ed10a52a980add3b4f3c291f39` |
| HEAD parent | `5205f730fd0141fb9c8d0697787b700e4bda04ff` |
| Staged paths | None |
| Modified tracked paths | None |
| Tracked file count | 138 |
| Untracked file count | 2 |
| Recent history | `a81d578`, `5205f73`, `0ac84ba`, `a2c3343`, `245a40f`, `f867f01`, `a86c50b`, `f0322b4`, `808a7bb`, `8340964` |

`a81d578` is the child of `5205f73`; the HEAD recorded in the ORDERS-2.18B
report is its pre-commit snapshot. The current commit contains the remediation
paths `src/storage/cloudinary-policy.ts`, `src/storage/provider.ts`,
`src/platform/vercel.ts`, and `src/index.ts`. The local `origin/main` ref was
not fetched and is not evidence of current GitHub state.

The initial status matches the final status recorded in ORDERS-2.20: the
ORDERS-2.19 and ORDERS-2.20 reports were untracked and no tracked files were
modified. Therefore, the current checkout does not differ from the
ORDERS-2.20 Git baseline at the code level. No previous edits were assumed
committed beyond what HEAD and its parent establish.

## 3. ORDERS-2.20 independent review

| ORDERS-2.20 finding/claim | Classification | Independent evidence and qualification |
|---|---|---|
| Preview uses Vercel's staging database credential path and rejects generic Production Turso credentials. | **CONFIRMED** | `validateCredentialScope`, `runtimeEnvironment`, `databaseCredentials`, and `validateDatabaseConfiguration` in `src/platform/vercel.ts` reject generic Turso variables in Preview and select only staging-specific names after the scope check. This proves local selection logic, not the identity or scope of a configured token. |
| The migration hostname and confirmation fields do not independently prove a remote Turso resource identity. | **CONFIRMED** | `assertTursoStagingConfiguration` in `scripts/staging-config.ts` checks fixed confirmation strings and a staging-host pattern; it does not bind those confirmation strings to provider-verified database/account identity. |
| Preview may resolve its origin from the Production project URL before the Preview deployment URL. | **CONFIRMED** | `originFromEnvironment` in `src/platform/vercel.ts` checks `APP_ORIGIN`, then `VERCEL_PROJECT_PRODUCTION_URL`, then `VERCEL_URL`. Preview does not reject a Production `APP_ORIGIN` or Production project URL. Actual remote values are **INSUFFICIENT EVIDENCE**. |
| Preview cannot use the Vercel Production Cloudinary credential names or current staging Cloudinary configuration. | **CONFIRMED** | `validateCredentialScope`, Preview validation, and `resolveCloudinaryConfiguration` reject the known configuration paths before storage construction. This does not verify remote account identity. |
| Vercel Preview mock storage is ephemeral and Worker R2 is not a Vercel storage provider. | **CONFIRMED** | `createStorage` in `src/platform/vercel.ts` instantiates `MemoryStorageAdapter`; `R2StorageAdapter` in `src/storage/r2.ts` requires a Worker binding and is not selected by Vercel. |
| Preview email is discarded or unavailable and cannot support interactive login. | **CONFIRMED** | `createEmailService` in `src/auth.ts` returns the discard service or `null` for staging. The discard service receives but does not deliver the link. Actual deployed email settings are **INSUFFICIENT EVIDENCE**. |
| Preview has no evidenced independent scheduled lifecycle execution. | **PARTIALLY CONFIRMED** | `vercel.json` has one lifecycle Cron definition; no Preview-specific schedule or deployed execution is evidenced. The authenticated Vercel handler does accept a correctly scoped Preview request, so manual execution is supported by code. Platform/deployment scheduling behavior is **INSUFFICIENT EVIDENCE**. |
| Catalog, payment, and publication mutations are local-only. | **CONFIRMED** | `STANDARD_CATALOG_ENABLED` in `src/product-catalog.ts` is false; local pricing and payment guards are in `src/payments.ts`; `requireLocalPublishing` in `src/publications.ts` rejects non-local mutation requests. |
| Vercel Preview cannot perform real SePay settlement under the current guards. | **CONFIRMED** | `validateCredentialScope` rejects Preview payment/SePay variables; `runtimePaymentMode` only forwards local-development modes; `paymentModeError` also requires local test mode. No Live provider exists in the current payment mode type. |
| Local/remote migration scripts conflict. | **PARTIALLY CONFIRMED** | They do not target the same engine: `scripts/migrate-turso.ts` is local SQLite-only; `scripts/staging-turso.ts` is remote Turso; `db:apply:staging` is remote Worker/D1. Target confusion remains possible if the D1 command is mistaken for Vercel/Turso. |
| Production resources, Preview assignments, account ownership, and remote Cron behavior are isolated. | **INSUFFICIENT EVIDENCE** | No Vercel, Turso, Cloudinary, Cloudflare, email, or payment settings were accessed. Code-level rejection is not provider-side identity evidence. |

The report's final verdict and the listed local blockers are reasonable. The
additional findings in §4 and the legacy Worker caveats in §5 should be added
to the implementation gates before any Preview deployment.

## 4. Confirmed and unconfirmed findings

### Confirmed findings

#### F-01 — Preview origin resolution can select or trust a Production origin

- **Classification:** CONFIRMED code path; deployed impact **INSUFFICIENT EVIDENCE**.
- **Evidence:** `originFromEnvironment` in `src/platform/vercel.ts` gives
  `APP_ORIGIN` precedence, then uses `VERCEL_PROJECT_PRODUCTION_URL` before
  `VERCEL_URL`. The Production-only mismatch check does not apply to Preview.
  `validateVercelEnvironment` validates syntax/presence but not that a Preview
  origin is a Preview deployment origin.
- **Impact:** A missing Preview `APP_ORIGIN` can select the Production project
  origin. A Production `APP_ORIGIN` can also be accepted in Preview. This
  causes same-origin authentication/origin checks to use the wrong origin,
  prevents normal Preview-origin requests from working in some flows, and
  could trust the Production site as a credentialed cross-origin caller to the
  Preview API. It does not by itself select the Production database. The
  Preview email sink currently prevents delivery of a magic link.
- **Tests:** `tests/vercel.test.ts` checks Production origin matching and an
  explicit Preview origin, but does not cover Preview with both Vercel URL
  sources present and no explicit Preview origin, or a Production origin
  supplied as Preview `APP_ORIGIN`.
- **Required action:** Fix and test origin resolution before enabling Preview
  authentication or browser acceptance.

#### F-02 — Turso migration confirmation does not bind to the actual URL target

- **Classification:** NEW FINDING; exact remote target impact
  **INSUFFICIENT EVIDENCE**.
- **Evidence:** `scripts/staging-config.ts` compares
  `TURSO_CONFIRM_DATABASE`, `TURSO_CONFIRM_GROUP`, and
  `TURSO_CONFIRM_REGION` to constants, then independently accepts a URL whose
  hostname matches a broad `crushify-staging-*` pattern. The confirmation
  values are not parsed from or compared to the URL and do not authenticate
  provider account/database identity. `tests/staging-config.test.ts` tests
  rejected production-looking hosts and accepted staging-pattern hosts, but
  not a different staging-pattern database with the same confirmation
  metadata.
- **Impact:** A wrong staging-named Turso database can pass local preflight
  if supplied alongside the expected confirmation strings. Whether it is
  shared with or contains Production data cannot be learned locally.
- **Required action:** Owner-verify the provider resource and token scope;
  pin an exact approved non-secret target identity for the migration
  preflight. Treat hostname pinning as accidental-target protection, not proof
  of account separation.

### New conditional legacy Worker findings

These are not findings about the Vercel Preview adapter. The intended staging
target is Vercel Preview, and the repository's Wrangler configs contain no
Cron trigger. The actual Cloudflare deployment and secrets were not inspected.

#### F-03 — Legacy Worker scheduled handler has no environment/resource scope guard

- **Classification:** NEW FINDING, conditional on deploying/enabling the
  legacy Worker scheduler.
- **Evidence:** `scheduled()` in `src/index.ts` checks only that the database
  provider is D1, constructs storage from the binding, then calls
  `recoverPendingFulfillments` and `runPublicationLifecycle`. It does not
  validate a Worker environment pairing, D1 resource identity, or storage
  identity. The Wrangler files have no configured Cron trigger in the current
  checkout.
- **Impact:** If a future Worker staging Cron is enabled with a Production D1
  or R2 binding, it could recover or clean Production records/assets. The
  current Vercel Cron route has separate environment and credential checks.
- **Required action:** Keep the Worker scheduler disabled for Vercel Preview.
  If Worker staging is retained, add explicit runtime-scope checks and verify
  its D1/R2 binding identities before enabling a trigger.

#### F-04 — Legacy Worker publication guard treats a missing environment as local

- **Classification:** NEW FINDING, conditional on mis-scoped Worker
  configuration.
- **Evidence:** `localPublishingEnabled` in `src/publications.ts` accepts
  `LOCAL_TEST_MODE` when `ENVIRONMENT` is either local or undefined. The
  default `wrangler.jsonc` does not declare an `ENVIRONMENT` key. Vercel
  avoids this path by constructing a validated `Env`; the Cloudflare Worker
  handler passes its environment directly to `handleApiRequest`.
- **Impact:** If a Worker with a non-local D1 binding were given the local
  test-mode flag while its environment marker were absent, publication
  mutations would pass this guard. No such remote assignment or deployment
  was inspected; the key is absent from the checked-in Wrangler config.
- **Required action:** In deployed Worker paths, require an explicit local
  environment marker for local test mode; reject missing/unknown scope and
  local test flags in any staging/Production Worker.

### Not confirmed / insufficient evidence

| Question | Classification | Finding |
|---|---|---|
| Does Vercel Preview select generic Production Turso credentials when they are present? | **NOT CONFIRMED** | Current Vercel guard rejects their presence before connection and chooses staging-specific names. Actual staging values, token rights, and target identity are unknown. |
| Can ordinary Vercel Preview select Cloudinary or silently fall back to another provider? | **NOT CONFIRMED** | Cloudinary and unsupported provider choices fail closed; explicit mock is the only supported Preview choice in the current factory. |
| Can the deployed Preview send real customer email? | **INSUFFICIENT EVIDENCE** | Vercel code does not forward generic mail credentials to Preview and the staging email service discards/returns unavailable. Actual deployment values and project wiring were not inspected. |
| Does Preview have an independent Cron schedule? | **INSUFFICIENT EVIDENCE** | No Preview-specific Cron is in repository configuration and no deployed invocation was observed. The code supports a manual, authenticated Preview call. |
| Are the staging Turso, Cloudinary, R2, email, and payment resources separate from Production? | **INSUFFICIENT EVIDENCE** | No provider resource or dashboard was accessed. |
| Are all five editor flows already ready for remote acceptance? | **INSUFFICIENT EVIDENCE** | Historical reports contain local browser evidence with incomplete per-template saved-field reload evidence; no current Preview exists in verified evidence. |

## 5. Preview / Production security boundary analysis

| Resource | Preview expected | Production expected | Current isolation | Risk |
|---|---|---|---|---|
| Runtime identity | Protected Vercel Preview with staging scope | Vercel Production with production scope | Vercel validates deployment/environment pairing; no remote project or branch policy inspected | **PARTIAL** — Preview origin bug; project/deployment protection unknown |
| Origin and callbacks | Exact deployment Preview origin | Exact Production origin | Origin may prefer Production URL or accept a Production `APP_ORIGIN` in Preview | **CONFIRMED** code risk; no remote values checked |
| Database | Dedicated Turso staging DB and scoped token | Dedicated Production DB and scoped token | Vercel selects different variable names and checks a staging hostname pattern | **PARTIAL** — token/resource identity not proven; staging URL can be wrong |
| Storage | Explicit isolated persistent staging provider; mock only for ephemeral smoke | Production provider/account | Vercel Cloudinary is blocked in Preview; mock is in-memory; R2 requires Worker binding | **PARTIAL** — no persistent Vercel Preview store |
| Email | Discard or capture-only staging sandbox for synthetic recipients | Production sender/provider | Vercel Preview does not forward generic mail settings; `createEmailService` discards or disables | **PASS — local Vercel policy**, remote configuration unknown |
| Payments | Disabled by default; future synthetic or verified provider Test mode | Live payment only after separate implementation/review | Preview payment settings are rejected; payment handler is local-only; Live mode absent | **PASS — disabled in Preview**, but no functioning production checkout |
| Sessions and cookies | Preview session rows in staging DB, host-only secure cookies | Production session rows in Production DB | Session tokens are hashed and cookies are host-only; actual DB separation is unverified | **PARTIAL** — follows database isolation; origin bug |
| Publication mutations | Synthetic Preview rows only | Production behavior only after payment/publication launch | Vercel publication mutations are local-only; legacy Worker can bypass Vercel scope | **PARTIAL** — Preview flow unavailable; Worker caveats F-03/F-04 |
| Vercel Cron | Preview-only secret and staging DB/storage | Production-only secret and Production DB/storage | Handler validates bearer secret and Vercel scope; `vercel.json` declares one schedule | **PARTIAL** — no Preview schedule or remote execution evidence |
| Legacy Worker scheduler | Disabled or isolated D1/R2 resources | Explicitly managed legacy/rollback path | `scheduled()` checks D1 provider but not environment/resource identity | **NEW CONDITIONAL RISK** if Worker Cron is activated |
| Logs | Sanitized, access-limited Preview logs | Sanitized, access-limited Production logs | `logSafeError` allowlists fields; API catch logs request ID only | **PASS — local application paths**; remote retention/access unverified |

### Fail-closed policy required before staging

1. **Vercel identity:** Accept only a supported `VERCEL_ENV` and its matching
   explicit application environment. Reject missing, unknown, or conflicting
   scope. Verify the approved Vercel project/deployment identity and protected
   branch policy before any staging capability is enabled.
2. **Origin:** In Preview, use the deployment-specific Preview origin or an
   owner-approved exact Preview alias. Reject a Production URL or a
   Production `APP_ORIGIN`; do not use the Production project URL as a
   Preview fallback. An explicit override may only equal an approved Preview
   origin.
3. **Database:** Preview uses only the staging Turso variables and an
   owner-verified DB-scoped token. Reject generic Production variables and
   unknown hostnames before connecting. Pin an exact non-secret expected host
   for accidental-target prevention; independently verify the provider account
   and resource because hostname/variable names cannot prove ownership.
4. **Storage:** Require an explicit provider selection. Until staging
   Cloudinary account separation is independently verified, reject it. Do not
   silently substitute R2, mock, or Production storage for a failed provider.
   The existing mock may be chosen explicitly only for non-persistent tests.
5. **Email:** Preview defaults to unavailable/discard. A future sandbox must
   have separate credentials and provider-side plus code-level recipient
   restrictions. Reject Production mail credentials in Preview.
6. **Payment:** Preview defaults to disabled. Reject Production/Live
   credentials and all local test flags. A future synthetic or Test mode must
   require the verified Preview scope and DB identity; no ordinary public
   endpoint may mark an order paid.
7. **Lifecycle:** Vercel Cron/manual calls must validate the same environment
   and DB/storage selection as application requests, and use unique,
   environment-specific secrets. Keep the legacy Worker scheduler disabled
   unless separately guarded and approved.
8. **Production:** Reject staging-only and local-test settings rather than
   silently ignoring them. Keep Production payment and publication changes
   out of this staging implementation.
9. **Legacy Worker:** Do not use the Worker as a Vercel fallback. If it is
   retained, require an explicit Worker environment marker and independently
   verified D1/R2 bindings; missing or unknown scope must fail before API or
   scheduled work.

These controls prevent ordinary code/configuration fallback paths. They cannot
prove that a token was not copied or that a staging-named resource is not
Production data. Provider-side ownership checks and least-privilege
credentials remain necessary.

## 6. Local / Preview / Production feature flags

| Feature | Local | Preview | Production | Current state and safety |
|---|---|---|---|---|
| Catalog/pricing | Local-only test overrides and fixtures | Disabled | Disabled in current catalog | `STANDARD_CATALOG_ENABLED` is false; local pricing depends on local test flags. The code makes the gate explicit, but the product rationale/launch approval is not evidenced. |
| Payment | Local mock or local SePay Test contract | Disabled | Disabled; no Live mode | Payment handler requires local test mode. Vercel forwards payment settings only to local development. Do not treat this as Production checkout readiness. |
| Publication mutations | Local test mode only | Disabled | Disabled | `requireLocalPublishing` rejects non-local environments, but its `ENVIRONMENT`-missing compatibility path is unsafe for a deployed legacy Worker with local test mode. |
| Storage | Explicit local adapter | Explicit mock only; ephemeral | Explicit Production provider | Do not use local flags to enable Preview storage. Persistent Preview storage is a separate prerequisite. |
| Email | Local loopback/injected sink | Discard/unavailable | Production mail provider when configured | Vercel Preview cannot use Production mail through the current adapter. A Worker missing its scope marker has a conditional generic-provider fallthrough. |

### Proposed future semantics (not implemented or configured)

Do not reuse `LOCAL_TEST_MODE` to unlock Preview. Use separate, enumerated
staging capability modes, all defaulting to **disabled**:

- `STAGING_CATALOG_MODE`: `disabled` or `synthetic-only`. The synthetic catalog
  must be clearly marked test-only and cannot enable Production prices/CTAs.
- `STAGING_PAYMENT_MODE`: `disabled`, `signed-mock`, or `sepay-test`.
  `signed-mock` uses a staging-only signing secret and authenticated test
  harness. `sepay-test` is permitted only after a separate provider Test-mode
  account/callback is owner-verified. Neither mode accepts Live credentials.
- `STAGING_PUBLICATION_MODE`: `disabled` or `synthetic-only`; permits
  publication mutations only for synthetic staging orders settled by the
  approved staging payment mode.

These are proposed enum semantics, not current environment values. Any unknown
value fails environment validation. Their presence outside the protected
Preview scope fails startup. Activation also requires the exact Preview
origin, verified staging database identity, and selected isolated storage;
flags alone never assert isolation. Production rejects every staging/local
flag. Production remains payment-disabled until a separate Live payment
implementation and authorization.

## 7. Database and migration architecture

### Current selection and target validation

- `connectDatabaseFromEnvironment` in `src/database/provider.ts` selects only
  explicitly configured D1 or Turso; it does not silently fall back between
  adapters. D1 requires a binding; remote Turso requires a URL and auth token.
- The Vercel adapter does not call that generic selector with uncontrolled
  Production values: after validation it maps the Preview Turso staging names
  into the generic connection interface. Production uses the generic
  Production Turso names.
- `validateDatabaseConfiguration` in `src/platform/vercel.ts` checks protocol,
  credentials embedded in URL, query/hash, token presence, and a staging
  hostname pattern. It prevents obvious Production hostnames from passing but
  cannot prove the account/resource or token scope.
- `scripts/staging-config.ts` requires explicit operator confirmations, a
  profile, and a staging URL pattern. The confirmations are not cryptographically
  or structurally bound to the URL.
- `scripts/staging-turso.ts` has separate `--preflight` and `--migrate` modes.
  Preflight reads migration ledger, foreign-key state, and schema; migration
  requires a separate confirmation and then verifies checksums/schema.
- `scripts/migrate-turso.ts` is **local SQLite only**: it requires a `file:`
  URL and rejects a remote auth token. It creates the local parent directory
  and writes local data if run; it was not run here.
- `db:apply:staging` in `package.json` invokes remote Wrangler D1 migrations
  using the Worker staging config. This is a separate backend, not a second
  Turso migration script.
- `applyMigrations` in `src/database/migrations.ts` validates sequential
  versions and checksums, refuses an unknown schema/empty existing ledger,
  applies each migration inside its own write transaction, and verifies
  foreign keys. A later migration failure can leave earlier migration
  transactions committed; reruns are ledger-aware, but the batch is not one
  global transaction.
- There are eight checked-in SQL migrations at this HEAD. No remote schema,
  account, migration ledger, backup, or restore was checked.

### Recommended authoritative procedure

For Vercel Preview/Turso, use exactly:

1. Owner verifies the exact Turso account, DB identity, region, scoped token,
   and empty/synthetic staging target.
2. Run `db:preflight:turso:staging` only after a separately authorized,
   read-only remote preflight is approved. Review the non-secret target
   identity, migration ledger, pending versions, and schema check.
3. Obtain explicit user authorization for the staging write.
4. Run `db:migrate:turso:staging` against the same owner-verified target.
5. Verify the ledger/checksums/schema and synthetic application health.
6. Stop on any identity or checksum mismatch; follow a staging-only restore
   or forward-fix plan.

Keep `db:migrate:turso` for local SQLite only. Retain the Wrangler D1 command
only if Worker staging is separately selected; rename/document it as an
explicit Worker/D1 path and add its own target verification. Do not use D1
migrations for Vercel Preview.

## 8. Persistent staging storage recommendation

| Option | Persistence | Isolation | Upload/deletion/public delivery | Runtime/operations |
|---|---|---|---|---|
| Cloudinary separate staging account | Durable | Strongest if account and credentials are independently verified; current staging policy blocks it | Existing adapter signs authenticated originals, creates public derivatives separately, validates provider metadata, and supports deletion/retry flows | Existing Vercel-compatible adapter; requires deliberate policy re-enable and account verification |
| R2 staging bucket | Durable | A separate bucket and binding are useful boundaries, but account/binding identity still needs owner verification | Existing R2 adapter validates keys/types/sizes, stores private objects, serves derivatives through the Worker path, and deletes through the binding | Existing adapter is Cloudflare Worker-bound; it is not a Vercel adapter |
| Memory/mock storage | No cross-invocation persistence | Isolated in process | Supports synthetic upload/read/delete contracts only | Already supported by Vercel Preview; unsuitable for durable edit/reload/publication-media acceptance |

**Primary recommendation:** a separate Cloudinary staging account/cloud with
distinct account-scoped credentials, after independent owner verification.
Cloudinary remains disabled until verification and code review approve a
staging-specific path. A different cloud name or folder alone is insufficient.

**Fallback:** if the owner chooses not to use Cloudinary, either retain mock
storage and explicitly exclude persistent-media acceptance, or use the existing
R2 implementation on a separately isolated Worker staging deployment. For
Vercel Preview to use R2, a Vercel-compatible R2/S3 adapter must first be
designed and reviewed; the current Worker binding cannot be reused as though
it were a Vercel binding.

Cloudinary and R2 pricing, quotas, free tiers, egress, transformation costs,
and backup/versioning were not checked. Do not invent a free-tier assumption.

## 9. Authentication and email recommendation

### Current behavior

- Vercel Preview rejects generic mail credentials in
  `validateCredentialScope` and only forwards the explicit discard setting.
- `createEmailService` in `src/auth.ts` returns a discard service or no service
  for staging. With no service, login fails before token/customer creation.
  With the discard service, login can return an accepted response but no usable
  link is delivered.
- Login tokens are random, stored hashed, sent only to the email service, and
  consumed once with an expiry. `logSafeError` excludes message/stack/context;
  `api/[...path].ts` logs a generated request ID only. No runtime path found
  returning the raw magic token in an API response.
- Session cookies are host-only, HttpOnly, SameSite-limited and Secure outside
  local development. Session records are stored in the selected database;
  separate cookies do not compensate for a shared database.
- The origin bug F-01 prevents treating Preview callback and CORS behavior as
  safe until fixed.
- In the legacy Worker path, `src/index.ts` does not validate environment
  pairing before passing `Env` to the API. `createEmailService` uses the
  staging discard behavior when the staging marker is present, but may fall
  through to a generic configured provider if the marker is missing. The
  checked-in staging Wrangler file has an environment marker; remote secrets
  and deployment state are unknown.

### Recommendation

Prefer a dedicated capture-only email sandbox/provider account with:

- credentials separate from Production and absent from Production Preview
  scopes;
- provider-side capture/allowlist that cannot deliver to arbitrary customer
  addresses;
- a matching code-level allowlist of synthetic tester identities;
- Preview-only callback origin and protected Preview deployment;
- token expiry and one-time verification unchanged; no public token-retrieval
  endpoint and no full-link logging.

If a capture-only provider cannot be verified, keep Preview login disabled and
use a protected test harness/sink that is not exposed as a public endpoint.
Do not use Production Resend credentials for Preview. No email was sent or
provider tested.

## 10. Preview publication lifecycle

- `vercel.json` contains one lifecycle Cron route and schedule; it does not
  declare a separate Preview schedule. No deployed Cron attachment or
  execution was inspected.
- `createVercelApiHandler` accepts the lifecycle route only with a valid
  bearer secret and a matching Preview/staging or Production pair, then
  validates database/storage config before work. `secureSecretMatch` rejects
  missing secrets and secrets shorter than 32 characters.
- The manual Preview route is therefore supported by code when independently
  configured with a Preview-only secret and verified staging DB/storage.
  That is not evidence of an unattended schedule.
- `runScheduledPublicationLifecycle` uses a persisted five-minute lease and
  run records, with bounded retryable lifecycle work. The Vercel route runs
  publication lifecycle; it does not recover pending payment fulfillment.
- `getPublicPublication` checks status and expiry on each read and returns
  unavailable/410 behavior for expired content even if cleanup has not run.
  Public asset access also checks publication state and expiry. Physical
  cleanup is not guaranteed by read-time denial.
- The legacy Worker `scheduled()` handler also calls pending-fulfillment
  recovery and lifecycle cleanup, but has no environment/resource guard.
  Current Wrangler configuration declares no Cron trigger. Keep that path
  disabled unless separately isolated and reviewed.

**Recommendation:** use the authenticated manual Preview route for a finite
controlled test, with a unique Preview secret and staging-only DB/storage.
For recurring staging cleanup, choose a dedicated scheduler only after
verifying platform support, access scope, retry behavior, and plan limits.
Keep Production's existing Vercel schedule unchanged. Do not claim Preview
cleanup has run until there is an observed staging result.

## 11. SePay Test-mode isolation

### Current contract

- The provider abstraction in `src/payments/provider.ts` currently supports
  `mock` and `sepay-test`; no Live payment mode is implemented.
- `verifySePaySignature` in `src/payments/sepay.ts` verifies HMAC-SHA256 over
  the timestamp and exact raw body, enforces format and freshness, and uses a
  constant-time comparison for equal-length digests.
- `paymentModeError` in `src/payments.ts` requires local test mode; the webhook
  validates signature before parsing/settling.
- `webhookMismatch` checks incoming transfer, configured receiving account,
  exact payment reference, VND, order/payment/snapshot amount equality, and
  transfer amount. Processing rejects non-pending, expired, review-required,
  or already-paid orders. Unique event and transaction constraints plus
  conditional state updates protect replay/idempotency.
- Vercel Preview rejects payment and SePay configuration and does not forward
  it. Production payment handling is also disabled by the app's local-only
  payment guard. Thus Test callbacks cannot settle either Preview or
  Production orders in the current Vercel flow.
- Raw webhook data is stored in the payment event table for retry/review;
  access and retention need a separate operational policy. It is not explicitly
  logged by the reviewed payment path.

### Future verification plan (not executed)

1. Keep all Preview payment settings absent until the synthetic-only flag and
   exact staging resource guard are reviewed.
2. First test the staging signed-mock flow using only synthetic users, orders,
   a staging-only HMAC key, and a signed test harness. Test replay,
   transaction reuse, wrong amount/currency/account/reference, order ownership,
   expiry, and retry.
3. If SePay provider Test Mode is separately approved, provision a Test-mode
   account/bank mapping and a Preview-only callback URL/secret; confirm exact
   Test account identity before configuring anything. Do not reuse Live
   credentials.
4. Preserve HMAC verification, timestamp window, receiving account,
   payment-reference, currency/amount/snapshot, state, expiry, transaction-ID,
   event-ID, and idempotency guards. No query parameter or client callback may
   mark an order paid.
5. Verify a signed Test-mode event reaches only the isolated staging database
   and cannot be accepted by Production. This requires an authorized test
   transaction/provider callback and is not permitted by this read-only review.
6. Keep Production payments disabled until a separate Live integration,
   reconciliation, refund, support, monitoring, and authorization review.

No SePay provider was contacted and no payment or webhook was created.

## 12. Dependency-aware implementation roadmap

Every item below is future work. No implementation or remote operation was
performed. “Preview acceptance” means an authorized deployment-level test
after local gates; it is not a current result.

### T01 — Establish runtime identity and environment isolation

- **Objective:** Centralize fail-closed Vercel identity and explicitly fence
  the legacy Worker path.
- **Files likely to change:** `src/platform/vercel.ts`, `src/index.ts`,
  `src/types.ts`, `src/publications.ts`, `tests/vercel.test.ts`,
  `tests/worker.test.ts`, `tests/publications.test.ts`,
  `docs/VERCEL_STAGING.md`.
- **Prerequisites:** Owner confirms Vercel/Turso as the intended staging path
  and decides whether Worker staging is retained or disabled.
- **Security risks:** An environment label alone is self-attestation; a
  staging-named URL/token can still reference an unexpected resource.
- **Approval:** Owner approves project/environment identity and any Worker
  deprecation or isolation boundary.
- **Steps:** Require supported explicit deployment/environment pairing;
  reject unknown/missing scope; reject all cross-scope/local flags; define
  which project/deployment identity is trusted; fail before database, storage,
  email, or scheduled work. For Worker deployments, require explicit scope,
  make local publication mode require an explicit local marker, and guard
  `scheduled()` before D1/R2 work.
- **Unit tests:** Missing/unknown/mismatched scopes; copied generic Production
  credentials in Preview; staging values in Production; wrong Vercel project;
  missing Worker scope; local test flags on Worker Production binding.
- **Integration tests:** Invoke Vercel and Worker API/scheduler factories with
  local mocks and assert rejection happens before connection/storage creation.
- **Preview acceptance:** Negative requests prove Production database,
  storage, email, payment, and Worker paths are not selected.
- **Rollback:** Keep the deployment disabled/protected; revert only the
  reviewed identity-gate change if it blocks the intended local path. Never
  bypass it with a flag.

### T02 — Correct Preview origin and callback validation

- **Objective:** Remove Production-origin fallback and establish exact
  Preview-origin behavior.
- **Files likely to change:** `src/platform/vercel.ts`, `src/auth.ts`,
  `src/http.ts`, `tests/vercel.test.ts`, `tests/pre-staging-security.test.ts`.
- **Prerequisites:** T01's deployment identity semantics.
- **Security risks:** Incorrect CORS trust, failed login, or Preview requests
  accepted from the Production origin.
- **Approval:** Owner approves the Preview hostname/alias policy; no domain
  change is authorized by this blueprint.
- **Steps:** Use the deployment-specific Preview origin; reject Production
  project origin and Production `APP_ORIGIN` in Preview; allow explicit
  overrides only through an exact approved-origin rule; ensure auth links and
  CORS use the same validated origin.
- **Unit tests:** No explicit origin with both platform URL variables; explicit
  Preview origin; Production origin override; malformed values; callback link
  construction; preflight and credentialed-origin rejection.
- **Integration tests:** Mock mail adapter verifies generated links use the
  Preview origin and that tokens are absent from API response/log records.
- **Preview acceptance:** Browser preflight/login and session endpoints accept
  only the approved Preview origin.
- **Rollback:** Revert the origin logic while leaving Preview login disabled;
  do not restore the Production URL fallback.

### T03 — Separate Local, Preview, and Production feature modes

- **Objective:** Enable only explicitly approved synthetic Preview catalog,
  payment, and publication behavior without weakening Production.
- **Files likely to change:** `src/product-catalog.ts`, `src/payments.ts`,
  `src/payments/provider.ts`, `src/platform/vercel.ts`, `src/publications.ts`,
  `src/types.ts`, `tests/payments.test.ts`, `tests/publications.test.ts`,
  `tests/vercel.test.ts`, `tests/payment-contract.mjs`.
- **Prerequisites:** T01/T02; owner approves synthetic checkout scope; T04
  staging database identity before any Preview activation.
- **Security risks:** A public test-settlement path or copied flag could mark
  real orders paid; real catalog values could be mistaken for an offer.
- **Approval:** Explicit decision to allow protected Preview synthetic order
  and publication mutations. No real payment authorization is included.
- **Steps:** Preserve current local flags for local only. Add separate
  fail-closed staging enum modes described in §6; default every mode disabled;
  reject them outside Preview; require verified resource identity; synthetic
  settlement is signed/test-harness-only and cannot process non-test orders.
  Production rejects every staging/local flag and remains payment-disabled.
- **Unit tests:** Allowed/unknown/contradictory mode values; Preview boundary;
  Production rejection even when staging mode is present; client amount
  tampering; unsigned/replayed synthetic settlement.
- **Integration tests:** Local synthetic database order → signed mock event →
  one fulfillment/publication; Production and unknown scopes fail closed.
- **Preview acceptance:** Synthetic-only orders can be created and published
  under approved Preview access, with no SePay Live credentials or funds.
- **Rollback:** Disable staging modes first; reject further synthetic events;
  preserve paid/production architecture and clean only known synthetic rows.

### T04 — Provision and verify Turso staging identity

- **Objective:** Establish an isolated, scoped database and bind application
  and migration checks to the approved target.
- **Files likely to change:** `src/platform/vercel.ts`,
  `scripts/staging-config.ts`, `scripts/staging-turso.ts`,
  `tests/vercel.test.ts`, `tests/staging-config.test.ts`,
  `docs/VERCEL_STAGING.md`.
- **Prerequisites:** Owner provisions/approves a separate Turso DB, account,
  region, scoped token, backup, and non-secret identity.
- **Security risks:** Staging hostname/variable names may not prove resource
  ownership or token scope.
- **Approval:** Explicit remote preflight; separate explicit approval before
  any migration or synthetic write.
- **Steps:** Pin an owner-approved exact hostname/non-secret identity; verify
  staging credential names only; reject all generic Production fallback;
  validate target before adapter connection; document that account ownership
  is verified through provider-side review, not a marker alone.
- **Unit tests:** Host/identity exact match; wrong staging-named host; missing
  credentials; Production host; conflicting credentials; fail before
  connection.
- **Integration tests:** Use an isolated local Turso-compatible DB and fake
  identity provider; never use remote services in automated tests.
- **Preview acceptance:** An authorized read-only health query reaches only the
  separately verified staging DB; synthetic marker/query does not appear in
  Production.
- **Rollback:** Remove Preview-only credentials, disable deployment, revoke
  only staging token. No Production database fallback.

### T05 — Make Turso the single authoritative Vercel staging migration path

- **Objective:** Prevent operators confusing local Turso, remote Turso, and
  legacy Worker D1 migrations.
- **Files likely to change:** `scripts/staging-config.ts`,
  `scripts/staging-turso.ts`, `scripts/migrate-turso.ts`, `package.json`,
  migration docs, `tests/staging-config.test.ts`,
  `tests/migrate-turso.test.ts`.
- **Prerequisites:** T04 identity verification and backup/recovery ownership.
- **Security risks:** Wrong-target writes or partially applied migration
  sequences.
- **Approval:** Explicit authorization for a remote staging migration after
  preflight; no Production migration authorization.
- **Steps:** Make exact host identity part of preflight; retain
  `scripts/migrate-turso.ts` as local-only; clearly label/guard Wrangler D1 as
  separate Worker staging; document `preflight` then `migrate` procedure and
  per-migration transaction recovery.
- **Unit tests:** Target mismatch/no-write; checksum drift; partial migration
  recovery; already-applied migrations; local command rejects remote URL/token;
  D1 command cannot be mistaken for Vercel/Turso.
- **Integration tests:** Use temporary local DB only; verify ledger and schema
  with no provider credentials.
- **Preview acceptance:** After authorization, schema/checksum/foreign-key
  evidence matches the repository on the isolated Preview DB.
- **Rollback:** Stop before writes on mismatch; use the approved staging
  restore or forward-fix, never point to Production or reverse SQL blindly.

### T06 — Provision persistent staging storage

- **Objective:** Add durable media persistence for Vercel Preview without
  sharing Production assets.
- **Files likely to change:** `src/storage/cloudinary-policy.ts`,
  `src/platform/vercel.ts`, `src/storage/provider.ts`, storage tests,
  `wrangler.staging.jsonc` only if Worker fallback is selected,
  `docs/VERCEL_STAGING.md`.
- **Prerequisites:** Owner selects Cloudinary or R2 option and verifies
  separate account/bucket identity; T01 environment gates.
- **Security risks:** Cloudinary credential reuse or wrong bucket binding could
  upload/delete Production assets; public derivatives could be misconfigured.
- **Approval:** Cloudinary requires independent owner account verification and
  approval to re-enable; R2 Worker option requires an architecture decision.
- **Steps:** Prefer separate Cloudinary account/cloud with distinct
  credentials. Re-enable staging only through a complete reviewed policy, not
  a boolean assertion. If R2 is chosen, use a dedicated bucket and explicit
  Worker binding; for Vercel, build/review a compatible adapter rather than
  reusing Worker-only code.
- **Unit tests:** Provider factory/adapter and direct runtime paths reject
  unsafe config; no fallback; private original/public derivative split;
  upload/deletion failures remain retryable.
- **Integration tests:** Fake provider/local binding; synthetic image only.
- **Preview acceptance:** Upload, reload from a different invocation, publish
  derivative, expire, delete/retry using only the verified staging resource.
- **Rollback:** Disable uploads and provider selection, revoke staging-only
  credentials, remove only identified synthetic assets through the approved
  provider path.

### T07 — Enable safe interactive Preview authentication

- **Objective:** Let synthetic test users sign in without delivering email to
  real customers or leaking bearer tokens.
- **Files likely to change:** `src/auth.ts`, `src/platform/vercel.ts`,
  `src/types.ts`, `src/logging.ts`, `tests/vercel.test.ts`,
  `tests/pre-staging-security.test.ts`, email-sink tests.
- **Prerequisites:** T02 origin fix, T04 DB isolation, deployment access
  protection; owner provisions a capture-only sandbox if selected.
- **Security risks:** Real recipient delivery, link/token disclosure, or
  session/database sharing.
- **Approval:** Owner approves sandbox/provider, synthetic-recipient
  allowlist, and Preview access control.
- **Steps:** Add separate sandbox credentials and recipient allowlist; validate
  allowlist before customer/token creation; preserve hashed one-use token,
  expiry, rate limits, CSRF, secure cookies; do not expose token via API or
  logs. If provider sandbox unavailable, keep login disabled and use a
  protected test harness.
- **Unit tests:** Allowed and rejected recipients; mail delivery failure
  cleanup; token expiry/replay; response/log redaction; Production credential
  rejection.
- **Integration tests:** Capture-only local adapter, no external email call;
  confirm session rows are in the staging test DB.
- **Preview acceptance:** Only synthetic allowlisted testers receive/use a
  Preview link; callback is Preview-only; no real customer email is sent.
- **Rollback:** Disable Preview login and revoke sandbox credentials; do not
  expose already-issued tokens or route Preview links to Production.

### T08 — Establish independent Preview lifecycle execution

- **Objective:** Run expiry and cleanup on staging resources without touching
  Production.
- **Files likely to change:** `src/platform/vercel.ts`, `src/index.ts`,
  `src/scheduler.ts`, `src/publications.ts`,
  `api/cron/publication-lifecycle.ts`, scheduler tests,
  `vercel.json` only if a verified schedule is approved.
- **Prerequisites:** T01 scope guard, T04/T05 database and schema, T06
  persistent storage if testing asset cleanup.
- **Security risks:** Cross-scope cleanup, reused secret, double scheduler,
  or mistaken Preview run on Production bindings.
- **Approval:** Owner approves manual invocation or dedicated scheduler and
  provisions a unique Preview secret.
- **Steps:** Initially use the existing manual authenticated route; verify
  scope/DB/storage before work. Add the F-03 Worker guard before any Worker
  trigger. Use a separate scheduler only if Preview support is established.
- **Unit tests:** Missing/invalid secret, wrong environment, wrong DB, repeated
  run, lease contention, retryable deletion, expired reads before cleanup.
- **Integration tests:** Synthetic isolated DB/storage; never invoke a remote
  Cron in test suites.
- **Preview acceptance:** Observed staging run expires only staging records,
  denies expired reads independently, and retries cleanup idempotently.
- **Rollback:** Stop scheduler, rotate only Preview secret, disable the
  Preview trigger; leave Production Cron unchanged.

### T09 — Add isolated SePay Test-mode verification (optional)

- **Objective:** Verify provider Test callbacks only after synthetic staging
  checkout and environment isolation work.
- **Files likely to change:** `src/payments/sepay.ts`,
  `src/payments/provider.ts`, `src/payments.ts`,
  `src/platform/vercel.ts`, `src/types.ts`,
  payment/security tests, `docs/SEPAY_SETUP.md`.
- **Prerequisites:** T01/T03/T04/T05; authorized SePay Test account, test
  account/bank mapping, callback URL, and separate secret.
- **Security risks:** Test callback routed to Production, accepting unsigned
  events, or treating a test transaction as Live payment.
- **Approval:** Explicit provider-owner authorization for Test Mode and any
  externally reachable callback. No Live transaction approval is included.
- **Steps:** Add explicit Preview-only Test-mode configuration; keep mock
  mode separate; reject Live and generic Production values; preserve HMAC,
  account/reference/amount/expiry/idempotency/ownership checks; verify the
  staging endpoint/database before accepting a callback.
- **Unit tests:** Signature failures, altered body/timestamp, amount/currency/
  account/reference mismatch, replay, wrong order, expiry, duplicate and
  Production-scope rejection.
- **Integration tests:** Signed synthetic payloads and local database first;
  provider callback only in a separately authorized manual verification.
- **Preview acceptance:** Provider Test event appears only on a synthetic
  staging order and cannot settle a Production order.
- **Rollback:** Disable Test-mode configuration, revoke the staging secret,
  reject additional callbacks, and reconcile only synthetic test events.

### T10 — Run full Preview end-to-end acceptance

- **Objective:** Collect objective remote Preview evidence after all prior
  dependencies pass.
- **Files likely to change:** Browser/integration fixtures and a new QA
  evidence report only; no unreviewed source change during the run.
- **Prerequisites:** T01–T08 complete; T09 only if provider Test Mode is in
  scope; owner explicitly authorizes Preview deployment and test data.
- **Security risks:** Testing against wrong environment, real email/payment,
  customer data, or cross-resource asset deletion.
- **Approval:** Explicit staging deployment and test-run authorization;
  Production operations remain separately prohibited.
- **Steps:** Test all five templates, edit/save/reload/preview, catalog,
  synthetic checkout, payment/webhook failure matrix, publication URL,
  expiry, lifecycle cleanup, media persistence, logs, cookies, CSRF, and
  provider isolation. Use synthetic identities/assets only.
- **Unit tests:** Run targeted tests changed by prior tasks and current
  typecheck.
- **Integration tests:** Run against an isolated local fixture before remote
  Preview. Run remote browser checks only after resource identities and
  deployment are approved.
- **Preview acceptance:** Every criterion in §13 has separately labeled local
  and actual Preview evidence; Production is not touched.
- **Rollback:** Stop on identity mismatch, real-recipient delivery, unexpected
  provider call, cross-environment access, failed expiry, or unexpected
  Production signal; disable Preview features and clean only known synthetic
  staging data.

### Dependencies and safe parallelism

- **Sequential hard gates:** T01 → T02 → T03/T04; T04 → T05; T04/T05/T06 →
  T07/T08; T03/T04/T05 plus provider authorization → T09; all required tasks
  → T10.
- **Potentially parallel after architecture decisions:** Provider-side Turso
  provisioning (T04) and Cloudinary/R2 account planning for T06 are
  independent. Local test design for T03 can proceed while T04 provisioning
  occurs, but no Preview mode may be activated until T04 passes.
- **Avoid parallel edits:** T01 and T02 both touch `src/platform/vercel.ts`;
  sequence or coordinate the same file to avoid conflicting environment and
  origin semantics.
- **No task may deploy, migrate, contact providers, or issue a real payment
  without the explicit approval listed for that task.**

## 13. Staging acceptance criteria

The following are **not currently met by remote evidence**. Maintain two
evidence columns when this roadmap is executed: local synthetic and actual
Preview.

| Criterion | Local synthetic evidence required | Actual Preview evidence required |
|---|---|---|
| Preview origin | Handler tests prove Preview origin selection and Production rejection | Protected deployment URL, browser requests, callbacks, and CORS use only approved Preview origin |
| No Production fallback | Environment tests reject generic Production credentials/settings | Owner verifies Preview assignments by names/scope and selected resource identities |
| Database isolation | Mocked/local tests prove scope guard and wrong-target fail-before-connect | Provider owner verifies separate DB/account/token scope; health and synthetic data query hit only staging |
| Migration target | Local script tests prove wrong target/no write and checksum behavior | Authorized preflight and migration record show only the approved staging DB changed |
| Persistent storage | Adapter tests prove authentication, key boundaries, deletion/retry | Synthetic upload survives a separate invocation, private original remains private, derivative and cleanup stay in staging account |
| Safe login | Local tests prove allowlist, one-time token, expiry, cookies, redaction | Synthetic tester signs in through Preview; no real customer email, no Production callback/session |
| Five templates | Local/browser harness verifies template-level edit/save/reload/preview | Each of Our Universe, Love Letter, Our Memories, Say Yes, and Distance Means Nothing completes the same protected Preview flow |
| Checkout | Local contract checks server amount/ownership and tampering | Synthetic Preview order uses test catalog and approved mock/Test mode; no real funds |
| Webhook | Synthetic HMAC, mismatch, expiry, ownership, replay, concurrency and retry tests | If Test Mode is authorized, signed callback reaches only staging; if not, Preview remains mock-only and that limitation is recorded |
| Publication | Local paid-evidence gate and lifecycle contract | Synthetic order publishes only in Preview; public URL works and is scoped to the staging DB/storage |
| Expired content | Local request-time expiry tests, including no-Cron case | Preview expired URL/assets become inaccessible before cleanup runs |
| Lifecycle cleanup | Local retries, lease, idempotency and failure tests | Observed authenticated Preview run cleans only staging resources; no Production job/rows/assets change |
| Production unaffected | Negative local tests reject Production scope | No Production operation is performed; compare authorized non-secret resource identities and observe no Production changes during Preview verification |
| Logs and secrets | Synthetic sentinels prove tokens, signatures, URLs, credentials, payloads do not appear | Authorized Preview log review confirms no secrets/tokens/customer payload and access/retention are controlled |

No Preview criterion is upgraded to PASS based only on typecheck, unit tests,
historical reports, or a successful local mock.

## 14. Risks and rollback strategy

### Principal risks

1. Production-origin trust in Preview (F-01) breaks Preview authentication/CORS
   and can trust the Production origin as a Preview API caller.
2. Resource names and credential-variable scope do not prove DB or storage
   account separation; wrong target and over-scoped tokens remain possible.
3. A legacy Worker scheduled event can operate on whichever D1/R2 bindings it
   receives; it lacks the Vercel environment guard.
4. Local-only feature gates currently prevent full Preview E2E. Simply copying
   local flags would weaken boundaries, particularly in the legacy Worker path.
5. Memory storage, email discard, and missing Preview scheduler make a passing
   smoke test incomplete for persistent media, authentication, and cleanup.
6. Turso migration applies one transaction per migration, not one global
   transaction; later failure can leave earlier versions committed.
7. SePay Live, Production checkout, reconciliation, refunds, and operations
   are not implemented. Test-mode evidence cannot authorize Live payments.
8. Provider plan/cost, commercial eligibility, backups, restore, monitoring,
   support, and Vercel project settings are unverified.

### Rollback principles

- Disable Preview or the affected Preview capability first; revoke only
  staging credentials.
- Stop before any write if provider identity, expected host, environment,
  origin, or binding is ambiguous.
- Never repoint Preview at Production to restore availability.
- Use a verified staging backup/restore or reviewed forward-fix for schema
  changes; do not assume all migrations roll back atomically.
- Remove only identified synthetic staging rows/assets using the approved
  cleanup workflow.
- Leave Production schedules, credentials, data, and deployment untouched.
- If a Worker fallback is not explicitly selected, keep its deployment and
  scheduler disabled rather than allowing automatic fallback from Vercel.

## 15. User decisions required

1. Confirm Vercel Preview/Turso is the sole supported staging target, or
   explicitly retain a separate Worker/D1 staging target.
2. Approve a dedicated Turso staging DB/account boundary and owner who will
   verify DB identity, token scope, backups, and recovery.
3. Choose primary storage: separate Cloudinary staging account (recommended
   for the existing Vercel adapter) or a separately reviewed R2-compatible
   Vercel adapter/Worker staging option. Cloudinary remains disabled pending
   independent identity verification.
4. Choose whether Preview login remains disabled or a capture-only email
   sandbox with synthetic-recipient allowlisting is provisioned.
5. Decide whether protected Preview may enable synthetic catalog/payment/
   publication modes. If not, full paid-publication E2E remains blocked and
   only local contract tests may cover that path.
6. If provider Test Mode is required, authorize a separate SePay Test account,
   callback, bank mapping, and test-only credential review. No Live payment is
   implied.
7. Choose manual authenticated Preview lifecycle runs or an owner-approved
   recurring scheduler; keep Production Cron unchanged.
8. Decide whether legacy Worker/D1 and its scheduler are retained, isolated,
   or prohibited for staging.
9. Have owners verify current Vercel, Turso, Cloudinary/R2, email, SePay, and
   plan/billing identities outside this review. No prices or quotas were
   checked.

## 16. Remaining unknowns

- Current Vercel project linkage, deployment-protection policy, Preview
  assignments, Production assignments, and actual origin values.
- Whether a Preview deployment currently has `VERCEL_PROJECT_PRODUCTION_URL`,
  an explicit `APP_ORIGIN`, or a Preview-specific origin.
- Actual Turso account, DB identity, token scope, region, migration state,
  backup retention, and restore procedure.
- Actual Cloudinary account/cloud/key identity, plan, limits, and whether a
  separate staging account exists.
- Actual Cloudflare account, D1 database, R2 bucket, Worker deployment,
  secrets, and whether any scheduled trigger exists outside tracked config.
- Actual email credentials/provider behavior and delivery restrictions.
- Any SePay Test account, callback history, webhook reachability, or
  Production/Live configuration.
- Vercel Cron attachment, Preview scheduling support, and actual execution.
- Deployed Node runtime, function routing/limits, domain/HTTPS, commercial
  eligibility, monitoring/alerts, customer support, and operational recovery.
- Whether synthetic staging catalog pricing and Preview publication are
  approved product behaviors.

No item above was inferred from historical report claims as current remote
state.

## 17. Final verdict

**REVIEW COMPLETE — USER DECISIONS REQUIRED.**

The code review independently confirms the main ORDERS-2.20 staging blockers
and identifies the Preview-origin defect plus conditional legacy Worker
environment risks. Implementation planning can proceed, beginning with
environment identity and origin correctness. A controlled Preview deployment
must wait until these local gates, provider/resource decisions, migration
target, durable storage, email policy, and lifecycle approach are approved and
verified. This report does not declare staging or Production ready.

### Validation and final Git state

- `npm run typecheck`: passed (`tsc --noEmit`; `tsconfig.json` has `noEmit`
  enabled and no incremental output setting).
- Test suites: not run; some test paths write local databases. No test result
  is claimed for this review.
- `git diff --check`: passed. The untracked report was separately checked for
  trailing whitespace and passed.
- No source, tests, configuration, migration, dependency, or existing report
  files were modified.
- No provider, remote database, email, payment, migration, Cron, deployment,
  Production operation, commit, push, or merge was performed.

**Final Git state:** branch `main`, HEAD
`a81d5788069751ed10a52a980add3b4f3c291f39`; 138 tracked files; no staged or
modified tracked files. Untracked files are the pre-existing ORDERS-2.19 and
ORDERS-2.20 reports plus this ORDERS-2.21 report. Thus final status differs
from the initial status by exactly this one new QA report.

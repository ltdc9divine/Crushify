# ORDERS-2.29 — Vercel Preview Environment Configuration Audit

**Verdict: PARTIAL.** Source and synthetic-test evidence show fail-closed Preview/Production separation for runtime, database selection, storage-provider selection, lifecycle, payment, authentication, and origin. A durable isolated Preview storage provider is not enabled, and actual Vercel Preview variable assignments and remote resource identities remain unverified.

## 1. Initial Git baseline

Recorded before inspecting the requested files:

- Branch: `main`
- HEAD: `84acc4c19a143805830495671e076bbc395db3e3`
- Staged paths: none
- Modified tracked paths: 27
- Untracked paths: 8
- `git diff --check`: passed

The pre-existing modified tracked paths were:

`.env.example`, `README.md`, `docs/API_SPECIFICATION.md`, `docs/DATABASE_SCHEMA.md`, `docs/HOSTING_MIGRATION.md`, `docs/PAYMENT_FLOW.md`, `docs/PUBLICATION_AND_DELIVERY.md`, `docs/SECURITY_PLAN.md`, `docs/SEPAY_SETUP.md`, `docs/VERCEL_STAGING.md`, `scripts/staging-config.ts`, `scripts/staging-turso.ts`, `src/auth.ts`, `src/payments.ts`, `src/platform/vercel.ts`, `src/publications.ts`, `src/storage/cloudinary-policy.ts`, `tests/database-contract.test.ts`, `tests/payment-contract.mjs`, `tests/payments.test.ts`, `tests/pre-staging-security.test.ts`, `tests/publications.test.ts`, `tests/scheduler.test.ts`, `tests/staging-config.test.ts`, `tests/storage.test.ts`, `tests/vercel.test.ts`, and `tests/worker.test.ts`.

The pre-existing untracked paths were:

`docs/qa/ORDERS-2.23-TURSO-STAGING-DATABASE-ISOLATION.md`, `docs/qa/ORDERS-2.24-CLOUDINARY-STAGING-ISOLATION.md`, `docs/qa/ORDERS-2.25A-PREVIEW-AUTH-GATE-REMEDIATION.md`, `docs/qa/ORDERS-2.26-PREVIEW-MOCK-PAYMENT-ISOLATION.md`, `docs/qa/ORDERS-2.27-STAGING-MANUAL-PUBLICATION-LIFECYCLE.md`, `docs/qa/ORDERS-2.28-PREVIEW-LIFECYCLE-SECRET-ISOLATION.md`, `src/payments/policy.ts`, and `tests/auth-environment.test.ts`.

No values from secret-bearing files were read. `.env.example` was inspected by listing variable names only.

## 2. Scope and files inspected

Configuration and implementation:

- `.env.example`, `vercel.json`, `wrangler.jsonc`, `wrangler.staging.jsonc`
- `docs/VERCEL_STAGING.md`, `docs/SEPAY_SETUP.md`, `docs/PAYMENT_FLOW.md`, `docs/SECURITY_PLAN.md`, `docs/PUBLICATION_AND_DELIVERY.md`
- `src/platform/environment.ts`, `src/platform/vercel.ts`
- `src/database/provider.ts`, `src/database/turso.ts`
- `src/storage/provider.ts`, `src/storage/cloudinary.ts`, `src/storage/cloudinary-policy.ts`
- `src/payments/provider.ts`, `src/payments/policy.ts`, `src/payments.ts`
- `src/auth.ts`, `src/types.ts`, `src/index.ts`
- `api/cron/publication-lifecycle.ts`, `api/[...path].ts`
- `scripts/staging-config.ts`

Relevant QA reports:

- `docs/qa/ORDERS-2.23-TURSO-STAGING-DATABASE-ISOLATION.md`
- `docs/qa/ORDERS-2.24-CLOUDINARY-STAGING-ISOLATION.md`
- `docs/qa/ORDERS-2.25A-PREVIEW-AUTH-GATE-REMEDIATION.md`
- `docs/qa/ORDERS-2.26-PREVIEW-MOCK-PAYMENT-ISOLATION.md`
- `docs/qa/ORDERS-2.27-STAGING-MANUAL-PUBLICATION-LIFECYCLE.md`
- `docs/qa/ORDERS-2.28-PREVIEW-LIFECYCLE-SECRET-ISOLATION.md`

Relevant tests inspected: `tests/vercel.test.ts`, `tests/environment-isolation.test.ts`, `tests/pre-staging-security.test.ts`, `tests/payments.test.ts`, `tests/auth-environment.test.ts`, `tests/scheduler.test.ts`, `tests/publications.test.ts`, and `tests/worker.test.ts`.

## 3. Environment-variable inventory

“Required” below means required by the current source for the named capability, not verified as configured remotely. Vercel system variables are supplied by the platform and must not be copied into project secrets.

### Runtime, deployment, origin, and database

| Variable | Purpose | Preview required? | Production required? | Code consumer / current evidence |
|---|---|---|---|---|
| `VERCEL_ENV` | Trusted Vercel runtime classification | Yes; platform-supplied `preview` | Yes; platform-supplied `production` | `classifyVercelEnvironment`; missing/unknown or mismatched marker fails closed. |
| `ENVIRONMENT` | Application scope marker | Yes: `staging` | Optional in classifier (`undefined` or `production` accepted); explicitly setting `production` is clearer | Vercel classifier and credential-scope validation. |
| `VERCEL_URL` | Current deployment hostname | Yes; platform-supplied and used as Preview origin | Not used for Production origin selection | `resolveVercelOrigin`; Preview requires it and does not fall back to the Production URL. |
| `VERCEL_PROJECT_PRODUCTION_URL` | Project Production hostname | Platform-supplied when available; used to reject a Preview/Production origin collision | Used as Production origin fallback and consistency check | `resolveVercelOrigin`; code does not require it in Preview if `VERCEL_URL` is otherwise valid. |
| `APP_ORIGIN` | Explicit app/CORS/public-link origin | Optional; if set, must exactly match the current Preview `VERCEL_URL` | Optional if a valid Production URL is supplied; if set, must match it | Vercel origin validation; also used for auth/CSRF and publication links. |
| `PUBLIC_BASE_URL` | No implementation purpose found | No; ignored | No; ignored | No source, test, or documentation consumer found. Use `APP_ORIGIN` only where an override is needed. |
| `VERCEL_BRANCH_URL`, `VERCEL_PROJECT_ID` | Vercel metadata | No | No | Declared on `VercelEnvironment` but not read by runtime logic. |
| `DATABASE_PROVIDER` | Selects Vercel database adapter | Yes: `turso` | Yes: `turso` | Vercel adapter rejects other providers; Worker manifests separately use `d1`. |
| `TURSO_STAGING_DATABASE_URL`, `TURSO_STAGING_AUTH_TOKEN` | Dedicated Preview database credentials | Yes, for database-backed Preview; staging URL and non-empty token required | No; staging credentials are rejected in Production | Vercel maps only this pair in staging and validates the `crushify-staging…turso.io` hostname pattern. Pattern matching does not prove account ownership or database identity. |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Generic Production Turso credentials; local Vercel uses a file URL without a token | No; generic credentials are rejected in Preview | Yes for remote Vercel Production Turso; token required for remote URL | Generic pair is selected only in Production; Preview cannot fall back to it. Local runtime only accepts a `file:` URL and no auth token. |
| `APP_ORIGIN` (custom Preview alias) | Optional origin override | Not a way to select an arbitrary alias; must equal `VERCEL_URL` | N/A | A custom Preview alias that differs from the deployment URL is rejected as `RUNTIME_CONFIGURATION_ERROR`; no Production-origin fallback occurs. |

### Storage

| Variable | Purpose | Preview required? | Production required? | Code consumer / current evidence |
|---|---|---|---|---|
| `STORAGE_PROVIDER` | Selects Vercel storage implementation | Yes: `mock` for the currently permitted Preview mode | `cloudinary` if Vercel media operations are enabled | Preview mock is explicitly selected; `r2` is a Worker binding, not a Vercel option. Unknown/missing providers fail; no silent fallback. |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Generic Production Cloudinary credentials | No; rejected in Preview | Yes if Production selects Cloudinary | Only Production resolver consumes this generic credential set; Cloudinary staging/local selection is blocked. |
| `CLOUDINARY_STAGING_CLOUD_NAME`, `CLOUDINARY_STAGING_API_KEY`, `CLOUDINARY_STAGING_API_SECRET` | Proposed staging Cloudinary identity | No; currently rejected, not supported | No; staging credentials are rejected in Production | No staging Cloudinary adapter exists. A separately named Cloud is not proof of account isolation. |
| `CLOUDINARY_PRODUCTION_CLOUD_NAME` | Production identity label | No | Not required or used to configure Cloudinary | Declared and checked as a remote-configuration marker in local scope checks; actual Cloudinary selection uses the generic three-variable set above. |
| `CLOUDINARY_SMOKE_TEST` | Local staging-script safety opt-in | No | No | Consumed by staging-script validation only; Cloudinary staging remains blocked before adapter construction. |

The Vercel Preview storage mode is a process-memory `MemoryStorageAdapter`. It is not durable across function instances, restarts, or deployments. Tests confirm Preview can select this mock and cannot silently fall back to Cloudinary; this does not establish reliable multi-request media persistence.

### Lifecycle

| Variable | Purpose | Preview required? | Production required? | Code consumer / current evidence |
|---|---|---|---|---|
| `STAGING_LIFECYCLE_SECRET` | Authorizes the manual Preview lifecycle endpoint | Required only to invoke `POST /api/ops/staging/publication-lifecycle`; exactly 64 hexadecimal characters | No; should not be configured in Production | Staging route checks trusted Preview/staging scope and this dedicated secret only. It never falls back to `CRON_SECRET`. |
| `CRON_SECRET` | Authorizes scheduled Production lifecycle GET | No; Preview has no scheduled lifecycle | Yes for the configured Production Cron to execute; the existing matcher requires at least 32 characters | `/api/cron/publication-lifecycle`; Production-only guard remains separate. |
| `DATA_RETENTION_DAYS` | Lifecycle retention period | Optional; source default is 30 days | Optional; source default is 30 days | Lifecycle code validates the configured range. |

The application does not currently reject `STAGING_LIFECYCLE_SECRET` merely because it is present in a non-Preview Vercel environment. The route itself rejects non-Preview scope before using that credential; correct Preview-only assignment remains an owner configuration responsibility.

### Payment

| Variable | Purpose | Preview required? | Production required? | Code consumer / current evidence |
|---|---|---|---|---|
| `PAYMENT_MODE` | Selects local `mock` or `sepay-test` mode | No; any configured value is rejected | No; any configured value is rejected by Vercel scope validation | Preview policy internally selects `MOCK`; this is not a request-controlled setting. |
| `SEPAY_WEBHOOK_SECRET` | Local Test webhook HMAC verification | No; rejected/not forwarded | No; rejected/not forwarded; Production webhook processing is disabled | Local payment code only. |
| `SEPAY_BANK_CODE`, `SEPAY_BANK_ACCOUNT`, `SEPAY_ACCOUNT_NAME` | Local SePay Test transfer instructions/validation | No; rejected/not forwarded | No; rejected/not forwarded | Local `sepay-test` only; no live SePay payment client or Production checkout is enabled. |

### Authentication, email, and local-test controls

| Variable | Purpose | Preview required? | Production required? | Code consumer / current evidence |
|---|---|---|---|---|
| `MAIL_PROVIDER`, `MAIL_API_KEY`, `MAIL_FROM_EMAIL` | Resend sender configuration | No; Production credentials are rejected and not forwarded | Conditional: required together for Resend-based sign-in | Vercel forwards them only in Production. No current email configuration was verified. |
| `PREVIEW_EMAIL_SINK` | Discard-only Preview email sink | Optional; only `discard` is accepted | No; rejected in Production | Auth is disabled in Preview, so the sink does not enable sign-in or send email. |
| `LOCAL_TEST_MAIL_SINK_URL` | Local loopback test email sink | No; rejected | No; rejected | Accepted only for explicit local Vercel development and validated as loopback. |
| `LOCAL_TEST_EMAIL_SINK` | Injected local test callback | No | No | Function dependency, not a Vercel string environment variable. |
| `MAILER`, `MAILER_AUTH_TOKEN` | Cloudflare Worker mail-service binding and token | No Vercel use | Not Vercel variables; Worker-only | `src/auth.ts` supports the binding path, while the Vercel adapter does not forward these values. |
| `LOCAL_TEST_MODE`, `LOCAL_TEST_CATALOG_OVERRIDE`, `LOCAL_TEST_PRICING_POLICY` | Local synthetic auth/catalog/pricing gates | No; rejected | No; rejected | Local-only flags. The Vercel scope guard rejects them outside development; they do not enable Preview checkout. |
| `UPLOAD_MAX_BYTES` | Request upload limit | No manual value; Vercel adapter sets 4 MiB | No manual value; Vercel adapter sets 4 MiB | Internal value passed to the shared API, not a required platform setting. |

### Local staging-script variables, not Vercel runtime configuration

`CRUSHIFY_STAGING_PROFILE`, `TURSO_CONFIRM_DATABASE`, `TURSO_CONFIRM_GROUP`, `TURSO_CONFIRM_REGION`, `TURSO_CONFIRM_HOSTNAME`, `TURSO_MIGRATE_CONFIRM`, and `TURSO_SMOKE_TEST` are consumed by local staging scripts with explicit scope/target checks. They are not Preview application variables and must not be placed in Vercel merely to make Preview work. `TURSO_STAGING_TARGET` is mentioned in `docs/VERCEL_STAGING.md` as a forbidden Production variable but has no implementation consumer. That documentation entry is stale/ambiguous.

### Legacy Cloudflare Worker configuration

`wrangler.jsonc` and `wrangler.staging.jsonc` describe a different runtime: D1/R2 bindings and `DATABASE_PROVIDER=d1`/`STORAGE_PROVIDER=r2`. The staging manifest also has a `MAIL_PROVIDER` var. The Worker request guard rejects staging before the API/database/storage path and reports that staging must use Vercel Preview. These manifests do not configure Vercel Preview and do not prove any remote D1/R2 resource identity.

## 4. Preview vs Production isolation matrix

| Area | Preview/staging source contract | Production source contract | Audit result |
|---|---|---|---|
| Runtime classification | Requires Vercel `preview` paired with `ENVIRONMENT=staging`; unknown/mismatched values fail closed | Requires Vercel `production`; `ENVIRONMENT` may be unset or `production` | PASS at source level |
| Database | `DATABASE_PROVIDER=turso`; uses only staging URL/token; generic Production Turso variables are rejected; staging hostname is validated | Uses only generic Turso URL/token; staging hostname/credentials rejected | PASS at source level; actual remote identity and credentials unverified |
| Storage | Explicit mock only; Cloudinary and staging Cloudinary rejected; mock is ephemeral | Generic Production Cloudinary is the supported Vercel media provider | Isolation PASS; durable Preview storage is incomplete |
| Lifecycle | No scheduled Preview Cron; manual route requires Preview scope and `STAGING_LIFECYCLE_SECRET` | `vercel.json` schedules daily Cron; route requires `CRON_SECRET` and Production classification | PASS at source level; no deployed invocation/config verified |
| Payments | Provider policy selects `MOCK`; auth blocks order creation; SePay webhook/settlement and fulfillment disabled; no mock-confirm route | SePay identity retained but checkout/webhook processing disabled; no live readiness implied | PASS for isolation; Preview mock settlement unavailable |
| Customer authentication | Login, verification, session acceptance, and protected routes fail closed before DB/token/email effects; logout only clears cookies | Existing auth policy remains enabled; email depends on Production provider config | PASS at source level |
| Public origin | Requires Vercel's current `VERCEL_URL`; optional `APP_ORIGIN` must exactly match; Production URL is not the Preview fallback | Uses `APP_ORIGIN` or Production project URL and rejects mismatches | PASS in code/tests; custom Preview aliases are not supported unless equal to `VERCEL_URL` |
| Remote state | No current Vercel variable assignment or remote resource check in this audit | No Production values/resources inspected | UNVERIFIED |

## 5. Findings

### Critical

None found in the inspected source or synthetic tests. No Preview-to-Production Turso/Cloudinary fallback, SePay settlement route, customer authentication bypass, or lifecycle authorization fallback was found.

### High

1. **Preview media storage is not durable.** `STORAGE_PROVIDER=mock` selects process-memory storage, not an isolated persistent staging store. This is safe from Production storage access but blocks reliable end-to-end validation of uploads and media delivery across Vercel instances/restarts. Cloudinary is intentionally rejected until separate account isolation is verified. Do not change to Production Cloudinary as a workaround.

### Medium

1. **Remote Preview configuration remains unknown.** The current presence and exact values of required Preview variables, the staging Turso account/database identity, database-scoped token, domain assignments, and deployed runtime were not checked. Earlier QA reports explicitly leave these remote items unverified; this audit cannot establish that the deployed Preview is correctly configured.
2. **`PUBLIC_BASE_URL` is unsupported.** It is absent from application code and documentation. The implemented name is `APP_ORIGIN`, constrained to Vercel's current Preview URL. An operator configuring only `PUBLIC_BASE_URL` would not change the application origin.

### Low

1. **Lifecycle secret scope is a manual control.** The Preview route rejects other runtime scopes, but the Vercel configuration validator does not reject the `STAGING_LIFECYCLE_SECRET` variable if accidentally assigned to Production. It cannot authorize the Production Cron; nevertheless, configure it only in Preview as documented.
2. **Stale variable documentation.** `TURSO_STAGING_TARGET` appears in the Production exclusion list in `docs/VERCEL_STAGING.md` but has no code/script consumer. Current staging scripts use `TURSO_CONFIRM_*` controls.
3. **Legacy Worker manifest can be confused with Vercel Preview.** `wrangler.staging.jsonc` describes D1/R2 rather than Vercel's Turso/mock setup. The Worker code rejects staging requests, and current docs distinguish the legacy path, but the manifest itself is not a Vercel Preview configuration.

## 6. Variables the project owner must configure manually

For a database-backed Vercel Preview, an authorized owner must configure and independently verify:

- `ENVIRONMENT=staging`
- `DATABASE_PROVIDER=turso`
- `TURSO_STAGING_DATABASE_URL`
- `TURSO_STAGING_AUTH_TOKEN` scoped to the dedicated staging database
- `STORAGE_PROVIDER=mock` under the current policy
- `STAGING_LIFECYCLE_SECRET` only if using the manual lifecycle endpoint; it must be a dedicated 64-hex-character value and must not be reused from Production

Vercel supplies `VERCEL_ENV=preview` and `VERCEL_URL`; do not set these manually. `APP_ORIGIN` may be omitted; if supplied, it must exactly match `VERCEL_URL`. `PREVIEW_EMAIL_SINK=discard` is optional and does not enable customer authentication.

Do not configure generic Production Turso credentials, Cloudinary credentials, `MAIL_PROVIDER`/mail secrets, `PAYMENT_MODE`, `SEPAY_*`, or local-test flags in Preview.

For Production, code expects generic Turso configuration and a valid origin; `STORAGE_PROVIDER=cloudinary` plus generic Cloudinary credentials are conditional on enabling media operations. `CRON_SECRET` is required for the configured Production Cron to run. Resend variables are conditional on enabling email sign-in. These source-level requirements do not imply those values are currently configured or that checkout/payments are enabled.

## 7. Remote configuration still unverified

- Whether any of the required Preview variables are currently assigned in Vercel.
- Whether the Preview Turso database exists, is owned by the intended account, is separate from Production, and has a narrowly scoped token.
- Whether Preview deployment aliases, production domain assignment, and deployment protection match the source assumptions.
- Whether `STAGING_LIFECYCLE_SECRET` is set only in Preview and whether the deployed route behaves as tested.
- Whether Preview mock storage is acceptable for the intended tests; it is not durable.
- Whether Production Turso, Cloudinary, email, and Cron settings are present and valid.
- No remote account/resource identity is claimed based on hostname, variable name, manifest identifier, or previous local tests.

## 8. Recommended remediation order

1. Have the authorized owner confirm the dedicated Preview Turso database identity and database-scoped token out of band.
2. Configure only the Preview variables listed above through the approved Vercel secret-management workflow; do not copy Production secrets.
3. Decide whether ephemeral mock storage meets the intended Preview test scope. If durable media testing is needed, require a separately verified staging storage identity and a separate reviewed implementation before enabling it.
4. Configure `STAGING_LIFECYCLE_SECRET` only if the manual lifecycle operation is approved; retain Production `CRON_SECRET` separately.
5. Use `APP_ORIGIN` only when its value is exactly the current deployment URL; do not configure `PUBLIC_BASE_URL`.
6. Correct the stale `TURSO_STAGING_TARGET` documentation reference in a later documentation-only task. Keep the legacy Worker staging manifest distinct from Vercel Preview.
7. Only after owner configuration is complete, perform an independently authorized, narrowly scoped remote verification. This audit did not authorize or perform that verification.

## 9. Verification performed

- Recorded Git state before inspection.
- Read the ORDERS-2.23 through ORDERS-2.28 QA reports.
- Inspected the listed docs, source, Vercel/Worker configuration, local staging-script validation, and relevant synthetic tests.
- Confirmed tests cover staging-only Turso selection and no Production fallback, storage fail-closed behavior, Preview auth side effects, mock payment/SePay webhook rejection, dedicated lifecycle secret isolation, Production Cron scope, and Preview origin validation.
- Ran `git diff --check` at the start; it passed.
- Did not run unit or integration tests; this is a read-only audit and no application code was changed.
- Did not access Vercel, Turso, Cloudinary, SePay, email providers, Production resources, or secret-bearing files; no environment values were printed.

## 10. Final Git state

- Branch: `main`
- HEAD: `84acc4c19a143805830495671e076bbc395db3e3` (unchanged)
- Staged paths: none
- Modified tracked paths: 27 (same pre-existing paths as baseline)
- Untracked paths: 9 (the same 8 pre-existing paths plus this report)
- `git diff --check`: passed
- No source, deployment configuration, remote environment, database, or secret was modified. No migration, deployment, commit, push, or merge occurred.

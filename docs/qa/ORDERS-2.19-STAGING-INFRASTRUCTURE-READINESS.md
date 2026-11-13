# ORDERS-2.19 — Staging Infrastructure Readiness Audit

## Verdict

# PARTIAL — STAGING BLOCKERS REMAIN

The checked-in code has meaningful fail-closed boundaries for Vercel Preview: it selects only staging-scoped Turso credentials, rejects Production credentials, blocks Cloudinary, and disables payment processing. That is local code evidence only. No current Vercel Preview deployment, remote database identity, provider account, or live scheduler was inspected. Preview also lacks a supported durable-media path, interactive email sign-in, and an automatic lifecycle schedule in the reviewed configuration. These gaps prevent a complete controlled staging verification.

This audit is read-only except for this report. It does not authorize or perform deployment, provider setup, migrations, uploads, email, payments, Cron invocation, or Production operations.

## 1. Git baseline and scope

Initial state:

- Branch: `main`
- HEAD: `a81d5788069751ed10a52a980add3b4f3c291f39`
- `git status --short --untracked-files=all`: clean
- Staged, modified, and untracked files: none

The audit reviewed the current application and deployment code, the staging documentation, and the ORDERS-2.15 through ORDERS-2.18B evidence. Earlier QA reports contain historical observations of Vercel Preview configuration; those observations are not evidence of the current remote state and were not repeated.

No secrets, environment values, `.env` files, or session files were read. No remote service or Production resource was accessed. No migration, database write, upload, email, payment, deployment, commit, push, or merge was performed.

## 2. Evidence and limits

### Current local verification

| Command | Result | Scope |
|---|---|---|
| `npm run typecheck` | PASS — exit code 0 | Run during this audit; `tsc --noEmit`. |
| `git diff --check` | PASS — exit code 0 | Run after report creation; checks tracked changes. The report is new/untracked and was separately reviewed for whitespace. |
| Test suites | NOT RUN | Unit/integration suites were not run because some test paths write to local databases. ORDERS-2.18B records focused tests (54), `npm test` (105), `npm run test:integration`, and `npm audit --omit=dev` passing at this exact HEAD. Those are historical local results, not tests rerun for ORDERS-2.19. |

### Current implementation references

- Vercel environment pairing, credential-scope checks, Preview Cloudinary rejection, and staging-only Turso selection are in [`src/platform/vercel.ts`](../../src/platform/vercel.ts#L131).
- Preview mock storage and the runtime storage factory are in [`src/platform/vercel.ts`](../../src/platform/vercel.ts#L312); shared Worker Cloudinary policy is in [`src/storage/provider.ts`](../../src/storage/provider.ts#L14) and [`src/storage/cloudinary-policy.ts`](../../src/storage/cloudinary-policy.ts#L24).
- Email selection and Preview discard behavior are in [`src/auth.ts`](../../src/auth.ts#L51) and [`src/auth.ts`](../../src/auth.ts#L107). Magic-link creation and delivery are in [`src/auth.ts`](../../src/auth.ts#L257).
- Payment environment gating is in [`src/platform/vercel.ts`](../../src/platform/vercel.ts#L303) and [`src/payments.ts`](../../src/payments.ts#L83).
- Cron authorization and scope validation are in [`src/platform/vercel.ts`](../../src/platform/vercel.ts#L343); the checked-in schedule is in [`vercel.json`](../../vercel.json#L127).
- Request-time expiry enforcement is in [`src/publications.ts`](../../src/publications.ts#L1362); lifecycle execution is in [`src/publications.ts`](../../src/publications.ts#L375).
- The legacy Worker constructs storage through the shared factory in [`src/index.ts`](../../src/index.ts#L83).
- Staging Turso preflight/migration checks are in [`scripts/staging-config.ts`](../../scripts/staging-config.ts#L15) and [`scripts/staging-turso.ts`](../../scripts/staging-turso.ts#L76).
- Vercel staging guidance is in [`docs/VERCEL_STAGING.md`](../../docs/VERCEL_STAGING.md). Its remote configuration observations are historical and are not represented here as current.

## 3. Readiness matrix

`PASS`, `PARTIAL`, `FAIL`, and `NOT VERIFIED` describe the evidence in this audit, not a claim that remote infrastructure was tested.

| Area | Status | Evidence and limitation | Next action |
|---|---|---|---|
| Vercel Preview environment pairing | PASS — local guard | Preview requires the staging environment pairing and a valid application origin; mismatches fail before app dependencies initialize. | Verify the actual Preview project and deployment scope in an authorized release session. |
| Production credential fallback into Preview | PASS — local guard | Preview rejects generic Turso, Cloudinary, mail, payment, and local-test credentials. Database selection uses only staging-specific Turso variables. | Confirm names and scope in the Vercel dashboard without displaying or copying values. |
| Current Vercel project/linkage and Preview variables | NOT VERIFIED | No Vercel API/CLI or project settings were accessed in this audit. Historical reports are not current evidence. | Owner verifies project, Preview deployment protection, branch policy, and variable presence. |
| Vercel Node runtime/build/routes | PARTIAL | `package.json` declares Node `>=22.6.0`; there was no Vercel build or deployed function invocation. | Build and smoke-test only an authorized Preview deployment; confirm selected Node runtime, routing, limits, and static assets. |
| Turso provider selection | PASS — local guard | Vercel requires the Turso provider and remote credentials; Preview uses only the staging-scoped URL/token and requires a staging-pattern hostname. No implicit D1 or production fallback is selected. | Keep these values in Preview scope only; verify the remote database identity before any migration or synthetic write. |
| Turso account/database separation | NOT VERIFIED | A hostname pattern and separate variable names do not prove account ownership, database identity, token scope, or non-sharing with Production. No remote connection was made. | Owner confirms the exact account, database, region, database-scoped token, Production separation, and backup/recovery plan out of band. |
| Turso migration workflow | PARTIAL | The guarded Turso staging script requires explicit staging identity checks and a separate migration confirmation. Separately, `db:apply:staging` directly invokes remote Wrangler D1 migrations using `wrangler.staging.jsonc`, outside that Turso guard. These target different database systems; neither command was run. See Finding M-01. | Document which database belongs to each deployment. Use only the approved migration path for the verified target, after authorization and preflight. |
| Staging migration state / backup restore | NOT VERIFIED | No staging database was contacted; no schema ledger, backup, or restore was checked. | Verify migration checksums and schema using the approved preflight, and rehearse a staging-only restore/rebuild path before writes. |
| Vercel Preview storage provider | PASS — local safety contract | Cloudinary is rejected for staging. The supported Vercel Preview mock adapter is in-memory and ephemeral; it is not durable across invocations. Vercel does not select Worker R2. | Keep upload-dependent acceptance criteria out of scope until a durable, explicitly isolated Preview storage option is approved and implemented. |
| Cloudinary account isolation | PASS — staging blocked; remote identity NOT VERIFIED | ORDERS-2.18B's shared policy blocks staging Cloudinary before adapter construction. Local code cannot establish remote account/key ownership. | Keep Cloudinary disabled for staging. Do not configure production Cloudinary variables in Preview. Reconsider only after an independent account-isolation design and owner verification. |
| Cloudflare Worker D1/R2 staging resources | PARTIAL | Wrangler staging config declares D1/R2 staging bindings; the separate Worker path uses the shared Cloudinary guard. Configured names/IDs are not proof that the remote account or buckets are isolated. This is not the Vercel Preview backend. | If Worker staging is in scope, verify the Cloudflare account, D1 database, R2 bucket, access scope, and rollback independently. |
| Preview email confidentiality | PASS — local policy | Preview does not receive production mail credentials. The discard sink sends no email and does not expose a magic token through the response. | Keep real email-provider credentials out of Preview. |
| Interactive Preview authentication | FAIL — unsupported by current delivery path | The Preview discard service discards the sign-in link; without that sink the service is unavailable. The request can return an accepted response without delivering a usable link. Thus a user cannot complete normal magic-link sign-in in Preview. | Before editor/auth acceptance tests, approve and implement a test-only sign-in delivery mechanism that cannot send to real customers or reveal tokens publicly. |
| Session cookies, CSRF, CORS, callback/origin | PARTIAL | Local code uses host-only, HttpOnly, SameSite=Lax session cookies, CSRF protection, and exact-origin CORS checks. No deployed Preview domain, HTTPS, browser callback, or cookie behavior was exercised. | Verify sign-in, session renewal/logout, CSRF, CORS, and cookie flags on the actual protected Preview origin once safe sign-in is available. |
| Payment mode in Preview | PASS — disabled by design | Vercel forwards payment settings only to local development; payment handlers require local test mode. Preview cannot create or settle mock/SePay-test payments. | Keep payment variables absent in Preview. Test only local synthetic contracts unless a separately approved test architecture is introduced. |
| SePay Test Mode / webhook delivery | NOT VERIFIED | No SePay account, test callback, webhook endpoint, or provider history was accessed. ORDERS-2.15 covers local signed synthetic payloads only. | Do not use Preview for provider callbacks under the current payment guard. Any later Test-mode test requires explicit provider authorization and an isolated endpoint. |
| Real payment / Production payment | FAIL — not supported | The local code does not provide a Live payment flow. This audit performed no payment operation. | Do not accept real payments; a separate implementation, provider verification, operational reconciliation, and explicit authorization are prerequisites. |
| Preview automatic expiry/cleanup | FAIL — no Preview schedule evidenced | `vercel.json` declares a lifecycle Cron route, but no Preview schedule is configured. The handler is scope-guarded; a manually authorized request is not an automatic scheduler. Public reads locally deny expired publications, but physical cleanup still needs an execution path. | Approve a staging-only manual or scheduled lifecycle policy and verify its scope before relying on Preview cleanup. |
| Production Cron configuration | PARTIAL | One daily lifecycle schedule is checked into `vercel.json`; no deployment attachment, secret presence, or actual invocation was verified. | Verify schedule attachment and the first authorized result only in the approved Production release process. |
| Legacy Worker scheduler | PARTIAL | `src/index.ts` retains a `scheduled()` handler, while the inspected Wrangler configs do not declare a Cron trigger. It also recovers payment fulfillments, unlike the Vercel lifecycle Cron. No Worker deployment or schedule was inspected. | Keep triggers disabled unless an owner explicitly selects the Worker scheduler and resolves duplicate/recovery responsibilities. |
| Logs and secret redaction | PASS — local code review | Application error paths use the safe logger, which limits fields and omits raw error messages/stacks/context; the Vercel catch-all logs only a generated request ID. Remote log retention and deployed output were not tested. | Verify access, retention, alert routing, and redaction in the authorized Preview/Production logging consoles. |
| Monitoring, support, and recovery | NOT VERIFIED | No deployed alerts, on-call ownership, support/recovery workflow, or backup drill was checked. | Define minimum staging and launch alerts and a customer/order recovery runbook before any public launch or real payments. |
| Provider account limits / commercial eligibility | NOT VERIFIED | Turso, Cloudflare, Vercel, email, and payment plan limits/account eligibility were not accessed. | Owner verifies eligibility and quotas before public/commercial launch; compare limits with expected usage before scaling. |

## 4. Findings and staging blockers

### M-01 — Two different remote staging migration paths

- **Severity:** MEDIUM — operational target-confusion risk.
- **Evidence:** [`package.json`](../../package.json#L15) defines `db:apply:staging` as a remote Wrangler D1 migration using the staging Wrangler config. [`package.json`](../../package.json#L18) separately defines `db:migrate:turso:staging`. The latter calls [`scripts/staging-turso.ts`](../../scripts/staging-turso.ts#L76), which applies explicit staging checks from [`scripts/staging-config.ts`](../../scripts/staging-config.ts#L15). The direct D1 script does not use those Turso identity/confirmation checks.
- **Impact:** Operators could mistake the Worker D1 migration for the Vercel Preview Turso migration, or run a remote D1 write without the Turso script's explicit confirmations. The checked-in D1 target is staging-labeled, but its actual remote identity was not verified.
- **Remediation:** Keep the two workflows clearly separated by deployment/backend, verify each remote resource identity and account before use, and require explicit owner authorization for either remote migration. Do not run `db:apply:staging` against Vercel Preview; Vercel Preview selects Turso.
- **Required before staging:** YES, if the selected staging rollout applies migrations. Establish and document the canonical migration command for each backend before any remote write.

### H-01 — No usable Preview magic-link delivery

- **Severity:** HIGH — functional staging blocker, not a token-leak finding.
- **Evidence:** [`src/auth.ts`](../../src/auth.ts#L51) discards Preview email; [`src/auth.ts`](../../src/auth.ts#L107) returns that sink only when configured. [`src/auth.ts`](../../src/auth.ts#L307) creates and stores a hashed login token and [`src/auth.ts`](../../src/auth.ts#L317) passes the link to the email service. The Preview sink discards the message rather than delivering it.
- **Impact:** Normal users/testers cannot authenticate into Preview to exercise owner-scoped editor, save, reload, or checkout pages. The token is not returned by the authentication response, which is correct for confidentiality but means the discard mode is not an interactive test path.
- **Remediation:** Approve a test-only delivery approach with strict recipient allowlisting or a protected, non-public local harness; do not expose magic tokens in unauthenticated responses or send real customer mail.
- **Required before staging:** YES, for authenticated browser acceptance. A limited unauthenticated health/config smoke can be run without it.

### H-02 — Preview has no scheduled lifecycle runner

- **Severity:** HIGH — lifecycle/cleanup acceptance blocker.
- **Evidence:** [`vercel.json`](../../vercel.json#L127) declares the lifecycle route once. No Preview Cron or Wrangler staging Cron is declared in the inspected configuration. [`src/platform/vercel.ts`](../../src/platform/vercel.ts#L355) has an authenticated route with runtime scope checks, and [`src/publications.ts`](../../src/publications.ts#L1412) denies access after expiry on public reads.
- **Impact:** Expired pages can be denied on request, but staging expiry transitions and retention cleanup are not guaranteed to run automatically. This audit did not invoke the route or inspect a deployment.
- **Remediation:** Before using Preview for lifecycle acceptance, approve an isolated manual or scheduled mechanism, define retry/cleanup expectations, and prove it selects the Preview database/storage only.
- **Required before staging:** YES, if lifecycle expiration and cleanup are part of staging acceptance.

### M-02 — Vercel Preview mock storage is ephemeral

- **Severity:** MEDIUM — media-flow test limitation.
- **Evidence:** [`src/platform/vercel.ts`](../../src/platform/vercel.ts#L312) constructs `MemoryStorageAdapter` for Preview mock mode. The Vercel path does not choose the Worker R2 adapter; Cloudinary is explicitly blocked by ORDERS-2.18B.
- **Impact:** Upload/read/delete behavior cannot establish durable media correctness across independent serverless invocations. A passing mock request does not verify a usable storage provider or private-original lifecycle.
- **Remediation:** Keep tests limited to contracts that do not require persistence, or separately approve a durable Preview storage design and verify its account/bucket isolation. Do not enable Cloudinary merely to unblock testing.
- **Required before staging:** YES, for upload/publication media acceptance; NO for a narrowly scoped static/API health smoke.

## 5. Environment-variable names

Names below are an inventory only. No values are provided or recommended here.

| Purpose | Names |
|---|---|
| Vercel/runtime scope | `VERCEL_ENV`, `VERCEL_URL`, `ENVIRONMENT`, `APP_ORIGIN` |
| Preview database | `DATABASE_PROVIDER`, `TURSO_STAGING_DATABASE_URL`, `TURSO_STAGING_AUTH_TOKEN` |
| Production database variables that must not be used by Preview | `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` |
| Preview storage selection | `STORAGE_PROVIDER` |
| Cloudinary variables; not needed while staging Cloudinary is blocked | `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `CLOUDINARY_STAGING_CLOUD_NAME`, `CLOUDINARY_STAGING_API_KEY`, `CLOUDINARY_STAGING_API_SECRET` |
| Email; Preview must not receive production mail credentials | `PREVIEW_EMAIL_SINK`, `MAIL_PROVIDER`, `MAIL_API_KEY`, `MAIL_FROM_EMAIL` |
| Payment; do not configure for Preview | `PAYMENT_MODE`, `SEPAY_WEBHOOK_SECRET`, `SEPAY_BANK_CODE`, `SEPAY_BANK_ACCOUNT`, `SEPAY_ACCOUNT_NAME`, `LOCAL_TEST_MODE`, `LOCAL_TEST_CATALOG_OVERRIDE` |
| Optional manual lifecycle invocation | `CRON_SECRET` |
| Retention policy | `DATA_RETENTION_DAYS` |

Vercel-managed variable availability and the current Preview assignments were not checked. The inventory is not evidence that any variable is currently set.

## 6. Safe staging sequence

Do not execute these steps as part of this audit. Each remote step requires separate owner authorization.

1. **Confirm scope and deployment controls.** Owner verifies the intended Vercel project, Preview protection, branch/PR rules, HTTPS deployment URL, and rollback access. Keep Production aliases and domains out of Preview.
2. **Confirm the database target before configuration.** Owner verifies a dedicated non-Production Turso database, account/organization, region, database-scoped token, and recovery/rebuild plan without copying secret values. Confirm the intended Vercel Preview application uses Turso, not the Worker D1 database.
3. **Choose and document migration paths.** Use the Turso preflight/migration workflow only for the verified Vercel database; use the Wrangler D1 migration only for a separately verified Worker staging database. Review pending migration/checksum state before any write. Do not run either command until the exact remote target and authorization are confirmed.
4. **Configure Preview with least privilege.** Add only required variable names to Preview using the approved secret store. Keep Production database credentials, Cloudinary credentials, mail-provider credentials, and payment/test-mode credentials out of Preview. Keep staging Cloudinary blocked.
5. **Decide which flows Preview can actually test.** Mock storage is ephemeral and cannot certify durable uploads. Preview email discard cannot support login. Either scope the test to non-authenticated/non-persistent checks or obtain explicit approval for isolated durable storage and a safe test-only authentication method before claiming full checkout/editor coverage.
6. **Deploy only after authorization.** Build/deploy to Preview, then verify route/runtime startup, environment guard behavior, origin/CORS/cookies, database connectivity, and allowed health checks. Use only synthetic records and verify cleanup ownership.
7. **Lifecycle verification.** Before creating expiring synthetic records, select and document a Preview-only lifecycle runner. If invoking the protected handler manually, use the authorized header mechanism, never place the secret in a URL/log, confirm Preview scope, and verify expiry/cleanup against synthetic records only.
8. **Keep payments disabled.** Verify that Preview order/payment routes fail closed. Any provider-backed Test Mode work requires a separately authorized provider plan and isolated callback endpoint. Real payments remain out of scope.
9. **Close the staging pass.** Confirm no Preview-to-Production resource access, no unexpected email/payment, successful synthetic cleanup, reviewed logs, and rollback readiness. Record actual deployment and provider evidence separately from these local code results.

## 7. Rollback and authorization

### Rollback plan

- Stop the Preview rollout and disable the Preview deployment or feature exposure through the authorized Vercel workflow; do not touch Production.
- Preserve diagnostic request IDs and sanitized logs. Do not copy secrets, session tokens, customer data, or raw payment payloads into the report.
- For a schema change, use the pre-approved staging restore/rebuild or forward-fix plan. Do not assume a destructive reverse migration is safe.
- Remove only task-owned synthetic records/assets after confirming exact ownership and the approved cleanup procedure. Do not perform cleanup against an ambiguous resource.
- If any Production credential, resource, customer data, real email, or payment is unexpectedly observed, stop immediately and escalate to the owner; do not continue tests.

### Actions requiring explicit owner authorization

- Inspecting or changing Vercel project/environment settings; creating or deploying a Preview.
- Provisioning or connecting to Turso, Cloudflare D1/R2, Cloudinary, email, or payment resources.
- Applying migrations, creating synthetic remote records/assets, invoking lifecycle cleanup, or deleting any remote object/data.
- Introducing a test-only magic-link delivery mechanism or enabling durable Preview storage.
- Connecting SePay Test Mode or sending any real payment/email.
- Any Production access, configuration change, or release operation.

## 8. Final Git state and conclusion

Final state:

- Branch: `main`
- HEAD: `a81d5788069751ed10a52a980add3b4f3c291f39`
- Staged changes: none
- Modified tracked files: none
- New untracked file: `docs/qa/ORDERS-2.19-STAGING-INFRASTRUCTURE-READINESS.md`
- Application source and configuration changes: none
- `git diff --check`: PASS

**Final verdict: PARTIAL — STAGING BLOCKERS REMAIN.** Local Preview guards are useful and fail closed, but remote Vercel/database isolation is unverified and authenticated end-to-end Preview acceptance cannot currently be completed because email sign-in is discarded, media storage is ephemeral, and no Preview lifecycle schedule is configured. No claim is made that staging or Production is deployed, provider-verified, or ready to accept payments.

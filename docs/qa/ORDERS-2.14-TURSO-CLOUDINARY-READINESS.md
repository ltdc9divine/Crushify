# ORDERS-2.14 — Turso & Cloudinary Deployment Readiness Audit

**Review date:** 2026-11-12  
**Classification: PARTIAL — REMOTE VERIFICATION REQUIRED**

This is a local code/configuration audit. No Production or remote provider resources were accessed or changed. Passing local tests do not establish Turso or Cloudinary account, network, deployment, or Production readiness.

## Executive summary

- **PASS — LOCAL IMPLEMENTATION:** Turso/libSQL and Cloudinary paths have local adapter, migration, configuration-guard, security, and Vercel contract coverage. The complete local test suite passes.
- **Confirmed defects:** None found during this audit. No runtime, migration, provider, or deployment configuration code was changed.
- **PARTIAL — REMOTE VERIFICATION REQUIRED:** No remote Turso connection, Cloudinary upload, Vercel build/deployment, or real provider cleanup operation was attempted. Production credentials, account isolation, schema state, provider behavior, and network/runtime compatibility remain to be verified by an authorized release operator.

## 1. Initial and final worktree

Initial inspection:

- Branch: `main`
- HEAD: `5205f730fd0141fb9c8d0697787b700e4bda04ff`
- Existing status: 26 modified tracked files and 5 untracked files.
- The existing modifications were preserved. The sole file added for this task is this report.

Pre-existing modified tracked paths:

```text
_headers
docs/HOSTING_MIGRATION.md
docs/PAYMENT_FLOW.md
docs/PRODUCT_ARCHITECTURE.md
docs/PUBLICATION_AND_DELIVERY.md
docs/STAGING_DEPLOYMENT.md
docs/VERCEL_STAGING.md
shared/customer-editor.js
src/platform/vercel.ts
templates/distance-means-nothing/index.html
templates/love-letter/index.html
templates/our-memories/index.html
templates/our-memories/our-memories.js
templates/our-universe/index.html
templates/say-yes/index.html
templates/say-yes/say-yes.css
templates/say-yes/say-yes.js
tests/browser-love-letter.mjs
tests/integration.mjs
tests/payment-contract.mjs
tests/publications.test.ts
tests/scheduler.test.ts
tests/template-registry.test.ts
vercel.json
wrangler.jsonc
wrangler.staging.jsonc
```

Pre-existing untracked paths:

```text
docs/qa/ORDERS-2.11C-FIVE-TEMPLATE-CHECKOUT.md
docs/qa/ORDERS-2.12-CONSOLIDATED-RELEASE-REVIEW.md
docs/qa/ORDERS-2.13-LIFECYCLE-CRON-RESOLUTION.md
docs/qa/ORDERS-2.3-2.6-FINAL-QA-REPORT.md
tests/orders-2-10-browser-fixture.mjs
```

Final inspection confirms branch `main` and HEAD `5205f730fd0141fb9c8d0697787b700e4bda04ff` are unchanged. Final status: the above 26 tracked modifications and 5 existing untracked files remain, plus this new report as an untracked file. No other changes were made by the audit. No reset, checkout, clean, stash, commit, push, merge, or deployment was performed. `session.json` was not accessed.

## 2. Turso/libSQL audit

### Provider and connection

**PASS — LOCAL IMPLEMENTATION**

- `src/database/provider.ts` selects only explicitly configured `d1` or `turso`. D1 requires a binding; Turso requires a URL and requires a token for non-`file:` URLs. There is no implicit provider fallback.
- The Vercel adapter selects Turso and applies environment-specific Turso credentials only after its runtime and credential-scope checks. `src/platform/vercel.ts` rejects unsupported protocols, credential-bearing/query/hash URLs, local files outside development, missing remote auth, and staging/Production hostname mismatches before opening the database.
- `connectTursoDatabase` enables and verifies foreign-key enforcement. Failed initialization closes the client. A failed cached Vercel initialization is cleared to permit a later request to reconnect.
- Vercel database initialization returns a generic unavailable response and logs a sanitized error code/name, not the database URL or token. Local Turso migration and staging-operation scripts also have guarded configuration and sanitized remote-operation failure handling.
- `TursoDatabaseAdapter` normalizes supported bind values, supports `first`/`all`/`run`/`RETURNING`, translates supported constraint/busy errors, and batches only statements from the same adapter. Local integration tests exercise rollback and shared D1/Turso contracts.

### Migrations and SQL compatibility

**PASS — LOCAL IMPLEMENTATION**

- The eight checked-in migrations are consecutively numbered `0001` through `0008`; they are loaded in sorted filename order and migration metadata is validated before application.
- Migration application uses libSQL write transactions and records a SHA-256 checksum with each version. Reapplication is a no-op; changed applied migration files, empty/inconsistent ledgers, unknown existing schemas, and foreign-key violations fail closed.
- The local in-memory libSQL test applies all eight migrations, checks ledger order, checksum mismatch rejection, indexes, JSON constraints, foreign keys, batch atomicity, `RETURNING`, value normalization, and idempotent reapplication.
- The same API contract also runs against an isolated local SQLite file using `@libsql/client`; the integration suite separately exercises the existing D1 path. This preserves the Cloudflare D1 rollback path; no Cloudflare configuration was removed.
- Migration compatibility was verified against the locally installed `@libsql/client` 0.18.0, not a remote Turso account or a deployed Turso service. Query plans, production-scale concurrency/latency, and remote migration state remain unverified.

### Configuration and error handling

**PASS — LOCAL IMPLEMENTATION**

- Local tests cover absent provider, missing binding/URL/token, guarded refusal of remote URLs from the local migration command, and refusal to pair a local file URL with a remote token.
- Vercel configuration validation is stricter than the generic provider factory and produces safe configuration/dependency responses. No provider secret values were read or printed.

## 3. Cloudinary storage audit

### Upload authorization and private originals

**PASS — LOCAL IMPLEMENTATION**

- The server creates upload capabilities only after customer-session and CSRF validation, checks ownership of a draft Design, and persists the generated Asset, random private object key, customer/Design association, size limit, and hashed single-use expiring capability.
- The content route requires the matching asset capability, validates the byte count and actual PNG/JPEG structure and dimensions, consumes the capability once, and stores the object as an authenticated Cloudinary asset. Completion re-reads the object and verifies size, media type, hash, and dimensions before marking it ready.
- Storage-key validation rejects client-controlled keys. Cloudinary upload signing is server-side; originals use `type=authenticated`, and generated private download URLs are signed and time-limited (maximum five minutes). The Cloudinary tests assert request signatures and that the API secret is not present in the generated request body or private URL.
- Authenticated asset reads require a ready asset owned by the session customer and use the private-storage interface. No direct public-original URL is produced by the adapter.

### Public derivatives, deletion, and retries

**PASS — LOCAL IMPLEMENTATION**

- Public derivatives use a separate `published/` key namespace and Cloudinary `type=upload`. Their creation is exposed through publication fulfillment code, not the customer upload endpoint. Public reads are performed through publication authorization and delivery code; originals remain in the authenticated namespace.
- The adapter validates provider-returned IDs, type, format, resource type, and byte count. Provider response bodies are not included in surfaced Cloudinary errors.
- Asset deletion checks that the asset is not referenced by saved Design data and has no active publication consent before physical deletion. Failed deletion is recorded as pending/retryable rather than being reported as success. Publication/design cleanup follows the same pending-cleanup pattern.
- Local mock tests cover signed private upload/download, invalid metadata, rejected provider responses without secret leakage, size/type bounds, deletion failure propagation, derivative key validation, and R2 adapter compatibility.
- Actual Cloudinary privacy mode, signed-download behavior, account access controls, CDN caching, remote derivative visibility, deletion semantics, retries, and account-level separation were not exercised against Cloudinary.

### R2/Cloudflare path

**PASS — LOCAL IMPLEMENTATION**

- Vercel explicitly selects Cloudinary or an allowed local/staging mock; it does not select R2. The R2 adapter and D1 provider remain available to the Cloudflare Worker configuration for compatibility/rollback.
- No R2 bucket operation is required by the Vercel deployment path. Wrangler configurations continue to select D1/R2 and remain in the worktree as pre-existing changes.

## 4. Vercel runtime compatibility

**PASS — LOCAL IMPLEMENTATION; deployed behavior UNVERIFIED**

- The Vercel catch-all adapter uses Node `http`, `process.env`, standard Fetch `Request`/`Response`, bounded request-body reads, and Node-compatible APIs. It is tested by importing and invoking the adapter in Node.
- `package.json` declares Node `>=22.6.0`; local validation ran on Node v22.17.0. `@libsql/client` is a production dependency; Wrangler is a development dependency.
- Runtime-specific D1/R2 names are type-level bindings in shared Cloudflare compatibility code. The Vercel path does not choose those adapters or access their bindings. The Vercel path uses `@libsql/client` and Cloudinary.
- Local tests cover Vercel database/storage selection, environment scoping, configuration rejection, and the HTTP adapter. There is no local evidence from a Vercel build or deployed function invocation. Function bundling, platform Node selection, deployment routing, size/duration limits, and platform-specific environment setup remain unverified.
- Environment variable names inspected include `DATABASE_PROVIDER`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `TURSO_STAGING_DATABASE_URL`, `TURSO_STAGING_AUTH_TOKEN`, `STORAGE_PROVIDER`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `CLOUDINARY_STAGING_CLOUD_NAME`, `CLOUDINARY_STAGING_API_KEY`, `CLOUDINARY_STAGING_API_SECRET`, and `CLOUDINARY_STAGING_ISOLATED_ACCOUNT`. Values were not inspected or emitted.

## 5. Confirmed defects and changes

**Confirmed Turso/Cloudinary/Vercel implementation defects: none established.**

No code, migration, deployment configuration, provider setting, or existing QA evidence was changed. No regression test was needed for a confirmed defect. The new report is the only task-created file.

## 6. Regression evidence

All commands were run against local synthetic/in-memory fixtures. No remote provider request was performed.

| Command | Result | Evidence |
|---|---|---|
| `node --experimental-strip-types --test tests/database.test.ts tests/database-contract.test.ts tests/migrate-turso.test.ts tests/storage.test.ts tests/vercel.test.ts` | PASS | 21 tests passed; 0 failed. Local Turso/libSQL, database contract, migration safety, storage, and Vercel tests. |
| `node --experimental-strip-types --test tests/security-headers.test.ts tests/storage.test.ts tests/migrate-turso.test.ts` | PASS | 12 tests passed; 0 failed. Includes Cloudinary, R2 compatibility, migration command boundary, and CSP/security headers. |
| `npm run typecheck` | PASS | `tsc --noEmit`; exit code 0. |
| `npm test` | PASS | 91 passed; 0 failed, cancelled, or skipped. |
| `npm run test:integration` | PASS | `Local integration: passed (D1 API and payment contracts, legacy regression, constraints, and batch rollback).` |
| `npm audit --omit=dev` | PASS | `found 0 vulnerabilities`. |
| `git diff --check` | PASS | Exit code 0; no whitespace errors. |

## 7. Unverified remote requirements and blockers

These are not local failures; they require a later, separately authorized release verification:

1. Confirm Vercel project linkage, Node runtime selection, function bundling, route resolution, deployment environment pairing, and function resource limits.
2. Verify required variable **names and presence** in the correct Vercel Production/Preview environments without disclosing values; verify credential scope and staging/Production separation.
3. Confirm Turso Production database identity, auth/network connectivity, migration ledger and checksums, foreign-key state, and authorized backup/rollback procedures.
4. Confirm Cloudinary account/cloud identity and access scope; validate authenticated original delivery and publication-only public derivatives with synthetic media in the approved non-Production account.
5. Verify provider-side deletion, replacement/cleanup retries, CDN behavior, and operational monitoring through an authorized staging test, with explicit cleanup confirmation.
6. Confirm current Vercel platform support and project-level configuration for the declared Node engine and API function.
7. Preserve and test the existing Cloudflare D1/R2 rollback path independently; this audit did not deploy or alter it.

No staging smoke commands were run because those commands can connect to remote Turso or Cloudinary and create/delete provider-side synthetic resources. No Production or remote resources were accessed or modified.

## 8. Final classification

# PARTIAL — REMOTE VERIFICATION REQUIRED

Local adapter, migration, security, and Vercel contract tests pass, and no confirmed code defect was found. This is not a declaration of Turso or Cloudinary Production readiness; account configuration, remote provider behavior, and deployed Vercel runtime compatibility remain unverified.

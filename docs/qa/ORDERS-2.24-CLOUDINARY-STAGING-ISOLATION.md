# ORDERS-2.24 — Cloudinary Staging Isolation & Storage Readiness

## Verdict

**PARTIAL — REMOTE ACCOUNT VERIFICATION REQUIRED**

Local code and synthetic tests confirm fail-closed Preview/Worker staging
storage selection, Production credential selection, and local mock behavior.
Cloudinary remains disabled in Preview and local development. No staging
Cloudinary account or credentials were accessed or verified, and this work does
not make Preview Cloudinary operational.

## 1. Initial Git baseline and preservation

| Item | State at start |
|---|---|
| Branch | `main` |
| HEAD | `84acc4c19a143805830495671e076bbc395db3e3` |
| Staged changes | None |
| Modified tracked files | Eight pre-existing ORDERS-2.23 files |
| Untracked files | The pre-existing ORDERS-2.23 QA report |

The existing modifications in `docs/DATABASE_SCHEMA.md`,
`docs/VERCEL_STAGING.md`, `scripts/staging-config.ts`,
`scripts/staging-turso.ts`, `src/platform/vercel.ts`,
`tests/database-contract.test.ts`, `tests/staging-config.test.ts`, and
`tests/vercel.test.ts` were preserved. No destructive Git command was used.

## 2. ORDERS-2.23 compatibility

ORDERS-2.23 keeps Vercel Preview on staging-specific Turso credentials and
Production on generic Turso credentials. This task did not alter that database
selection or run its remote preflight.

The storage policy is compatible with that separation: Preview uses explicit
mock storage while Cloudinary is blocked before database/storage initialization.
No storage migration or account fallback was added.

## 3. Storage provider architecture and environment selection

| Runtime | Selected storage behavior | Isolation result |
|---|---|---|
| Vercel Preview (`VERCEL_ENV=preview`, `ENVIRONMENT=staging`) | Explicit `STORAGE_PROVIDER=mock` only | Cloudinary and staging Cloudinary variables are rejected before database connection or storage construction. Generic Production Cloudinary credentials in Preview are rejected; there is no fallback. |
| Vercel Production | Existing `STORAGE_PROVIDER=cloudinary` selection uses only generic Production Cloudinary variables | Preserved. Staging Cloudinary variables cause configuration rejection. |
| Vercel local development | Explicit mock storage with local test mode | Cloudinary provider and Cloudinary credentials are rejected. |
| Legacy Worker staging | Request and scheduled paths reject staging before storage/database initialization | No Cloudinary staging operation is enabled. |
| Legacy Worker local | Existing R2 binding path remains available | Cloudinary provider or credentials are rejected; local R2 behavior remains. |
| Legacy Worker Production | Existing generic Production Cloudinary configuration or R2 path | Generic Cloudinary behavior remains; mixed staging credentials are rejected. |
| Unknown/unpaired environment | No storage provider is selected | Fails closed. |

The shared Cloudinary configuration policy now permits only explicitly
identified Production. It rejects both staging and local environments; a
direct local provider-factory call cannot connect local development to a
Cloudinary account. Vercel Preview's storage guard remains disabled regardless
of a supplied Cloud Name, staging-prefixed variable, or self-asserted flag.
The `MemoryStorageAdapter` is process-local and ephemeral. A failed
Cloudinary configuration does not silently fall back to mock storage.

## 4. Credentials and account identity

- Preview does not map generic Production Cloudinary variables into a staging
  adapter. Generic Production credentials cause scope validation to fail.
- Production does not select `CLOUDINARY_STAGING_*`; their presence is rejected
  before storage use.
- Missing, malformed, unknown-scope, or staging credentials cannot enable the
  Preview Cloudinary adapter.
- A Cloud Name comparison is not account-ownership evidence. A different
  Cloud Name, a variable name containing `STAGING`, or a self-attested
  environment value also does not prove a separate account.
- No local verification flag or account-identity bypass was added.
- Cloudinary failures expose generic messages/statuses; signatures, API
  secrets, and authorization headers are not written to logs. Existing safe
  logging and mocked adapter failure tests remain in place.

The owner approved a separate staging account as the intended architecture.
This task did **not** establish that the account has been created, that its
owner/account identity differs from Production, or that its credentials are
isolated.

## 5. Upload, deletion, delivery, and derivative policy

The Vercel Preview handler was exercised with synthetic configuration and
mocked dependencies for:

- upload-grant creation and uploaded bytes;
- design deletion, which can clean up private assets;
- private Preview asset delivery;
- publication and revocation, which create/delete published derivatives; and
- public derivative delivery.

Every request was rejected with `STORAGE_ISOLATION_ERROR` before database
connection or Cloudinary/mock storage construction. The mock factory was not
used as an implicit fallback.

Cloudinary adapter regression tests use a mocked fetcher only. They cover
signed authenticated private uploads, short-lived private download URLs,
bounded image reads, metadata validation, delete failure handling, and safe
error responses. Added derivative coverage verifies that a derivative is
created from a bounded private source using the expected signed upload policy,
that public delivery uses the published derivative path, and that derivative
deletion is signed and validates its key before any request.

## 6. Legacy Worker isolation

- `workerRequestEnvironment` and the Worker request-scope guard reject
  missing/unknown markers and reject staging requests before adapter use.
- Production Worker requests with staging Cloudinary variables are rejected
  before database/storage use.
- Local Worker Cloudinary selection remains blocked; the R2 local binding
  path remains available.
- The Production Worker regression test constructs the existing generic
  Cloudinary selection with a mock route and performs no provider request.
- Scheduled maintenance remains Production-scoped and rejects staging
  configuration. No Cron or scheduled behavior was changed.

## 7. Storage metadata and migrations

The storage schema is provider-neutral at the metadata layer:
[`0001_initial_schema.sql`](../../migrations/0001_initial_schema.sql) stores
`object_key` and optional `rendition_key` as text, while
[`0005_publication_delivery.sql`](../../migrations/0005_publication_delivery.sql)
stores a `derivative_key`. No Cloudinary account identifier is embedded in
these columns, and no schema migration is required merely to select a
different account.

Schema compatibility does not make stored bytes portable: a key in a new
Cloudinary account does not make the old account's binary available there.
Any future staging seed/cutover must use a separate staging database and
synthetic/new uploads, or a separately approved asset-copy plan. No asset
metadata or binary was read, copied, uploaded, transformed, or deleted. No
migration was changed or run.

## 8. Documentation and configuration changes

The local `.env.example` no longer defines blank generic Cloudinary variables.
The runtime treats defined Cloudinary environment variables as remote
configuration even when blank, so copying such assignments into local
development could fail the local-scope guard. Cloudinary is documented as
Production-only under the current policy.

The Preview setup guide documents a placeholder-only future configuration,
explains that it is currently rejected, and describes owner/reviewer account
verification. This planning template is not an enablement switch; a later
enablement would require verified account evidence and a separately reviewed
code change.

## 9. Files changed by ORDERS-2.24

| File | Change |
|---|---|
| [`.env.example`](../../.env.example) | Removes blank Cloudinary variables from the local mock template |
| [`README.md`](../../README.md) | Clarifies Preview/local mock storage and the Cloudinary gate |
| [`docs/API_SPECIFICATION.md`](../../docs/API_SPECIFICATION.md) | Corrects runtime proxy and Cloudinary environment policy |
| [`docs/HOSTING_MIGRATION.md`](../../docs/HOSTING_MIGRATION.md) | Documents Production-only Cloudinary and the disabled Preview placeholders |
| [`docs/VERCEL_STAGING.md`](../../docs/VERCEL_STAGING.md) | Adds the account-verification gate, placeholder-only future configuration, and owner steps |
| [`src/storage/cloudinary-policy.ts`](../../src/storage/cloudinary-policy.ts) | Restricts Cloudinary configuration resolution to Production |
| [`tests/pre-staging-security.test.ts`](../../tests/pre-staging-security.test.ts) | Covers unverified identities, blocked storage operations, Production selection, and mock behavior |
| [`tests/storage.test.ts`](../../tests/storage.test.ts) | Covers local Cloudinary rejection and signed derivative lifecycle |
| [`tests/worker.test.ts`](../../tests/worker.test.ts) | Covers Production Worker rejection of staging credentials and preserved Production selection |
| [`docs/qa/ORDERS-2.24-CLOUDINARY-STAGING-ISOLATION.md`](ORDERS-2.24-CLOUDINARY-STAGING-ISOLATION.md) | Adds this QA report |

Other modified tracked files and the ORDERS-2.23 report were pre-existing
worktree changes and were preserved.

## 10. Tests and validation

| Check | Result |
|---|---|
| `npm run typecheck` | PASS |
| Focused storage/runtime tests (`storage.test.ts`, `pre-staging-security.test.ts`, `worker.test.ts`, `vercel.test.ts`) | PASS — 52 tests, 0 failures |
| Focused staging guard (`staging-config.test.ts`) | PASS — 15 tests, 0 failures |
| `npm test` | PASS — 129 tests, 26 suites, 0 failures |
| `git diff --check` | PASS |

The test fixtures use synthetic values and mocked storage operations. No
Cloudinary network request was made.

Not run:

- `npm run test:integration`: this task changes storage policy/configuration
  coverage only; focused tests and the complete unit suite cover the affected
  runtime/provider paths.
- `scripts/smoke-cloudinary-staging.ts`: intentionally not run because it is
  designed to create and delete remote Cloudinary assets and requires remote
  credentials. The local guard tests confirm it remains blocked.
- Any Cloudinary account/credential/API verification: prohibited for this
  task.
- Remote Turso, SePay, Vercel environment, deployment, Production, or asset
  operations: prohibited and not performed.

## 11. Owner actions and remaining verification

Before any later Preview Cloudinary enablement, an authorized owner must:

1. Verify the separate staging account directly in the Cloudinary account
   console and confirm its owner/account identity is distinct from Production.
2. Confirm staging credentials were issued only by that account and are not
   Production credentials; keep all secret values in the approved secret
   manager.
3. Have an independent security reviewer inspect the non-secret evidence and
   proposed code-level identity contract.
4. Request a separate implementation/review that deliberately changes the
   staging guard and adds negative tests. Merely adding environment variables
   must continue to fail closed.

The remote staging account's existence, ownership, credentials, and separation
remain **NOT VERIFIED**. Cloudinary is not operational in Vercel Preview.

## 12. Final Git state and safety

| Item | Final state |
|---|---|
| Branch | `main` |
| HEAD | `84acc4c19a143805830495671e076bbc395db3e3` |
| `origin/main` | `84acc4c19a143805830495671e076bbc395db3e3` |
| Staged changes | None |
| `git diff --check` | PASS |

Modified tracked files:

- `.env.example`
- `README.md`
- `docs/API_SPECIFICATION.md`
- `docs/DATABASE_SCHEMA.md`
- `docs/HOSTING_MIGRATION.md`
- `docs/VERCEL_STAGING.md`
- `scripts/staging-config.ts`
- `scripts/staging-turso.ts`
- `src/platform/vercel.ts`
- `src/storage/cloudinary-policy.ts`
- `tests/database-contract.test.ts`
- `tests/pre-staging-security.test.ts`
- `tests/staging-config.test.ts`
- `tests/storage.test.ts`
- `tests/vercel.test.ts`
- `tests/worker.test.ts`

Untracked files:

- `docs/qa/ORDERS-2.23-TURSO-STAGING-DATABASE-ISOLATION.md`
- `docs/qa/ORDERS-2.24-CLOUDINARY-STAGING-ISOLATION.md`

The ORDERS-2.23 files were pre-existing worktree changes. They remain
unmodified by this task and are not attributed to ORDERS-2.24.

No secret values were read or printed. No Cloudinary, Production, Turso,
SePay, Vercel, or remote storage resource was accessed or modified. No email,
payment, deployment, migration, commit, push, merge, or Git-history operation
occurred.

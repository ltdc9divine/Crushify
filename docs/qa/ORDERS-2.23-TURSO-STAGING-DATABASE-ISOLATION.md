# ORDERS-2.23 — Turso Staging Database Isolation

## Verdict

**PARTIALLY READY — local configuration isolation and regression tests pass.**

The checked-in code selects staging-specific Turso credentials for Vercel
Preview, rejects unsafe credential scopes, and pins local staging migration
commands to an explicitly confirmed staging hostname. Required local quality
gates pass. No remote Turso target, Vercel environment assignment, database
ownership, or token scope was verified. Do not run a remote preflight or
migration until an authorized owner has independently confirmed those facts.

## 1. Git baseline and preservation

Before the GitHub update, the local branch was `main` at
`5205f730fd0141fb9c8d0697787b700e4bda04ff`; `origin/main` was at
`84acc4c19a143805830495671e076bbc395db3e3`. The worktree was clean and local
`main` was two commits behind. The update was applied with
`git pull --ff-only origin main`; it fast-forwarded to
`84acc4c19a143805830495671e076bbc395db3e3`.

The post-update worktree was clean before this task's edits. No reset, checkout,
clean, stash, commit, push, merge, or deployment was performed. No remote
database, storage, payment provider, or deployment configuration was accessed.

## 2. Implemented behavior

### Vercel database selection

- Preview must be explicitly classified as staging and use
  `DATABASE_PROVIDER=turso` with `TURSO_STAGING_DATABASE_URL` and
  `TURSO_STAGING_AUTH_TOKEN`.
- The Vercel adapter passes only that staging URL/token pair to the generic
  Turso provider. It does not fall back to `TURSO_DATABASE_URL` or
  `TURSO_AUTH_TOKEN`.
- Production uses only the generic Production pair and rejects staging-pattern
  hostnames. Preview rejects the presence of generic Turso credentials and
  malformed or non-staging database URLs.
- Local Vercel development continues to require an explicit `file:` database;
  it cannot use either remote credential scope.
- URL validation rejects URL credentials, query strings, fragments, ports, and
  non-file database paths. Local file paths remain supported.

### Staging migration target

- Both preflight and migration require a local staging profile, staging-only
  Turso credentials, and exact database, group, region, and hostname
  confirmations.
- `TURSO_CONFIRM_HOSTNAME` must exactly match the hostname in the staging
  `libsql:` URL; the hostname must follow the configured staging naming
  pattern. Generic Turso Production credentials and conflicting Vercel scopes
  are rejected.
- Only explicit `--preflight` and `--migrate` modes are accepted. Applying
  migrations additionally requires
  `TURSO_MIGRATE_CONFIRM=I_CONFIRM_APPLY_STAGING_MIGRATIONS`.
- These confirmations prevent accidental mismatches but do **not** prove
  provider account ownership, database identity, token scope, or separation
  from Production.
- The remote `scripts/staging-turso.ts` entry point was not executed. The
  integration suite and migration configuration tests use local files and
  synthetic values only.

### Canonical paths

- The documented Vercel Preview/Turso remote migration path is
  `scripts/staging-turso.ts --preflight`, followed only after separate owner
  approval and review by `scripts/staging-turso.ts --migrate`.
- `npm run db:migrate:turso` is for local SQLite files only.
- `npm run db:apply:staging` is the legacy Worker/D1 path, not the Vercel
  Preview/Turso path.
- No migration or remote preflight was run as part of this task.

## 3. Files changed

| File | Change |
|---|---|
| [`src/platform/vercel.ts`](../../src/platform/vercel.ts) | Validates and selects environment-scoped Turso configuration; preserves local file-backed databases |
| [`scripts/staging-config.ts`](../../scripts/staging-config.ts) | Rejects Production scope/credentials, binds the migration target to the exact confirmed hostname, and validates explicit mode |
| [`scripts/staging-turso.ts`](../../scripts/staging-turso.ts) | Uses the shared staging target resolver before creating a Turso client |
| [`tests/vercel.test.ts`](../../tests/vercel.test.ts) | Covers Preview/Production/local configuration selection and fail-closed cases |
| [`tests/staging-config.test.ts`](../../tests/staging-config.test.ts) | Covers hostname pinning, scope rejection, and pure preflight/migration-target validation |
| [`tests/database-contract.test.ts`](../../tests/database-contract.test.ts) | Configures the synthetic contract test with explicit local mode and an in-memory email sink |
| [`docs/VERCEL_STAGING.md`](../../docs/VERCEL_STAGING.md) | Documents the Preview variables, hostname pin, owner-verification limits, and canonical migration path |
| [`docs/DATABASE_SCHEMA.md`](../../docs/DATABASE_SCHEMA.md) | Corrects the Vercel/Turso runtime description and states that tests use local files |

No dependency, payment, authentication, hosting, or database architecture
change was made.

## 4. Verification

| Gate | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm test` | PASS — 123 tests, 26 suites, 0 failures |
| `npm run test:integration` | PASS — local D1 API/payment contracts, regression coverage, constraints, and batch rollback |
| `npm audit --omit=dev` | PASS — 0 vulnerabilities |
| `git diff --check` | PASS |
| Focused configuration/runtime tests | PASS — 40 tests, 0 failures |

The integration runner bound to loopback, used local D1 persistence and a
local-only synthetic email sink, then shut down. After completion, port 8787
had no listener and no recent task-prefixed D1 integration directory remained.
No provider request was made by the configuration unit tests.

An initial full test run exposed two issues that were resolved before the
passing rerun:

1. The stricter database URL check rejected valid local `file:` URL paths,
   which caused local Vercel API tests to fail initialization. File-backed
   paths are now allowed while file URL hosts and query strings remain
   rejected.
2. The local Turso contract fixture relied on a mail binding only available
   in Production. The fixture now explicitly uses local test mode and an
   in-memory synthetic email sink; application mail policy was not weakened.

## 5. Remaining verification and blockers

- Remote staging database ownership, actual hostname, group, region, token
  scope, schema state, and separation from Production are **NOT VERIFIED**.
- Vercel Preview environment assignments and deployed runtime behavior are
  **NOT VERIFIED**.
- No remote staging preflight or migration was attempted. This is intentional:
  the task is local-only and prohibits remote database access.
- The hostname confirmation is an accidental-target guard, not an
  authorization or ownership proof.

An authorized resource owner must independently verify the provider-side
database identity and Preview variable assignments before any separately
approved remote preflight. This report does not authorize applying migrations.

## 6. Final Git and safety state

- Branch: `main`
- HEAD: `84acc4c19a143805830495671e076bbc395db3e3`
- `origin/main`: `84acc4c19a143805830495671e076bbc395db3e3`
- Modified tracked files: the eight files listed above.
- Staged changes: none.
- Untracked files: this QA report.
- `git diff --check`: passed.

All work and tests were local-only. No Production database, storage, payment,
customer data, or deployment setting was accessed or changed. No real order,
payment, or email was created or sent. No commit, push, merge, or deployment
occurred. The local integration service and temporary data were cleaned up.

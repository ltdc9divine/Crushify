# ORDERS-2.18B — Cloudinary Isolation Remediation

## Verdict

**PARTIAL — REMOTE ACCOUNT VERIFICATION REQUIRED**

The local Vercel Preview and legacy Worker staging paths now reject Cloudinary before adapter initialization. Staging continues to use its explicitly configured mock/R2 provider. Production Cloudinary selection remains available with the existing generic production variables.

This local block is intentional: source code cannot prove Cloudinary account ownership or that a key belongs to a separate staging account without authenticated provider-side verification. No remote identity has been verified, and Cloudinary staging is not enabled.

## Original ORDERS-2.18A findings

1. Comparing `CLOUDINARY_STAGING_CLOUD_NAME` with a Production cloud-name string did not prove that the configured staging API key/secret belonged to another account. Production credentials could be copied under staging variable names.
2. `src/storage/provider.ts` could instantiate the Cloudinary adapter without running the Vercel-only staging identity guard. The staging Worker configuration currently selects R2, but the provider factory itself did not enforce that boundary.

## Architecture and changes

### Provider paths before remediation

- **Vercel API and Cron:** `src/platform/vercel.ts` selected staging-specific credentials for Preview and compared the staging cloud name with a configured Production cloud name before constructing Cloudinary storage. The comparison could not authenticate account or key ownership.
- **Cloudflare Worker API and scheduled lifecycle:** `src/index.ts` called `createStorageFromEnvironment` in `src/storage/provider.ts`. That factory selected R2 when configured, otherwise it could instantiate Cloudinary from generic credentials without environment-aware isolation checks.
- **Cloudinary smoke script:** `scripts/smoke-cloudinary-staging.ts` constructed the adapter after its local staging configuration helper, which also relied on cloud-name comparison and synthetic-data opt-in.
- **Current checked-in deployment configs:** `wrangler.jsonc` and `wrangler.staging.jsonc` explicitly select R2. Vercel Preview supports mock storage. These defaults are preserved; no provider was silently switched.

### Provider paths after remediation

- `src/storage/cloudinary-policy.ts` contains the shared Cloudinary configuration resolver. It requires an explicitly identified `local` or `production` environment, rejects staging, rejects staging-only fields outside staging, and validates the generic Cloudinary configuration before returning credentials.
- `src/platform/vercel.ts` rejects `STORAGE_PROVIDER=cloudinary` and any staging Cloudinary variables in Preview during environment validation, before database or storage initialization. `createStorage` also invokes the shared resolver before the real or injected Cloudinary factory, providing a second guard. Production still resolves the existing generic Cloudinary variables.
- `src/storage/provider.ts` invokes the same resolver before constructing `CloudinaryStorageAdapter`. Since the Worker’s configured staging environment is `staging`, the Worker API and scheduler cannot initialize Cloudinary. The Worker returns/raises the controlled isolation error; it does not fall back to another provider.
- `scripts/staging-config.ts` delegates to the shared resolver. The Cloudinary staging smoke script therefore fails before adapter construction while staging support remains disabled.
- `STORAGE_PROVIDER=r2` remains explicit and requires an R2 binding. Vercel’s `STORAGE_PROVIDER=mock` remains explicit and Preview-only/local-test-only as before.

### Invariants enforced

- Staging Cloudinary is disabled regardless of whether configuration contains missing fields, complete-looking staging fields, Production-looking cloud identifiers, or a self-declared confirmation string.
- An unknown environment cannot construct Cloudinary storage.
- Preview’s generic Production credentials remain rejected by the existing Vercel scope guard.
- Production staging-only credential fields remain rejected by the existing Vercel scope guard and by the shared resolver.
- No factory fallback silently substitutes R2, mock, or another provider when Cloudinary configuration is rejected.
- Cloudinary errors contain no credential values. The shared policy returns fixed messages and an error code.
- The policy does not claim that a different cloud name proves a separate remote account.

## Files changed for ORDERS-2.18B

- `src/storage/cloudinary-policy.ts` — new shared environment/configuration policy and typed safe errors.
- `src/storage/provider.ts` — Worker/provider factory now uses the shared policy.
- `src/platform/vercel.ts` — Preview rejection before dependency initialization; shared resolver also guards Vercel storage construction.
- `src/index.ts` — Worker API returns the shared storage-isolation error code/message without logging credentials.
- `src/types.ts` — carries staging Cloudinary environment names into the shared provider contract.
- `scripts/staging-config.ts` — Cloudinary staging smoke preflight uses the shared policy and refuses unsupported staging Cloudinary.
- `docs/VERCEL_STAGING.md` — documents disabled staging Cloudinary and retained R2/mock paths.
- `tests/storage.test.ts` — tests unknown/incomplete environment, Production selection, unsafe staging config, and R2 behavior.
- `tests/worker.test.ts` — exercises the Worker API entry point and provider factory rejection; verifies R2 staging selection.
- `tests/pre-staging-security.test.ts` — verifies Vercel Preview rejects Cloudinary before database/storage factories and retains mock storage.
- `tests/staging-config.test.ts` — verifies staging smoke preflight rejects Cloudinary despite apparently complete configuration.
- `tests/vercel.test.ts`, `tests/scheduler.test.ts` — lifecycle/payment Preview fixtures use the supported mock provider rather than expecting Cloudinary.

No changes were made to `src/storage/cloudinary.ts`, `src/storage/r2.ts`, or either Wrangler provider selection.

## Regression results

| Command | Result |
|---|---|
| `node --experimental-strip-types --test tests/storage.test.ts tests/staging-config.test.ts tests/vercel.test.ts tests/scheduler.test.ts tests/worker.test.ts tests/pre-staging-security.test.ts` | PASS — 54 tests, 0 failures |
| `npm run typecheck` | PASS |
| `npm test` | PASS — 105 tests, 0 failures |
| `npm run test:integration` | PASS — local D1 API/payment contracts, legacy regression, constraints, and batch rollback |
| `npm audit --omit=dev` | PASS — 0 production dependency vulnerabilities reported |
| `git diff --check` | PASS |

All tests use synthetic values and local/injected adapters. Tests did not make Cloudinary, Turso, SePay, email, Vercel, or other external-service calls. No migration, upload, deletion, deployment, or Production operation was performed.

## Residual limitations and bypass review

- **Remote identity remains unverified.** Local code cannot establish Cloudinary account ownership, credential permissions, or whether independently provisioned credentials can affect another account. Cloudinary stays disabled in staging until an independently reviewed design and authorized owner verification allow an explicit re-enablement.
- **Current runtime construction paths are guarded:** Vercel API/Cron, Worker API/scheduler through the shared storage factory, and the staging smoke script all reach the shared policy before constructing the adapter.
- `CloudinaryStorageAdapter` remains a directly constructible class for adapter-level tests and production construction. A future runtime that imports and constructs it directly instead of using the guarded factory could bypass environment policy; new runtime call sites must use the shared resolver/factory.
- Mock Preview storage remains ephemeral and is not suitable for durable media. Worker staging remains configured for R2 and is not switched by this change.
- Remote Vercel environment assignments and actual Cloudinary account/key settings were not inspected.

## Git and safety status

Initial state at task start: branch `main`, HEAD `5205f730fd0141fb9c8d0697787b700e4bda04ff`, 36 modified tracked files, 13 untracked files, and no staged changes. The existing worktree and historical QA reports were preserved.

Final branch and HEAD are unchanged. The final worktree includes the existing modifications plus the ORDERS-2.18B changes and this report. Nothing is staged. `git diff --check` passes.

No external provider, Production resource, Vercel API, or deployment operation was performed. No commit, push, or merge was made.

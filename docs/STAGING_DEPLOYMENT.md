# Crushify staging deployment

## Isolation and current status

- Wrangler is authenticated to the intended Cloudflare account.
- Dedicated D1: `crushify-staging-db` (APAC). Migrations `0001_initial_schema.sql` and `0002_auth_previews_and_uploads.sql` are applied. The database contains no test/customer rows.
- Dedicated Worker config: [wrangler.staging.jsonc](../wrangler.staging.jsonc), Worker name `crushify-staging`; static assets are served by the Worker when deployed.
- R2 bucket `crushify-staging-media` has **not** been created. Cloudflare API reports that R2 must first be enabled for the account in the Cloudflare Dashboard. No staging Worker is deployed until this is resolved.
- Production is not configured or deployed. Do not use production database IDs, secrets, or resources in this guide.

## Required account setup

1. In Cloudflare Dashboard, enable R2 Object Storage for the verified account. This may require accepting terms or setting up billing.
2. Verify an email-sending domain with Resend and create a restricted API key for staging only. Do not paste the key into chat or commit it.
3. Use a sender address on that verified domain. Replace the placeholders in `staging.vars.example` and set `APP_ORIGIN` after the Worker URL is known.

## Staging-only commands

After enabling R2:

```powershell
npx wrangler r2 bucket list
npx wrangler r2 bucket create crushify-staging-media
npm run db:apply:staging
npm run deploy:staging
```

The staging config explicitly binds `DB` to `crushify-staging-db` and `MEDIA` to `crushify-staging-media`. The root `wrangler.jsonc` remains local-only. Review config and account identity before every remote command.

After first deployment, set `APP_ORIGIN` to the exact HTTPS Worker origin (no trailing slash) in `wrangler.staging.jsonc`. Set the sender address in the staging vars. Add the API key as a Worker secret through the interactive CLI prompt:

```powershell
npx wrangler secret put MAIL_API_KEY --config wrangler.staging.jsonc
npm run deploy:staging
```

Enter the key only into the local Wrangler prompt. Do not use `LOCAL_TEST_MODE` in staging. `ENVIRONMENT=staging` prevents the local console email adapter and insecure local cookies from being enabled.

## Required cloud acceptance checks

Do not treat local Wrangler emulation as evidence that staging works. From the public HTTPS staging URL, verify:

- Health readiness, static homepage and Our Universe load.
- A real Resend magic link arrives; the token is not in the API response, request query, or production logs; token is single-use and expires.
- Session cookies include `Secure`, `HttpOnly`, and `SameSite=Lax`; mutations reject missing/invalid CSRF and cross-origin requests.
- Create, update, reload, and revision conflict behavior in staging D1.
- R2 valid upload, completion, owner-only read, anonymous/other-owner rejection, deletion, invalid MIME, and oversize rejection.
- Preview opens in a separate browser profile, contains only the authorized design/photos, and rejects revoked/expired tokens.
- Mobile viewport, browser console, and network requests.

The staging Worker and bucket remain undeployed until R2 is enabled and the real email sender/API key are configured. Payment, publishing, and production deployment are explicitly out of scope.

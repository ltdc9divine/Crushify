# Production Hosting Evaluation

**Survey date:** 2026-11-18

**Status:** Evaluation only. No provider has been selected, registered, configured, or deployed.

## Executive summary

**Best source-fit: Vercel Pro.** It is the only candidate with an existing Crushify adapter and routing configuration. Pro supports Singapore (`sin1`) Functions, usage-credit billing, and frequent Cron execution. It minimizes hosting changes, but does not remove the need to separate webhook acknowledgment from publication work. The current function route is configured for 60 seconds; it can remain comfortably bounded once the webhook only persists settlement and a job.

**Best traditional web/worker alternative: Render Pro.** Render has explicit web service, background worker, Cron, health-check, and Singapore-region support. Its service model maps cleanly to the existing durable Turso fulfillment jobs, but it requires a Node HTTP/static-hosting adapter and costs more at minimum.

These are recommendations for the owner to compare, not a hosting decision. Railway Pro is a credible lower-cost usage-based alternative, but its Cron cadence is at least five minutes and its service adapter still needs to be built. Fly.io is technically flexible and has Singapore Machines, but has the highest operations burden for this repository.

The estimates exclude Turso, Cloudinary, SePay, taxes, optional support, and any domain purchase. The owner explicitly postponed a custom domain and ruled out Vercel Hobby for Production. Cloudflare is not considered a default candidate.

## Current Crushify compatibility baseline

- The project uses Node.js `>=22.6.0` and npm (`package.json`). Render currently defaults newly created services to Node 24, and recommends specifying an upper bound or explicit version. Pin and test the exact Node version before any host migration.
- Production API deployment currently uses Vercel’s Node Function adapter and Vercel-specific routing (`api/[...path].ts`, untracked `api/v1.ts`, and `vercel.json`). The API delegates to the shared router. Vercel can host the existing static site and API together with the least change.
- Render, Railway, and Fly can build/deploy Node applications from a repository or container, but they are **not drop-in replacements** for Vercel’s function adapter. They need a Node HTTP server/adapter and a same-origin strategy for the static site, API routes, and `/p/:slug` publication URLs. The business router can potentially be reused; this has not been tested.
- The source already has a Turso/libSQL provider and Cloudinary adapter. Other Node hosts can make outbound connections to those services in principle, but the current Vercel environment validation, Production/Preview credential mapping, route origin handling, and request-body bridge are host-specific. Reimplement and test isolation rather than copying Vercel’s environment assumptions.
- The Preview Turso hostname allowlist includes a Singapore-region host. Vercel, Render, Railway, and Fly all document Singapore as an available compute region; the actual database location, provider account configuration, and network latency were not verified.
- The current Vercel API function sets `maxDuration: 60`. The current Production lifecycle Cron is daily at `03:00 UTC` in `vercel.json`. No live Vercel project or schedule was inspected.
- Static assets can use a provider CDN, while published websites currently depend on the application/storage path. Do not treat ephemeral host filesystems as durable publication storage.
- Documentation note: the older [`HOSTING_MIGRATION.md`](./HOSTING_MIGRATION.md) describes Vercel as the intended host. This evaluation follows the newer owner decision that Production hosting is **not selected** and does not change that earlier document.

## Comparison at a glance

| Provider | Current-code fit | Worker and schedule fit | Singapore | Minimum practical Production estimate | Main trade-off |
|---|---|---|---|---:|---|
| **Vercel Pro** | **Highest**: adapter, static routes, and project configuration already exist | Cron can run every minute on Pro; Queues/Daemons are available in beta, but are not required for a first implementation using the existing Turso job table | Yes (`sin1`) | **$20/month platform fee**, including $20 monthly usage credit; on-demand usage above credit costs extra | Lowest migration effort. Must explicitly set a Singapore Function region; current schedule and webhook path need changes. |
| **Render Pro** | Medium: Node and same-repo deployments supported, but needs a conventional Node server/route adapter | First-class continuous workers and Cron. Docs show a ten-minute example; confirm the minimum interval and timing behavior for the desired schedule. A run is delayed if the prior run is still active; single-run guarantee prevents overlapping runs for that Cron service. | Yes | About **$33/month** for a small web service plus Cron, or about **$39/month** for web + always-on worker, before bandwidth overage. | Strong conventional worker model; Pro workspace fee plus service compute makes it more expensive. |
| **Railway Pro** | Medium: Railpack supports Node and builds a repo into a service; needs a web server adapter and service-specific start commands | Supports separate long-running services and Cron. Cron must be at least five minutes apart and timing may vary by minutes; a still-running prior invocation can cause the next run to be skipped. | Yes (`asia-southeast1`) | **$20/month minimum plan fee**, with $20 of included resource usage; actual monthly bill rises if usage exceeds credit. | Cost-efficient at small usage, but metered usage and five-minute Cron cadence. |
| **Fly.io** | Lowest: container/Machine deployment; no Crushify adapter or Docker deployment was found in the reviewed source | Long-running Machine/process group can poll the existing Turso jobs. A provider-managed Cron offering was not verified; an always-on worker or separately operated scheduler is needed. | Yes (`sin`) | Roughly **$17/month** for two always-on 1 GB Singapore Machines, plus outbound data; a single Machine is cheaper but couples API and worker failure domains. | Most control and potentially low compute cost, but greatest setup, deployment, monitoring, and recovery responsibility. |

“Practical estimate” is a small initial footprint, not a quote or a guaranteed production sizing. CPU/memory, job duration, traffic, egress, and service-plan eligibility require owner/provider confirmation.

## Provider findings

### Vercel Pro

**Compatibility — high / verified in source for the current host.** The current repository already has a Vercel Node Function adapter, rewrites, static path handling, and a Production Cron endpoint. The adapter exposes the shared API router and currently has a 60-second `maxDuration`. Vercel documents full Node.js Function API coverage and up to 800 seconds maximum duration on Pro (subject to function configuration and applicable limits). Current function request/response payload limits are documented separately; Crushify already bounds image uploads at 4 MiB.

**Worker/schedule.** The existing durable Turso `fulfillment_jobs` table can be polled by a short, bounded scheduled Function; that does not require adding a continuous worker. Vercel’s Cron Jobs documentation says Pro supports once-per-minute schedules with per-minute precision; Hobby is limited to once daily with ±59-minute timing. Newer Vercel Schedules documentation is beta and has different limits: Hobby schedules can run no more frequently than every 15 minutes, while Pro supports every minute with a one-minute jitter window. Confirm which scheduling product/configuration will own the final schedule. Vercel Queues and Daemons are also beta; Daemons are Production-only during beta, so they should not be a launch-critical dependency without separate evaluation.

**Region and security.** Singapore (`sin1`) is available for Functions, but new projects default to Washington, D.C. (`iad1`). Select Singapore deliberately to reduce distance to a Singapore Turso database. Static content is served by the global CDN. Vercel Pro provides environment separation, secrets, spend controls, deployment history, and team access; verify the project’s actual settings and alert thresholds.

**Cost.** Current Pro platform fee is $20/month, includes one paid deploying seat and $20/month usage credit. The minimum hosting bill is therefore approximately **$20/month** if this workload remains within included credit; metered usage beyond it is additional. Pricing lists 1 TB monthly CDN transfer on Pro; other compute/network resources are metered. No new worker service is needed if the existing durable job table is processed by a Cron Function.

**Risks and unknowns.** The current daily Cron is inadequate for timely delivery; use a more frequent Pro schedule after design approval. The webhook currently waits on fulfillment (called from `src/payments.ts`), so plan tier alone does not solve acknowledgment latency. Vercel Queues/Daemons are beta and not recommended as a required first-release dependency. Verify Singapore latency to the actual database/storage accounts, function runtime, usage, commercial account eligibility, and any relevant rate/size limits.

### Render

**Compatibility — viable with adapter work.** Render supports Node web services, static sites, private services, background workers, and Cron jobs from a linked Git repository or Docker image. Its web service expects an HTTP server binding to `0.0.0.0` and `PORT`; Crushify currently exports Vercel Function handlers rather than a conventional server process. Either serve static files and API routes on one web service or design a same-origin proxy/routing arrangement; separate Render static and web-service subdomains would need explicit CORS/cookie/publication URL validation.

**Worker/schedule.** Render background workers are continuous services and can consume work from an existing database-backed queue. Cron jobs support cron expressions (the retrieved official docs show an every-ten-minute example), have run history/logs, are billed by active seconds with a $1/month minimum per Cron service, and Render guarantees at most one active run for a given Cron service. A next run is delayed until the current run finishes; Cron jobs cannot use persistent disks. Render stops Cron runs after 12 hours. The minimum interval and scheduling jitter were not specified in the pages retrieved; confirm the desired cadence with Render before selecting this option. For Crushify, keep the Turso job state authoritative and use bounded tasks; do not introduce a Redis queue solely to satisfy the hosting model.

**Region and operations.** Singapore is available. Web services support health checks, and Render restarts unhealthy running web/private instances. Runtime logs and deployment/run history are available; Pro adds HTTP request logs. Node version can be set using `NODE_VERSION`, `.node-version`, `.nvmrc`, or `engines`. Render’s current guidance says to bound `engines`; the repository currently has only `>=22.6.0`.

**Cost.** Current Render pricing lists a Pro workspace at $25/month, plus service compute. The smallest paid web/background-worker plan shown is 0.5 CPU/512 MB at $7/month. A static site has no compute charge. A minimal Pro design with a web service plus a Cron job is approximately **$25 + $7 + $1 = $33/month**, before any Cron runtime above the minimum and bandwidth over 25 GB/month (then $0.15/GB). A web service plus an always-on worker is approximately **$39/month** before any Cron needed for lifecycle tasks and bandwidth. A small production plan may need more than 512 MB; benchmark before treating this as a sizing recommendation.

**Risks and unknowns.** No hard web-request duration limit or maximum request-body limit was confirmed in the official pages retrieved for this report. Confirm the current limits and verify SePay’s sub-30-second acknowledgment path. Preview environments require a Pro workspace. Confirm account availability, regional capacity, effective plan pricing at checkout, and Turso/Cloudinary latency.

### Railway

**Compatibility — viable with adapter work.** Railway’s Railpack recognizes Node and builds services from a repository; alternatively, use a Dockerfile. The current Vercel handler still needs a Node HTTP adapter and a plan for serving the static website and `/p/:slug` on the same origin. Multiple services can use the same source with distinct commands/configuration; deploy the API and worker separately if choosing this host.

**Worker/schedule.** A separate long-running worker can poll `fulfillment_jobs` in Turso. Railway Cron is intended for short-lived tasks that exit. Schedules must be at least five minutes apart; timing can vary by several minutes, and if a previous run is still active, the next run is skipped. A continuous worker avoids Cron latency, but requires clean shutdown and lease handling. The documented HTTP network limit allows requests up to 15 minutes if data keeps transferring, otherwise closes them after five minutes idle; uploaded request bodies must finish within five minutes. A fast webhook response remains a Crushify responsibility.

**Region and operations.** Singapore (`asia-southeast1`) is listed. Public services have HTTPS domains and managed certificates; health checks are used to gate deployment activation, not as ongoing health monitoring. Pro has 30-day log history and deployment rollback retention of 120 hours. Plan variables can be shared or scoped to individual services/environments; configure Preview and Production as distinct environments and confirm service-level variable scope.

**Cost.** Pro is $20/month per workspace, including $20 resource usage credit; usage over the credit increases the bill. Resource rates include $10/GB RAM-month, $20/vCPU-month, and $0.05/GB service egress. A small always-on API and worker with 512 MB each uses about $10/month of memory before CPU/egress; the plan’s $20 usage credit may cover a small workload, but this depends on actual CPU and traffic. Treat **$20/month as the minimum**, not a guaranteed total. Hobby’s $5 plan is described for personal projects; Pro is Railway’s stated plan for teams shipping to Production.

**Risks and unknowns.** Cron is not a precise one-minute trigger; use a persistent worker if a five-minute-or-variable processing delay is unacceptable. Cost depends on uptime and CPU usage. Confirm current account/workspace/environment separation, alerting, effective network rates, and Turso/Cloudinary performance.

### Fly.io

**Compatibility — technically feasible with the most platform work.** Fly runs containerized Node applications on Machines. Crushify would need a Dockerfile, conventional HTTP server/adapter, static asset/publication routing, deployment configuration, health checks, and explicit Production/Preview secret and app separation. Turso and Cloudinary remain external services; a local Machine filesystem must not become the publication database or canonical asset store.

**Worker/schedule.** An API Machine and separate worker Machine/process group can use the existing Turso jobs with leases and idempotency. A separate always-on worker avoids running publication inside the webhook request. I did not verify a first-party managed Cron service in the official Fly docs reviewed; periodic work would require a continuously running worker, an independently operated scheduler, or another explicitly approved mechanism. Avoid treating an in-process timer as durable job delivery.

**Region and operations.** Singapore (`sin`) is available. Machines can be placed by region, but regional capacity is best-effort and placement may fail. Shared IPv4 and IPv6 are free; Fly provides TLS/service configuration. Managed Prometheus-compatible metrics/Grafana are currently documented at no additional charge, with approximately 15-day metrics retention. Logs, alert delivery, support, capacity, and operational procedures need deliberate setup.

**Cost.** Fly has no monthly platform fee and bills Machines by running time. Current pricing lists a Singapore 1 GB shared-cpu-1x Machine at about $8.50/month. Two always-on 1 GB Machines (API + worker) are therefore approximately **$17/month**, plus Asia-Pacific outbound transfer at $0.04/GB and any optional volumes/IPs/support. Lower-memory or autoscaled configurations can cost less, but this is not a recommendation to co-locate critical components or scale the API to zero.

**Risks and unknowns.** No managed Cron was verified, and there is no existing Fly deployment bundle. The owner would assume more responsibility for Docker, VM lifecycle, deployment and rollback, region capacity, logs/alerts, and service recovery. Confirm practical capacity in Singapore, current region pricing, deployment behavior, and Turso/Cloudinary network paths.

## Shared architecture, safety, and cost considerations

- **SePay response time:** SePay’s official webhook integration documentation requires a successful response within 30 seconds. On any host, acknowledge only after signature, timestamp, transaction matching/idempotency, settlement evidence, and the fulfillment job are durably persisted. Do not perform publication before acknowledgment.
- **Job processing:** Existing Turso inbox/job/lease/retry state is sufficient for the initial design. Vercel Pro frequent Cron, Render Cron, Railway Cron, or a continuous worker can trigger it. Choose based on acceptable delivery delay, then bound job batches and ensure retry/lease logic survives process termination.
- **Environment isolation:** Host dashboards do not prove Preview/Production separation by themselves. Use distinct database and payment secrets, isolate Cloudinary credentials, fail closed when any required setting is missing, and test that Preview cannot update Production records. Vercel currently has the most source-level mapping; non-Vercel hosts require new adapter/config validation.
- **Database and storage:** No provider estimate here includes Turso or Cloudinary. Do not assume hosting includes durable relational storage, publication object storage, database PITR, or a backup/restore procedure. Confirm the actual Turso plan/region/restore capability with the account owner separately.
- **Domain:** All candidates offer a provider URL for initial use. This evaluation does not recommend buying or configuring a custom domain.
- **Taxes and usage:** Prices are USD, before taxes and subject to change. Estimates exclude burst usage, logging add-ons, paid support, data transfer beyond included allowances, and account-specific terms. Use the provider’s current calculator/checkout before the owner approves a plan.

## Recommendation for owner decision

1. **Vercel Pro — preferred by current source compatibility.** Lowest change risk, existing Vercel adapter, Singapore Functions, and one-minute Pro Cron. Keep core job durability in Turso; do not make beta Queues/Daemons a required dependency without further review. Budget at least $20/month plus usage beyond the included $20 credit.
2. **Render Pro — preferred if a distinct traditional worker is the primary requirement.** Clear web/worker/Cron model, Singapore region, health checks, and service logs. Budget approximately $33/month for web+Cron or $39/month for web+worker before overages; adapt the API and same-origin static/publication routing.

Railway Pro remains a reasonable owner-selected alternative if $20 usage-credit billing and five-minute/variable Cron behavior fit the service-level objective. Fly.io is technically viable but not recommended as the first move for this repository due to the adapter/container/scheduler/operations work.

**No provider is selected in this report.**

## Official sources consulted (accessed 2026-11-18)

### Vercel

- [Pricing](https://vercel.com/pricing)
- [Pro plan and monthly credit](https://vercel.com/docs/plans/pro-plan)
- [Hobby plan](https://vercel.com/docs/plans/hobby)
- [Cron Jobs usage and pricing](https://vercel.com/docs/schedules/cron-jobs/usage-and-pricing)
- [Schedules limits](https://vercel.com/docs/schedules/limits)
- [Function limits](https://vercel.com/docs/functions/limitations)
- [Configuring Function regions](https://vercel.com/docs/functions/configuring-functions/region)
- [Supported regions](https://vercel.com/docs/regions)
- [Vercel Queues](https://vercel.com/docs/queues)
- [Vercel Daemons](https://vercel.com/docs/daemons)

### Render

- [Pricing](https://render.com/pricing.md)
- [Compute plans](https://render.com/docs/compute-plans.md)
- [Node.js version](https://render.com/docs/node-version)
- [Web services](https://render.com/docs/web-services.md)
- [Background workers](https://render.com/docs/background-workers.md)
- [Cron jobs](https://render.com/docs/cronjobs.md)
- [Regions](https://render.com/docs/regions)
- [Health checks](https://render.com/docs/health-checks.md)
- [Logs](https://render.com/docs/logging.md)
- [Environment variables](https://render.com/docs/environment-variables)

### Railway

- [Pricing](https://railway.com/pricing)
- [Pricing plan details](https://docs.railway.com/pricing/plans)
- [Railpack supported languages](https://docs.railway.com/builds/railpack)
- [Cron jobs](https://docs.railway.com/cron-jobs)
- [Regions](https://docs.railway.com/deployments/regions)
- [Public networking specs and limits](https://docs.railway.com/networking/public-networking/specs-and-limits)
- [Variables and secrets](https://docs.railway.com/variables)
- [Health checks](https://docs.railway.com/deployments/healthchecks)

### Fly.io

- [Resource pricing](https://fly.io/docs/about/pricing/)
- [Regions](https://fly.io/docs/reference/regions/)
- [JavaScript/Node basics](https://fly.io/docs/js/the-basics/)
- [Fly Machines](https://fly.io/docs/machines/overview)
- [Public network services](https://fly.io/docs/networking/services)
- [Machine placement and regional capacity](https://fly.io/docs/machines/guides-examples/machine-placement/)
- [Managed metrics](https://fly.io/docs/monitoring/metrics)

### Crushify source reviewed

- [`package.json`](../package.json)
- [`api/[...path].ts`](../api/[...path].ts)
- [`api/v1.ts`](../api/v1.ts) (untracked at baseline)
- [`src/platform/vercel.ts`](../src/platform/vercel.ts)
- [`src/scheduler.ts`](../src/scheduler.ts)
- [`src/payments/policy.ts`](../src/payments/policy.ts)
- [`src/publications.ts`](../src/publications.ts)
- [`vercel.json`](../vercel.json) (modified at baseline)
- [`docs/HOSTING_MIGRATION.md`](./HOSTING_MIGRATION.md)

## Unverified items

- No provider account, billing screen, project, deployment, region allocation, or current account eligibility was accessed.
- No production/Preview environment variables or secret values were read.
- No live Turso or Cloudinary endpoint was contacted; region, latency, throughput, and backup/restore are unverified.
- No SePay dashboard or webhook was accessed; response timing and provider retry configuration are unverified.
- No load test, function/worker memory benchmark, traffic estimate, or cost calculator run was performed.
- Hosting prices and limits can change; confirm them directly before purchase/configuration.

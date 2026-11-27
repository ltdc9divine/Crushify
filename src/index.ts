import { handleSessionRoutes } from "./auth.ts";
import { handleAssetRoutes } from "./assets.ts";
import { handleDesignRoutes, handlePreviewRoutes } from "./designs.ts";
import { handleCustomDesignRoutes } from "./custom-design.ts";
import { handleAdminRoutes } from "./admin.ts";
import { handlePaymentRoutes } from "./payments.ts";
import { handlePublicationRoutes } from "./publications.ts";
import { runScheduledPublicationLifecycle } from "./scheduler.ts";
import { D1DatabaseAdapter } from "./database/d1.ts";
import {
  CloudinaryConfigurationError,
  createStorageFromEnvironment,
} from "./storage/provider.ts";
import { apiError, jsonResponse } from "./http.ts";
import { PUBLICATION_SHELL_CSP } from "./security-headers.ts";
import { logSafeError, logSafeInfo } from "./logging.ts";
import {
  isLoopbackOrigin,
  normalizeEnvironmentOrigin,
  workerRequestEnvironment,
  type DeploymentEnvironment,
} from "./platform/environment.ts";
import type { Env } from "./types.ts";

interface CloudflareEnv extends Omit<Env, "DB" | "ASSETS"> {
  ASSETS: Fetcher;
  DB: D1Database;
  DATABASE_PROVIDER: "d1";
  TURSO_STAGING_DATABASE_URL?: string;
  TURSO_STAGING_AUTH_TOKEN?: string;
  PREVIEW_CUSTOMER_FLOW_ENABLED?: string;
  PREVIEW_AUTH_ALLOWED_EMAILS?: string;
  PREVIEW_PAYMENT_MODE?: string;
  PREVIEW_SEPAY_WEBHOOK_SECRET?: string;
  PREVIEW_SEPAY_BANK_CODE?: string;
  PREVIEW_SEPAY_BANK_ACCOUNT?: string;
  PREVIEW_SEPAY_ACCOUNT_NAME?: string;
  PREVIEW_MANUAL_BANK_CODE?: string;
  PREVIEW_MANUAL_BANK_ACCOUNT?: string;
  PREVIEW_MANUAL_ACCOUNT_NAME?: string;
  PREVIEW_SEPAY_RECONCILIATION_ENABLED?: string;
  PREVIEW_SEPAY_API_TOKEN?: string;
  PREVIEW_SEPAY_API_BANK_ACCOUNT_ID?: string;
  PREVIEW_SEPAY_RECONCILIATION_SECRET?: string;
  PREVIEW_SEPAY_RECONCILIATION_START_AT?: string;
  STAGING_LIFECYCLE_SECRET?: string;
}

interface WorkerRequestScope {
  environment: DeploymentEnvironment;
  origin: string;
}

function hasLocalOnlyConfiguration(env: CloudflareEnv): boolean {
  return [
    env.LOCAL_TEST_MODE,
    env.LOCAL_TEST_CATALOG_OVERRIDE,
    env.LOCAL_TEST_PRICING_POLICY,
    env.LOCAL_TEST_MAIL_SINK_URL,
    env.LOCAL_TEST_EMAIL_SINK,
    env.PAYMENT_MODE,
    env.SEPAY_WEBHOOK_SECRET,
    env.SEPAY_BANK_CODE,
    env.SEPAY_BANK_ACCOUNT,
    env.SEPAY_ACCOUNT_NAME,
    env.MANUAL_BANK_CODE,
    env.MANUAL_BANK_ACCOUNT,
    env.MANUAL_ACCOUNT_NAME,
  ].some((value) => value !== undefined);
}

function hasStagingConfiguration(env: CloudflareEnv): boolean {
  return [
    env.TURSO_STAGING_DATABASE_URL,
    env.TURSO_STAGING_AUTH_TOKEN,
    env.CLOUDINARY_STAGING_CLOUD_NAME,
    env.CLOUDINARY_STAGING_API_KEY,
    env.CLOUDINARY_STAGING_API_SECRET,
    env.CLOUDINARY_PRODUCTION_CLOUD_NAME,
    env.PREVIEW_CUSTOMER_FLOW_ENABLED,
    env.PREVIEW_ASSET_UPLOADS_ENABLED,
    env.PREVIEW_AUTH_ALLOWED_EMAILS,
    env.PREVIEW_PAYMENT_MODE,
    env.PREVIEW_SEPAY_WEBHOOK_SECRET,
    env.PREVIEW_SEPAY_BANK_CODE,
    env.PREVIEW_SEPAY_BANK_ACCOUNT,
    env.PREVIEW_SEPAY_ACCOUNT_NAME,
    env.PREVIEW_MANUAL_BANK_CODE,
    env.PREVIEW_MANUAL_BANK_ACCOUNT,
    env.PREVIEW_MANUAL_ACCOUNT_NAME,
    env.PREVIEW_SEPAY_RECONCILIATION_ENABLED,
    env.PREVIEW_SEPAY_API_TOKEN,
    env.PREVIEW_SEPAY_API_BANK_ACCOUNT_ID,
    env.PREVIEW_SEPAY_RECONCILIATION_SECRET,
    env.PREVIEW_SEPAY_RECONCILIATION_START_AT,
    env.STAGING_LIFECYCLE_SECRET,
    env.PREVIEW_EMAIL_SINK,
    env.PREVIEW_MAIL_PROVIDER,
    env.PREVIEW_MAIL_API_KEY,
    env.PREVIEW_MAIL_FROM_EMAIL,
  ].some((value) => value !== undefined);
}

function validateWorkerRequestScope(
  request: Request,
  env: CloudflareEnv,
): WorkerRequestScope | Response {
  const runtime = workerRequestEnvironment(env.ENVIRONMENT, request.url);
  if (!runtime) {
    return apiError(crypto.randomUUID(), 500, "RUNTIME_CONFIGURATION_ERROR", "Worker environment is not explicitly configured");
  }
  if (runtime === "staging") {
    return apiError(crypto.randomUUID(), 503, "STAGING_RUNTIME_DISABLED", "Staging requests must use Vercel Preview");
  }
  if ((runtime === "production" && (hasLocalOnlyConfiguration(env) || hasStagingConfiguration(env))) ||
      (runtime === "local" &&
        (hasStagingConfiguration(env) ||
          env.MAIL_PROVIDER !== undefined ||
          env.MAIL_API_KEY !== undefined ||
          env.MAIL_FROM_EMAIL !== undefined ||
          env.MAILER !== undefined ||
          env.MAILER_AUTH_TOKEN !== undefined ||
          env.CLOUDINARY_CLOUD_NAME !== undefined ||
          env.CLOUDINARY_API_KEY !== undefined ||
          env.CLOUDINARY_API_SECRET !== undefined ||
          env.CLOUDINARY_PRODUCTION_CLOUD_NAME !== undefined ||
          env.STORAGE_PROVIDER === "cloudinary"))) {
    return apiError(crypto.randomUUID(), 500, "RUNTIME_CONFIGURATION_ERROR", "Worker credentials do not match the deployment environment");
  }

  let requestOrigin: string;
  try {
    requestOrigin = new URL(request.url).origin;
  } catch {
    return apiError(crypto.randomUUID(), 500, "RUNTIME_CONFIGURATION_ERROR", "Worker request origin is invalid");
  }
  const validatedRequestOrigin = normalizeEnvironmentOrigin(requestOrigin, runtime);
  const configuredOrigin = env.APP_ORIGIN === undefined
    ? validatedRequestOrigin
    : normalizeEnvironmentOrigin(env.APP_ORIGIN, runtime);
  if (!validatedRequestOrigin ||
      (runtime === "local" && !isLoopbackOrigin(validatedRequestOrigin)) ||
      !configuredOrigin ||
      configuredOrigin !== validatedRequestOrigin) {
    return apiError(crypto.randomUUID(), 500, "RUNTIME_CONFIGURATION_ERROR", "Worker origin is not valid for the deployment environment");
  }

  return { environment: runtime, origin: configuredOrigin };
}

export async function handleApiRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url);

  try {
    if (url.pathname === "/api/v1/health/live") {
      if (request.method !== "GET") {
        return apiError(requestId, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
      }

      return jsonResponse(
        { status: "ok", service: "crushify-api", request_id: requestId },
        200,
        requestId,
      );
    }

    if (url.pathname === "/api/v1/health/ready") {
      if (request.method !== "GET") {
        return apiError(requestId, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
      }
      if (!env.DB) {
        return apiError(requestId, 503, "DEPENDENCY_UNAVAILABLE", "Service unavailable");
      }
      try {
        await env.DB.prepare("SELECT 1").first();
      } catch (error) {
        logSafeError("database.readiness_check_failed", "database", error, { request_id: requestId });
        return apiError(requestId, 503, "DEPENDENCY_UNAVAILABLE", "Service unavailable");
      }
      return jsonResponse(
        { status: "ready", service: "crushify-api", request_id: requestId },
        200,
        requestId,
      );
    }

    const authResponse = await handleSessionRoutes(request, env, url.pathname, requestId);
    if (authResponse) return authResponse;
    const adminResponse = await handleAdminRoutes(request, env, url.pathname, requestId);
    if (adminResponse) return adminResponse;
    const customDesignResponse = await handleCustomDesignRoutes(request, env, url.pathname, requestId);
    if (customDesignResponse) return customDesignResponse;
    const designResponse = await handleDesignRoutes(request, env, url.pathname, requestId);
    if (designResponse) return designResponse;
    const assetResponse = await handleAssetRoutes(request, env, url.pathname, requestId);
    if (assetResponse) return assetResponse;
    const previewResponse = await handlePreviewRoutes(request, env, url.pathname, requestId);
    if (previewResponse) return previewResponse;
    const paymentResponse = await handlePaymentRoutes(request, env, url.pathname, requestId);
    if (paymentResponse) return paymentResponse;
    const publicationResponse = await handlePublicationRoutes(request, env, url.pathname, requestId);
    if (publicationResponse) return publicationResponse;
    return apiError(requestId, 404, "NOT_FOUND", "Route not found");
  } catch (error) {
    logSafeError("api.request_failed", "api", error, { request_id: requestId });
    return apiError(requestId, 500, "INTERNAL_ERROR", "Request could not be completed");
  }
}

export default {
  async scheduled(_controller: ScheduledController, env: CloudflareEnv, ctx: ExecutionContext): Promise<void> {
    if (env.ENVIRONMENT !== "production" ||
        hasLocalOnlyConfiguration(env) ||
        hasStagingConfiguration(env)) {
      throw new Error("Scheduled maintenance requires an explicitly scoped Production Worker");
    }
    if (env.DATABASE_PROVIDER !== "d1") {
      throw new Error("Scheduled maintenance requires the D1 database provider");
    }
    let storage;
    try {
      storage = createStorageFromEnvironment(env, env.MEDIA);
    } catch (error) {
      logSafeError("scheduler.storage_configuration_failed", "storage", error, {
        environment: env.ENVIRONMENT,
      });
      throw error;
    }
    const runtimeEnv = {
      ...env,
      DB: new D1DatabaseAdapter(env.DB),
      STORAGE: storage,
    };
    ctx.waitUntil((async () => {
      const maintenance = await runScheduledPublicationLifecycle(runtimeEnv, { limit: 50 });
      const fulfillment = maintenance.operations?.fulfillmentRecovery;
      const lifecycle = maintenance.operations?.publicationLifecycle;
      const derivativeCleanup = maintenance.operations?.publicationDerivativeCleanup;
      const uploadCleanup = maintenance.operations?.uploadCleanup;
      const fulfillmentResult = fulfillment?.status === "completed" ? fulfillment.result : undefined;
      const lifecycleResult = lifecycle?.status === "completed" ? lifecycle.result : undefined;
      const derivativeResult = derivativeCleanup?.status === "completed"
        ? derivativeCleanup.result
        : undefined;
      const uploadResult = uploadCleanup?.status === "completed" ? uploadCleanup.result : undefined;
      const maintenanceOutcome = maintenance.failed
        ? "failed"
        : maintenance.pending || !maintenance.acquired
          ? "pending"
          : "completed";
      logSafeInfo(`scheduler.publication_maintenance_${maintenanceOutcome}`, "lifecycle", {
        environment: runtimeEnv.ENVIRONMENT,
        counts: {
          completed: fulfillmentResult?.completed ?? 0,
          manual_review: fulfillmentResult?.manualReview ?? 0,
          expired: lifecycleResult?.expired ?? 0,
          erased: lifecycleResult?.erased ?? 0,
          retryable: lifecycleResult?.retryable ?? 0,
          derivative_cleanup_processed: derivativeResult?.processed ?? 0,
          derivative_cleanup_cleaned: derivativeResult?.cleaned ?? 0,
          derivative_cleanup_pending: derivativeResult?.pending ?? 0,
          derivative_cleanup_deferred: derivativeResult?.deferred ?? 0,
          derivative_cleanup_failed: derivativeResult?.status === "failed"
            ? derivativeResult.retryable
            : 0,
          derivative_cleanup_retryable: derivativeResult?.retryable ?? 0,
          derivative_cleanup_manual_review: derivativeResult?.manualReview ?? 0,
          derivative_cleanup_has_more: derivativeResult?.hasMore ? 1 : 0,
          upload_cleanup_processed: uploadResult?.processed ?? 0,
          upload_cleanup_cleaned: uploadResult?.cleaned ?? 0,
          upload_cleanup_retryable: uploadResult?.retryable ?? 0,
          upload_cleanup_manual_review: uploadResult?.manualReview ?? 0,
        },
      });
    })().catch((error) => {
      logSafeError("scheduler.publication_maintenance_failed", "lifecycle", error, {
        environment: runtimeEnv.ENVIRONMENT,
      });
      throw error;
    }));
  },
  async fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    const scope = validateWorkerRequestScope(request, env);
    if (scope instanceof Response) return scope;

    const runtimeEnv: Env = {
      ...env,
      ENVIRONMENT: scope.environment,
      APP_ORIGIN: scope.origin,
    };
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (env.DATABASE_PROVIDER !== "d1") {
        return apiError(crypto.randomUUID(), 500, "DATABASE_CONFIGURATION_ERROR", "Database provider is not configured for this runtime");
      }
      let storage;
      try {
        storage = createStorageFromEnvironment(env, env.MEDIA);
      } catch (error) {
        logSafeError("storage.provider_configuration_failed", "storage", error, {
          environment: env.ENVIRONMENT,
        });
        const code = error instanceof CloudinaryConfigurationError
          ? error.code
          : "STORAGE_CONFIGURATION_ERROR";
        const message = error instanceof CloudinaryConfigurationError
          ? error.message
          : "Storage provider is not configured for this runtime";
        return apiError(crypto.randomUUID(), 500, code, message);
      }
      return handleApiRequest(request, {
        ...runtimeEnv,
        DB: new D1DatabaseAdapter(env.DB),
        STORAGE: storage,
      });
    }
    if (url.pathname === "/p" || /^\/p\/[^/.]+\/?$/.test(url.pathname)) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return apiError(crypto.randomUUID(), 405, "METHOD_NOT_ALLOWED", "Method not allowed");
      }
      const pageUrl = new URL("/p/index.html", request.url);
      const page = await env.ASSETS.fetch(new Request(pageUrl, { method: request.method }));
      const headers = new Headers(page.headers);
      headers.set("Cache-Control", "no-store");
      headers.set("Content-Security-Policy", PUBLICATION_SHELL_CSP);
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Referrer-Policy", "no-referrer");
      headers.set("X-Frame-Options", "DENY");
      headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
      return new Response(page.body, { status: page.status, headers });
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<CloudflareEnv>;

import { handleSessionRoutes } from "./auth.ts";
import { handleAssetRoutes } from "./assets.ts";
import { handleDesignRoutes, handlePreviewRoutes } from "./designs.ts";
import { handlePaymentRoutes } from "./payments.ts";
import { handlePublicationRoutes } from "./publications.ts";
import { recoverPendingFulfillments, runPublicationLifecycle } from "./publications.ts";
import { D1DatabaseAdapter } from "./database/d1.ts";
import {
  CloudinaryConfigurationError,
  createStorageFromEnvironment,
} from "./storage/provider.ts";
import { apiError, jsonResponse } from "./http.ts";
import { PUBLICATION_SHELL_CSP } from "./security-headers.ts";
import { logSafeError, logSafeInfo } from "./logging.ts";
import type { Env } from "./types.ts";

interface CloudflareEnv extends Omit<Env, "DB" | "ASSETS"> {
  ASSETS: Fetcher;
  DB: D1Database;
  DATABASE_PROVIDER: "d1";
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
      const fulfillment = await recoverPendingFulfillments(runtimeEnv, 50);
      const lifecycle = await runPublicationLifecycle(runtimeEnv, { limit: 50 });
      logSafeInfo("scheduler.publication_maintenance_completed", "lifecycle", {
        environment: runtimeEnv.ENVIRONMENT,
        counts: {
          completed: fulfillment.completed,
          expired: lifecycle.expired,
          erased: lifecycle.erased,
          retryable: lifecycle.retryable,
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
        ...env,
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

import { handleSessionRoutes } from "./auth.ts";
import { handleAssetRoutes } from "./assets.ts";
import { handleDesignRoutes, handlePreviewRoutes } from "./designs.ts";
import { apiError, jsonResponse } from "./http.ts";
import type { Env } from "./types.ts";

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
        console.error("D1 readiness check failed", { request_id: requestId, error });
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
    return apiError(requestId, 404, "NOT_FOUND", "Route not found");
  } catch (error) {
    console.error("API request failed", { request_id: requestId, path: url.pathname, error });
    return apiError(requestId, 500, "INTERNAL_ERROR", "Request could not be completed");
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApiRequest(request, env);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

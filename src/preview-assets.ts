import type { Env } from "./types.ts";

export function previewAssetUploadsEnabled(env: Pick<
  Env,
  "ENVIRONMENT" | "PREVIEW_CUSTOMER_FLOW_ENABLED" | "PREVIEW_ASSET_UPLOADS_ENABLED"
>): boolean {
  return env.ENVIRONMENT !== "staging" ||
    (env.PREVIEW_CUSTOMER_FLOW_ENABLED === "true" &&
      env.PREVIEW_ASSET_UPLOADS_ENABLED === "true");
}

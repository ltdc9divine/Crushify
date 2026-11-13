import type { CloudinaryConfig } from "./cloudinary.ts";

export interface CloudinaryEnvironment {
  ENVIRONMENT?: string;
  CLOUDINARY_CLOUD_NAME?: string;
  CLOUDINARY_API_KEY?: string;
  CLOUDINARY_API_SECRET?: string;
  CLOUDINARY_STAGING_CLOUD_NAME?: string;
  CLOUDINARY_STAGING_API_KEY?: string;
  CLOUDINARY_STAGING_API_SECRET?: string;
  CLOUDINARY_PRODUCTION_CLOUD_NAME?: string;
}

export class CloudinaryConfigurationError extends TypeError {
  readonly code: "STORAGE_CONFIGURATION_ERROR" | "STORAGE_ISOLATION_ERROR";

  constructor(code: "STORAGE_CONFIGURATION_ERROR" | "STORAGE_ISOLATION_ERROR", message: string) {
    super(message);
    this.name = "CloudinaryConfigurationError";
    this.code = code;
  }
}

export function resolveCloudinaryConfiguration(
  environment: CloudinaryEnvironment,
): CloudinaryConfig {
  if (environment.ENVIRONMENT === "staging") {
    throw new CloudinaryConfigurationError(
      "STORAGE_ISOLATION_ERROR",
      "Cloudinary storage is disabled in staging until account isolation is independently verified",
    );
  }
  if (environment.ENVIRONMENT === "local") {
    throw new CloudinaryConfigurationError(
      "STORAGE_ISOLATION_ERROR",
      "Cloudinary storage is disabled in local development; use local mock storage",
    );
  }
  if (environment.ENVIRONMENT !== "production") {
    throw new CloudinaryConfigurationError(
      "STORAGE_CONFIGURATION_ERROR",
      "Cloudinary storage requires an explicitly identified Production environment",
    );
  }
  if (environment.CLOUDINARY_STAGING_CLOUD_NAME !== undefined ||
      environment.CLOUDINARY_STAGING_API_KEY !== undefined ||
      environment.CLOUDINARY_STAGING_API_SECRET !== undefined) {
    throw new CloudinaryConfigurationError(
      "STORAGE_CONFIGURATION_ERROR",
      "Staging-specific Cloudinary configuration is not valid for this runtime",
    );
  }

  const { CLOUDINARY_CLOUD_NAME: cloudName, CLOUDINARY_API_KEY: apiKey, CLOUDINARY_API_SECRET: apiSecret } =
    environment;
  if (!cloudName || !/^[A-Za-z0-9_-]+$/.test(cloudName) ||
      !apiKey || !/^[A-Za-z0-9_-]+$/.test(apiKey) ||
      !apiSecret?.trim()) {
    throw new CloudinaryConfigurationError(
      "STORAGE_CONFIGURATION_ERROR",
      "Cloudinary configuration is incomplete or invalid",
    );
  }

  return { cloudName, apiKey, apiSecret };
}

import type { Storage } from "../storage.ts";
import { CloudinaryStorageAdapter } from "./cloudinary.ts";
import type { CloudinaryEnvironment } from "./cloudinary-policy.ts";
import {
  CloudinaryConfigurationError,
  resolveCloudinaryConfiguration,
} from "./cloudinary-policy.ts";
import { R2StorageAdapter } from "./r2.ts";

export interface StorageEnvironment extends CloudinaryEnvironment {
  STORAGE_PROVIDER?: string;
}

export function createStorageFromEnvironment(
  environment: StorageEnvironment,
  r2Binding?: R2Bucket,
): Storage {
  if (environment.STORAGE_PROVIDER === "r2") {
    if (!r2Binding) throw new Error("STORAGE_PROVIDER=r2 requires an R2 binding");
    return new R2StorageAdapter(r2Binding);
  }
  if (environment.STORAGE_PROVIDER === "cloudinary") {
    const config = resolveCloudinaryConfiguration(environment);
    return new CloudinaryStorageAdapter(config);
  }
  throw new Error("STORAGE_PROVIDER must be explicitly set to r2 or cloudinary");
}

export { CloudinaryConfigurationError };

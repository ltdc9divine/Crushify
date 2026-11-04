import type { Storage } from "../storage.ts";
import { CloudinaryStorageAdapter } from "./cloudinary.ts";
import { R2StorageAdapter } from "./r2.ts";

export interface StorageEnvironment {
  STORAGE_PROVIDER?: string;
  CLOUDINARY_CLOUD_NAME?: string;
  CLOUDINARY_API_KEY?: string;
  CLOUDINARY_API_SECRET?: string;
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
    const { CLOUDINARY_CLOUD_NAME: cloudName, CLOUDINARY_API_KEY: apiKey, CLOUDINARY_API_SECRET: apiSecret } =
      environment;
    if (!cloudName || !apiKey || !apiSecret) {
      throw new Error("Cloudinary credentials are required for STORAGE_PROVIDER=cloudinary");
    }
    return new CloudinaryStorageAdapter({ cloudName, apiKey, apiSecret });
  }
  throw new Error("STORAGE_PROVIDER must be explicitly set to r2 or cloudinary");
}

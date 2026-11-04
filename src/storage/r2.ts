import { MAX_IMAGE_BYTES } from "../http.ts";
import type { Storage, StorageObject, StorageUploadOptions } from "../storage.ts";

export class R2StorageAdapter implements Storage {
  private readonly bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.bucket = bucket;
  }

  async upload(
    objectKey: string,
    bytes: Uint8Array,
    options: StorageUploadOptions,
  ): Promise<void> {
    validateUpload(objectKey, bytes, options);
    await this.bucket.put(objectKey, bytes, {
      httpMetadata: { contentType: options.contentType, cacheControl: "private, no-store" },
      customMetadata: {
        sha256: options.sha256,
        width: String(options.width),
        height: String(options.height),
      },
    });
  }

  async get(objectKey: string): Promise<StorageObject | null> {
    const object = await this.bucket.get(objectKey);
    if (!object) return null;
    return {
      size: object.size,
      contentType: object.httpMetadata?.contentType ?? "",
      body: object.body,
      arrayBuffer: () => object.arrayBuffer(),
    };
  }

  async delete(objectKey: string): Promise<void> {
    await this.bucket.delete(objectKey);
  }

  async privateAssetUrl(): Promise<null> {
    return null;
  }
}

export function validateStorageKey(objectKey: string): void {
  if (!/^private\/[A-Za-z0-9_-]{32,64}(?:-(?:png|jpg)|\.(?:png|jpg))$/.test(objectKey)) {
    throw new TypeError("Storage object key is not a server-generated private key");
  }
}

export function validateUpload(
  objectKey: string,
  bytes: Uint8Array,
  options: StorageUploadOptions,
): void {
  validateStorageKey(objectKey);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new TypeError("Image size is outside the permitted range");
  }
  if (options.contentType !== "image/png" && options.contentType !== "image/jpeg") {
    throw new TypeError("Image type is not permitted");
  }
  if (!/^[a-f0-9]{64}$/i.test(options.sha256) ||
      !Number.isSafeInteger(options.width) || options.width < 1 ||
      !Number.isSafeInteger(options.height) || options.height < 1 ||
      options.width > 8192 || options.height > 8192 ||
      options.width * options.height > 40_000_000) {
    throw new TypeError("Image metadata is invalid");
  }
}

import { MAX_IMAGE_BYTES } from "../http.ts";
import { StorageError, type Storage, type StorageObject, type StorageUploadOptions } from "../storage.ts";
import { validateStorageKey, validateUpload } from "./r2.ts";

const PRIVATE_URL_TTL_SECONDS = 60;

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  fetcher?: typeof fetch;
  now?: () => number;
}

interface CloudinaryUploadResponse {
  public_id?: unknown;
  bytes?: unknown;
  format?: unknown;
  resource_type?: unknown;
  type?: unknown;
}

export class CloudinaryStorageAdapter implements Storage {
  private readonly cloudName: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(config: CloudinaryConfig) {
    if (!/^[A-Za-z0-9_-]+$/.test(config.cloudName) ||
        !/^[A-Za-z0-9_-]+$/.test(config.apiKey) ||
        config.apiSecret.length < 1) {
      throw new TypeError("Cloudinary configuration is invalid");
    }
    this.cloudName = config.cloudName;
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.fetcher = config.fetcher ?? fetch;
    this.now = config.now ?? Date.now;
  }

  async upload(
    objectKey: string,
    bytes: Uint8Array,
    options: StorageUploadOptions,
  ): Promise<void> {
    validateUpload(objectKey, bytes, options);
    const timestamp = Math.floor(this.now() / 1000);
    const parameters = {
      overwrite: "false",
      public_id: objectKey,
      timestamp: String(timestamp),
      type: "authenticated",
      unique_filename: "false",
    };
    const form = new FormData();
    const uploadBytes = new Uint8Array(bytes.byteLength);
    uploadBytes.set(bytes);
    form.set("file", new Blob([uploadBytes.buffer], { type: options.contentType }), "upload");
    for (const [key, value] of Object.entries(parameters)) form.set(key, value);
    form.set("api_key", this.apiKey);
    form.set("signature", await cloudinarySignature(parameters, this.apiSecret));

    let response: Response;
    try {
      response = await this.fetcher(
        `https://api.cloudinary.com/v1_1/${this.cloudName}/image/upload`,
        { method: "POST", body: form },
      );
    } catch {
      throw new StorageError("Cloudinary upload request failed");
    }
    if (!response.ok) {
      throw new StorageError(`Cloudinary upload failed with status ${response.status}`);
    }
    const result = await readCloudinaryJson<CloudinaryUploadResponse>(response);
    const expectedFormat = options.contentType === "image/png" ? "png" : "jpg";
    if (result.public_id !== objectKey || result.bytes !== bytes.byteLength ||
        result.resource_type !== "image" || result.type !== "authenticated" ||
        result.format !== expectedFormat) {
      try {
        await this.delete(objectKey);
      } catch {
        throw new StorageError("Cloudinary returned inconsistent upload metadata and cleanup failed");
      }
      throw new StorageError("Cloudinary returned inconsistent upload metadata");
    }
  }

  async get(objectKey: string): Promise<StorageObject | null> {
    const url = await this.privateAssetUrl(objectKey, Math.floor(this.now() / 1000) + PRIVATE_URL_TTL_SECONDS);
    if (!url) return null;
    let response: Response;
    try {
      response = await this.fetcher(url, { method: "GET", redirect: "error" });
    } catch {
      throw new StorageError("Cloudinary download request failed");
    }
    if (response.status === 404) return null;
    if (!response.ok || !response.body) {
      throw new StorageError(`Cloudinary download failed with status ${response.status}`);
    }
    const declaredSize = Number(response.headers.get("content-length"));
    const contentType = response.headers.get("content-type")?.split(";")[0].trim() ?? "";
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 1 || declaredSize > MAX_IMAGE_BYTES ||
        (contentType !== "image/png" && contentType !== "image/jpeg")) {
      await response.body.cancel();
      throw new StorageError("Cloudinary returned invalid asset metadata");
    }
    return {
      size: declaredSize,
      contentType,
      body: response.body,
      arrayBuffer: () => response.arrayBuffer(),
    };
  }

  async delete(objectKey: string): Promise<void> {
    validateStorageKey(objectKey);
    const parameters = {
      public_id: objectKey,
      timestamp: String(Math.floor(this.now() / 1000)),
      type: "authenticated",
    };
    const form = new FormData();
    for (const [key, value] of Object.entries(parameters)) form.set(key, value);
    form.set("api_key", this.apiKey);
    form.set("signature", await cloudinarySignature(parameters, this.apiSecret));
    let response: Response;
    try {
      response = await this.fetcher(
        `https://api.cloudinary.com/v1_1/${this.cloudName}/image/destroy`,
        { method: "POST", body: form },
      );
    } catch {
      throw new StorageError("Cloudinary delete request failed");
    }
    if (!response.ok) {
      throw new StorageError(`Cloudinary delete failed with status ${response.status}`);
    }
    const result = await readCloudinaryJson<{ result?: unknown }>(response);
    if (result.result !== "ok" && result.result !== "not found") {
      throw new StorageError("Cloudinary did not confirm asset deletion");
    }
  }

  async privateAssetUrl(objectKey: string, expiresAt: number): Promise<string> {
    validateStorageKey(objectKey);
    const now = Math.floor(this.now() / 1000);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 5 * 60) {
      throw new TypeError("Private asset URL expiry must be within five minutes");
    }
    const extension = objectKey.endsWith("-png") || objectKey.endsWith(".png") ? "png" : "jpg";
    const parameters = {
      expires_at: String(expiresAt),
      format: extension,
      public_id: objectKey,
      type: "authenticated",
    };
    const signature = await cloudinarySignature(parameters, this.apiSecret);
    const url = new URL(`https://api.cloudinary.com/v1_1/${this.cloudName}/image/private_download`);
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    url.searchParams.set("api_key", this.apiKey);
    url.searchParams.set("signature", signature);
    return url.toString();
  }
}

async function cloudinarySignature(
  parameters: Record<string, string>,
  apiSecret: string,
): Promise<string> {
  const canonical = Object.entries(parameters)
    .filter(([, value]) => value !== "")
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(`${canonical}${apiSecret}`),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readCloudinaryJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    throw new StorageError("Cloudinary returned an invalid response");
  }
}

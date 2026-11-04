import { validateUpload } from "./r2.ts";
import type { Storage, StorageObject, StorageUploadOptions } from "../storage.ts";

export class MemoryStorageAdapter implements Storage {
  private readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async upload(
    objectKey: string,
    bytes: Uint8Array,
    options: StorageUploadOptions,
  ): Promise<void> {
    validateUpload(objectKey, bytes, options);
    this.objects.set(objectKey, {
      bytes: new Uint8Array(bytes),
      contentType: options.contentType,
    });
  }

  async get(objectKey: string): Promise<StorageObject | null> {
    const stored = this.objects.get(objectKey);
    if (!stored) return null;
    const bytes = new Uint8Array(stored.bytes);
    return {
      size: bytes.byteLength,
      contentType: stored.contentType,
      body: new Response(bytes).body,
      arrayBuffer: async () => bytes.slice().buffer,
    };
  }

  async delete(objectKey: string): Promise<void> {
    this.objects.delete(objectKey);
  }

  async privateAssetUrl(): Promise<null> {
    return null;
  }
}

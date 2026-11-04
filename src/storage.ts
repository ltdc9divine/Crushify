export interface StorageObject {
  size: number;
  contentType: string;
  body: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface StorageUploadOptions {
  contentType: "image/png" | "image/jpeg";
  sha256: string;
  width: number;
  height: number;
}

export interface Storage {
  upload(objectKey: string, bytes: Uint8Array, options: StorageUploadOptions): Promise<void>;
  get(objectKey: string): Promise<StorageObject | null>;
  delete(objectKey: string): Promise<void>;
  privateAssetUrl(objectKey: string, expiresAt: number): Promise<string | null>;
}

export class StorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageError";
  }
}

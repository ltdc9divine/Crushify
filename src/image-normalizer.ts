export type ImageContentType = "image/png" | "image/jpeg";

export interface NormalizedImage {
  bytes: Uint8Array;
  contentType: ImageContentType;
  width: number;
  height: number;
}

export type ImageNormalizer = (
  bytes: Uint8Array,
  contentType: ImageContentType,
) => Promise<NormalizedImage>;

export class ImageNormalizationError extends Error {
  readonly code: "INVALID_IMAGE" | "IMAGE_TOO_LARGE";

  constructor(code: "INVALID_IMAGE" | "IMAGE_TOO_LARGE", options?: ErrorOptions) {
    super(code === "IMAGE_TOO_LARGE" ? "Normalized image is too large" : "Image could not be normalized", options);
    this.name = "ImageNormalizationError";
    this.code = code;
  }
}

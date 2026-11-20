import sharp from "sharp";
import { detectImage } from "../assets.ts";
import { stripImageMetadata } from "../image-sanitizer.ts";
import {
  ImageNormalizationError,
  type ImageContentType,
  type NormalizedImage,
} from "../image-normalizer.ts";
import { MAX_IMAGE_BYTES } from "../http.ts";

const MAX_IMAGE_PIXELS = 40_000_000;

function isValidDimensions(width: number, height: number): boolean {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) &&
    width > 0 && height > 0 && width <= 8192 && height <= 8192 &&
    width * height <= MAX_IMAGE_PIXELS;
}

export async function normalizeNodeImage(
  bytes: Uint8Array,
  contentType: ImageContentType,
): Promise<NormalizedImage> {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new ImageNormalizationError("IMAGE_TOO_LARGE");
  }
  const detected = detectImage(bytes);
  if (!detected || detected.contentType !== contentType) {
    throw new ImageNormalizationError("INVALID_IMAGE");
  }

  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const options = {
    failOn: "error" as const,
    limitInputPixels: MAX_IMAGE_PIXELS,
    sequentialRead: true,
  };
  try {
    const metadata = await sharp(input, options).metadata();
    const expectedFormat = contentType === "image/jpeg" ? "jpeg" : "png";
    if (metadata.format !== expectedFormat ||
        !metadata.width || !metadata.height ||
        !isValidDimensions(metadata.width, metadata.height) ||
        (metadata.pages ?? 1) !== 1) {
      throw new ImageNormalizationError("INVALID_IMAGE");
    }

    const pipeline = sharp(input, options).rotate().keepIccProfile();
    const { data, info } = contentType === "image/jpeg"
      ? await pipeline.jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
        .toBuffer({ resolveWithObject: true })
      : await pipeline.png({ compressionLevel: 9 })
        .toBuffer({ resolveWithObject: true });

    if (data.byteLength < 1 || data.byteLength > MAX_IMAGE_BYTES ||
        info.format !== expectedFormat || !isValidDimensions(info.width, info.height)) {
      throw new ImageNormalizationError(
        data.byteLength > MAX_IMAGE_BYTES ? "IMAGE_TOO_LARGE" : "INVALID_IMAGE",
      );
    }

    const sanitizedBytes = stripImageMetadata(new Uint8Array(data), contentType);
    const sanitizedInfo = detectImage(sanitizedBytes);
    if (!sanitizedInfo || sanitizedInfo.contentType !== contentType ||
        sanitizedInfo.width !== info.width || sanitizedInfo.height !== info.height) {
      throw new ImageNormalizationError("INVALID_IMAGE");
    }

    const sanitizedMetadata = await sharp(Buffer.from(
      sanitizedBytes.buffer,
      sanitizedBytes.byteOffset,
      sanitizedBytes.byteLength,
    ), options).metadata();
    if (sanitizedMetadata.orientation !== undefined ||
        sanitizedMetadata.exif !== undefined ||
        sanitizedMetadata.iptc !== undefined ||
        sanitizedMetadata.xmp !== undefined ||
        (metadata.icc !== undefined && sanitizedMetadata.icc === undefined)) {
      throw new ImageNormalizationError("INVALID_IMAGE");
    }

    return {
      bytes: sanitizedBytes,
      contentType,
      width: info.width,
      height: info.height,
    };
  } catch (error) {
    if (error instanceof ImageNormalizationError) throw error;
    throw new ImageNormalizationError("INVALID_IMAGE", { cause: error });
  }
}

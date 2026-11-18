import { MAX_IMAGE_BYTES } from "./http.ts";

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_RETAINED_CHUNKS = new Set([
  "IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP",
  "sBIT", "bKGD", "hIST", "pHYs", "acTL", "fcTL", "fdAT",
]);
const JPEG_ICC_PROFILE_SIGNATURE = new Uint8Array([
  73, 67, 67, 95, 80, 82, 79, 70, 73, 76, 69, 0,
]);
const JPEG_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function stripPngMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < 45 ||
      !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    throw new TypeError("Image metadata could not be sanitized");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const output = new Uint8Array(bytes.byteLength);
  output.set(bytes.subarray(0, PNG_SIGNATURE.length));
  let outputLength = PNG_SIGNATURE.length;
  let offset = PNG_SIGNATURE.length;
  let hasHeader = false;
  let hasPalette = false;
  let hasTransparency = false;
  let hasData = false;
  let hasEnd = false;

  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) {
      throw new TypeError("Image metadata could not be sanitized");
    }
    const dataLength = view.getUint32(offset);
    if (dataLength > bytes.byteLength - offset - 12) {
      throw new TypeError("Image metadata could not be sanitized");
    }
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/.test(type)) {
      throw new TypeError("Image metadata could not be sanitized");
    }
    const end = offset + 12 + dataLength;

    if (!hasHeader) {
      if (type !== "IHDR" || dataLength !== 13) {
        throw new TypeError("Image metadata could not be sanitized");
      }
      hasHeader = true;
    } else if (type === "IHDR") {
      throw new TypeError("Image metadata could not be sanitized");
    }

    if (type === "PLTE") {
      if (hasData || hasPalette) throw new TypeError("Image metadata could not be sanitized");
      hasPalette = true;
    } else if (type === "tRNS") {
      if (hasData || hasTransparency) throw new TypeError("Image metadata could not be sanitized");
      hasTransparency = true;
    } else if (type === "IDAT") {
      hasData = true;
    } else if (type === "IEND") {
      if (dataLength !== 0 || !hasData || end !== bytes.byteLength) {
        throw new TypeError("Image metadata could not be sanitized");
      }
      hasEnd = true;
    } else if (type[0] >= "A" && type[0] <= "Z" && !PNG_RETAINED_CHUNKS.has(type)) {
      throw new TypeError("Image metadata could not be sanitized");
    }

    if (PNG_RETAINED_CHUNKS.has(type)) {
      output.set(bytes.subarray(offset, end), outputLength);
      outputLength += end - offset;
    }
    offset = end;
    if (hasEnd) break;
  }

  if (!hasHeader || !hasData || !hasEnd) {
    throw new TypeError("Image metadata could not be sanitized");
  }
  return output.subarray(0, outputLength);
}

function isJpegMetadataMarker(marker: number): boolean {
  return (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
}

function preservesJpegColorMetadata(
  marker: number,
  bytes: Uint8Array,
  payloadOffset: number,
  payloadLength: number,
): boolean {
  if (marker === 0xe0 || marker === 0xee) return true;
  return marker === 0xe2 && payloadLength >= JPEG_ICC_PROFILE_SIGNATURE.length &&
    JPEG_ICC_PROFILE_SIGNATURE.every((byte, index) => bytes[payloadOffset + index] === byte);
}

function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < 16 || bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
      bytes[bytes.byteLength - 2] !== 0xff || bytes[bytes.byteLength - 1] !== 0xd9) {
    throw new TypeError("Image metadata could not be sanitized");
  }

  const output = new Uint8Array(bytes.byteLength);
  output.set(bytes.subarray(0, 2));
  let outputLength = 2;
  let offset = 2;
  let entropyStart = -1;
  let hasFrame = false;
  let hasScan = false;
  let hasEnd = false;
  const append = (part: Uint8Array) => {
    if (part.byteLength) {
      output.set(part, outputLength);
      outputLength += part.byteLength;
    }
  };

  while (offset < bytes.byteLength) {
    if (entropyStart >= 0) {
      let markerStart = -1;
      while (offset < bytes.byteLength) {
        if (bytes[offset] !== 0xff) {
          offset++;
          continue;
        }
        markerStart = offset;
        offset++;
        while (offset < bytes.byteLength && bytes[offset] === 0xff) offset++;
        if (offset >= bytes.byteLength) {
          throw new TypeError("Image metadata could not be sanitized");
        }
        const marker = bytes[offset];
        if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset++;
          continue;
        }
        append(bytes.subarray(entropyStart, markerStart));
        offset = markerStart;
        entropyStart = -1;
        break;
      }
      if (entropyStart >= 0) {
        throw new TypeError("Image metadata could not be sanitized");
      }
      continue;
    }

    const markerStart = offset;
    if (bytes[offset] !== 0xff) {
      throw new TypeError("Image metadata could not be sanitized");
    }
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.byteLength) {
      throw new TypeError("Image metadata could not be sanitized");
    }
    const marker = bytes[offset++];

    if (marker === 0xd9) {
      append(bytes.subarray(markerStart, offset));
      hasEnd = true;
      if (offset !== bytes.byteLength) {
        throw new TypeError("Image metadata could not be sanitized");
      }
      break;
    }
    if (marker === 0xd8 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      throw new TypeError("Image metadata could not be sanitized");
    }
    if (marker === 0x01) {
      append(bytes.subarray(markerStart, offset));
      continue;
    }
    if (offset + 2 > bytes.byteLength) {
      throw new TypeError("Image metadata could not be sanitized");
    }

    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || segmentLength > bytes.byteLength - offset) {
      throw new TypeError("Image metadata could not be sanitized");
    }
    const segmentEnd = offset + segmentLength;
    if (JPEG_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 7) throw new TypeError("Image metadata could not be sanitized");
      hasFrame = true;
    }

    if (!isJpegMetadataMarker(marker) ||
        preservesJpegColorMetadata(marker, bytes, offset + 2, segmentLength - 2)) {
      append(bytes.subarray(markerStart, segmentEnd));
    }
    offset = segmentEnd;
    if (marker === 0xda) {
      hasScan = true;
      entropyStart = segmentEnd;
    }
  }

  if (!hasFrame || !hasScan || !hasEnd) {
    throw new TypeError("Image metadata could not be sanitized");
  }
  return output.subarray(0, outputLength);
}

export function stripImageMetadata(
  bytes: Uint8Array,
  contentType: "image/png" | "image/jpeg",
): Uint8Array {
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new TypeError("Image metadata could not be sanitized");
  }
  if (contentType === "image/png") return stripPngMetadata(bytes);
  if (contentType === "image/jpeg") return stripJpegMetadata(bytes);
  throw new TypeError("Image metadata could not be sanitized");
}

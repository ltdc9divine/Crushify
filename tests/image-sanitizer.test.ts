import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { describe, it } from "node:test";
import { stripImageMetadata } from "../src/image-sanitizer.ts";
import { MAX_IMAGE_BYTES } from "../src/http.ts";

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function concatenate(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function pngCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.byteLength);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.byteLength);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.byteLength, pngCrc32(chunk.subarray(4, 8 + data.byteLength)));
  return chunk;
}

function makePng(): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, 1);
  header.set([8, 0, 0, 0, 0], 8);
  const profile = new TextEncoder().encode("embedded color profile");
  const iccProfile = concatenate([
    new TextEncoder().encode("Crushify"),
    new Uint8Array([0, 0]),
    new Uint8Array(deflateSync(profile)),
  ]);
  return concatenate([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("tEXt", new TextEncoder().encode("Comment\0GPS coordinates")),
    pngChunk("iCCP", iccProfile),
    pngChunk("tRNS", new Uint8Array([0, 0])),
    pngChunk("IDAT", new Uint8Array(deflateSync(new Uint8Array([0, 0])))),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

function jpegSegment(marker: number, payload: number[]): Uint8Array {
  const segment = new Uint8Array(payload.length + 4);
  segment.set([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]);
  segment.set(payload, 4);
  return segment;
}

describe("image metadata stripping", () => {
  it("removes PNG text metadata while preserving transparency and image data", () => {
    const source = makePng();
    const sanitized = stripImageMetadata(source, "image/png");
    const text = new TextDecoder().decode(sanitized);

    assert.ok(!text.includes("tEXt"));
    assert.ok(!text.includes("GPS coordinates"));
    assert.ok(text.includes("iCCP"));
    assert.ok(text.includes("tRNS"));
    assert.ok(text.includes("IDAT"));
    assert.ok(text.includes("IEND"));
  });

  it("removes JPEG EXIF while preserving stuffed bytes, restart markers and image data", () => {
    const start = new Uint8Array([0xff, 0xd8]);
    const exif = jpegSegment(0xe1, [...new TextEncoder().encode("Exif\0\0GPS location")]);
    const jfif = jpegSegment(0xe0, [...new TextEncoder().encode("JFIF\0")]);
    const icc = jpegSegment(0xe2, [
      ...new TextEncoder().encode("ICC_PROFILE\0"),
      1, 1, 0x49, 0x43, 0x43,
    ]);
    const adobe = jpegSegment(0xee, [...new TextEncoder().encode("Adobe\0")]);
    const frame = jpegSegment(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]);
    const scan = jpegSegment(0xda, [1, 1, 0, 0, 63, 0]);
    const entropy = new Uint8Array([0x12, 0xff, 0x00, 0x20, 0xff, 0xd0, 0x30]);
    const end = new Uint8Array([0xff, 0xd9]);
    const source = concatenate([start, exif, jfif, icc, adobe, frame, scan, entropy, end]);
    const sanitized = stripImageMetadata(source, "image/jpeg");

    assert.deepEqual(sanitized, concatenate([start, jfif, icc, adobe, frame, scan, entropy, end]));
    assert.equal(new TextDecoder().decode(sanitized).includes("GPS location"), false);
  });

  it("rejects malformed image chunks instead of returning partially sanitized data", () => {
    assert.throws(
      () => stripImageMetadata(new Uint8Array(MAX_IMAGE_BYTES + 1), "image/png"),
      TypeError,
    );
    assert.throws(
      () => stripImageMetadata(concatenate([PNG_SIGNATURE, new Uint8Array([0, 0, 0, 13])]), "image/png"),
      TypeError,
    );
    assert.throws(
      () => stripImageMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 0]), "image/jpeg"),
      TypeError,
    );
  });
});

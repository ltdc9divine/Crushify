import assert from "node:assert/strict";
import sharp from "sharp";
import { describe, it } from "node:test";
import { MAX_IMAGE_BYTES } from "../src/http.ts";
import { normalizeNodeImage } from "../src/platform/node-image-normalizer.ts";

const sourceWidth = 12;
const sourceHeight = 8;
const blockSize = 4;
const sourcePixels = [
  [24, 72, 120],
  [168, 208, 240],
];

function concatenate(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function exifWithGps(orientation: number): Uint8Array {
  const tiff = new Uint8Array(92);
  const view = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49]);
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);

  view.setUint16(8, 2, true);
  view.setUint16(10, 0x0112, true);
  view.setUint16(12, 3, true);
  view.setUint32(14, 1, true);
  view.setUint16(18, orientation, true);
  view.setUint16(22, 0x8825, true);
  view.setUint16(24, 4, true);
  view.setUint32(26, 1, true);
  view.setUint32(30, 38, true);
  view.setUint32(34, 0, true);

  view.setUint16(38, 2, true);
  view.setUint16(40, 1, true);
  view.setUint16(42, 2, true);
  view.setUint32(44, 2, true);
  tiff.set([0x4e, 0], 48);
  view.setUint16(52, 2, true);
  view.setUint16(54, 5, true);
  view.setUint32(56, 3, true);
  view.setUint32(60, 68, true);
  view.setUint32(64, 0, true);
  [10, 1, 20, 1, 30, 1].forEach((value, index) => {
    view.setUint32(68 + index * 4, value, true);
  });

  const payload = concatenate([new TextEncoder().encode("Exif\0\0"), tiff]);
  const segmentLength = payload.byteLength + 2;
  const segment = new Uint8Array(payload.byteLength + 4);
  segment.set([0xff, 0xe1, segmentLength >> 8, segmentLength & 0xff]);
  segment.set(payload, 4);
  return segment;
}

function withExif(jpeg: Uint8Array, orientation: number): Uint8Array {
  return concatenate([jpeg.subarray(0, 2), exifWithGps(orientation), jpeg.subarray(2)]);
}

function orientedPosition(
  orientation: number,
  x: number,
  y: number,
): { x: number; y: number } {
  switch (orientation) {
    case 1: return { x, y };
    case 2: return { x: sourceWidth - 1 - x, y };
    case 3: return { x: sourceWidth - 1 - x, y: sourceHeight - 1 - y };
    case 4: return { x, y: sourceHeight - 1 - y };
    case 5: return { x: y, y: x };
    case 6: return { x: sourceHeight - 1 - y, y: x };
    case 7: return { x: sourceHeight - 1 - y, y: sourceWidth - 1 - x };
    case 8: return { x: y, y: sourceWidth - 1 - x };
    default: throw new RangeError("Invalid fixture orientation");
  }
}

async function orientedJpeg(orientation: number): Promise<Uint8Array> {
  const raw = Buffer.alloc(sourceWidth * sourceHeight * 3);
  for (let y = 0; y < sourceHeight; y++) {
    for (let x = 0; x < sourceWidth; x++) {
      const value = sourcePixels[Math.floor(y / blockSize)]![Math.floor(x / blockSize)]!;
      raw.fill(value, (y * sourceWidth + x) * 3, (y * sourceWidth + x) * 3 + 3);
    }
  }
  const jpeg = await sharp(raw, {
    raw: { width: sourceWidth, height: sourceHeight, channels: 3 },
  })
    .jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
    .withIccProfile("srgb")
    .toBuffer();
  return withExif(jpeg, orientation);
}

describe("Node image normalization", () => {
  for (let orientation = 1; orientation <= 8; orientation++) {
    it(`normalizes EXIF Orientation ${orientation} pixels and strips location metadata`, async () => {
      const input = await orientedJpeg(orientation);
      const sourceMetadata = await sharp(input).metadata();
      assert.equal(sourceMetadata.orientation, orientation);
      assert.ok(sourceMetadata.exif);
      assert.notEqual(Buffer.from(input).indexOf(Buffer.from([0x25, 0x88])), -1);
      assert.notEqual(Buffer.from(input).indexOf(Buffer.from([0x02, 0x00, 0x05, 0x00])), -1);

      const normalized = await normalizeNodeImage(input, "image/jpeg");
      const expectedWidth = orientation >= 5 ? sourceHeight : sourceWidth;
      const expectedHeight = orientation >= 5 ? sourceWidth : sourceHeight;
      assert.deepEqual(
        { width: normalized.width, height: normalized.height },
        { width: expectedWidth, height: expectedHeight },
      );

      const output = await sharp(normalized.bytes).raw().toBuffer({ resolveWithObject: true });
      assert.equal(output.info.width, expectedWidth);
      assert.equal(output.info.height, expectedHeight);
      assert.equal(output.info.channels, 3);
      for (let sourceY = 0; sourceY < 2; sourceY++) {
        for (let sourceX = 0; sourceX < 3; sourceX++) {
          const sourceCenterX = sourceX * blockSize + blockSize / 2;
          const sourceCenterY = sourceY * blockSize + blockSize / 2;
          const position = orientedPosition(orientation, sourceCenterX, sourceCenterY);
          const pixelOffset = (position.y * output.info.width + position.x) * output.info.channels;
          const actual = output.data[pixelOffset]!;
          assert.ok(
            Math.abs(actual - sourcePixels[sourceY]![sourceX]!) <= 5,
            `orientation ${orientation} pixel (${sourceX},${sourceY}) was ${actual}`,
          );
        }
      }

      const metadata = await sharp(normalized.bytes).metadata();
      assert.equal(metadata.orientation, undefined);
      assert.equal(metadata.exif, undefined);
      assert.equal(metadata.iptc, undefined);
      assert.equal(metadata.xmp, undefined);
      assert.ok(metadata.icc, "the input ICC profile must be preserved");
    });
  }

  it("does not rotate an already normalized JPEG a second time", async () => {
    const first = await normalizeNodeImage(await orientedJpeg(6), "image/jpeg");
    const second = await normalizeNodeImage(first.bytes, "image/jpeg");
    assert.deepEqual(
      { width: second.width, height: second.height },
      { width: first.width, height: first.height },
    );
  });

  it("preserves PNG pixels and ICC profile while stripping ancillary text", async () => {
    const raw = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255]);
    const source = new Uint8Array(await sharp(raw, {
      raw: { width: 3, height: 1, channels: 3 },
    }).png().withIccProfile("srgb").toBuffer());
    const normalized = await normalizeNodeImage(source, "image/png");
    const [sourcePixels, normalizedPixels] = await Promise.all([
      sharp(source).raw().toBuffer(),
      sharp(normalized.bytes).raw().toBuffer(),
    ]);
    assert.deepEqual(normalizedPixels, sourcePixels);
    assert.ok((await sharp(normalized.bytes).metadata()).icc);
  });

  it("rejects fake MIME data and oversized input", async () => {
    await assert.rejects(
      normalizeNodeImage(new Uint8Array([1, 2, 3]), "image/jpeg"),
      /normalize/,
    );
    await assert.rejects(
      normalizeNodeImage(new Uint8Array(MAX_IMAGE_BYTES + 1), "image/png"),
      /too large/,
    );
  });
});

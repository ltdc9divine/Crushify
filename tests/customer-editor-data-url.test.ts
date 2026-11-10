import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import vm from "node:vm";

async function loadDataImageParser() {
  const source = await readFile(
    new URL("../shared/customer-editor-data-url.js", import.meta.url),
    "utf8",
  );
  const window: Record<string, unknown> = {};
  vm.runInNewContext(source, {
    window,
    atob,
    Blob,
    Uint8Array,
    Error,
  });
  return window.crushifyDataImageBlob as (value: string) => Blob | null;
}

describe("customer editor data URL images", () => {
  it("decodes generated JPEG data without using fetch", async () => {
    const parse = await loadDataImageParser();
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const blob = parse(`data:image/jpeg;base64,${bytes.toString("base64")}`);

    assert.ok(blob instanceof Blob);
    assert.equal(blob.type, "image/jpeg");
    assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [...bytes]);
  });

  it("leaves non-data URLs to the normal fetch path", async () => {
    const parse = await loadDataImageParser();
    assert.equal(parse("blob:https://example.test/image-id"), null);
  });

  it("rejects unsupported or malformed data URLs", async () => {
    const parse = await loadDataImageParser();
    assert.throws(() => parse("data:image/svg+xml;base64,PHN2Zy8+"), /Ảnh dữ liệu/);
    assert.throws(() => parse("data:image/jpeg;base64,%%%"), /Ảnh dữ liệu/);
  });
});

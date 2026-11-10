import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import vm from "node:vm";

describe("customer preview asset resolution", () => {
  it("loads Our Memories cover and chapter images with the preview capability", async () => {
    const source = await readFile(
      new URL("../shared/publication-bootstrap.js", import.meta.url),
      "utf8",
    );
    const assetRequests: Array<{ url: string; authorization: string | null }> = [];
    const window: Record<string, unknown> = {};
    const context = {
      window,
      location: { search: "?preview", hash: "#synthetic-preview-token" },
      document: { currentScript: { dataset: {} }, body: { append() {}, replaceChildren() {} } },
      URLSearchParams,
      URL,
      fetch: async (url: string, options: { headers?: HeadersInit } = {}) => {
        const requestUrl = String(url);
        const authorization = new Headers(options.headers).get("Authorization");
        if (requestUrl === "/api/v1/previews") {
          return {
            ok: true,
            json: async () => ({
              template_id: "our-memories",
              schema_version: 1,
              data: {
                templateId: "our-memories",
                coverImage: "/api/v1/previews/assets/cover",
                chapters: [{
                  photos: [{
                    url: "/api/v1/previews/assets/chapter",
                    caption: "Synthetic memory",
                  }],
                }],
              },
            }),
          };
        }
        assetRequests.push({ url: requestUrl, authorization });
        return { ok: true, blob: async () => new Blob(["synthetic image"]) };
      },
    };

    vm.runInNewContext(source, context);
    const loaded = await (window.loadCrushifyPublication as (
      templateId: string,
    ) => Promise<Record<string, unknown>>)("our-memories");

    assert.equal(window.CRUSHIFY_CUSTOMER_PREVIEW, true);
    assert.equal(assetRequests.length, 2);
    assert.ok(assetRequests.every((request) =>
      request.authorization === "Bearer synthetic-preview-token"));
    assert.equal(typeof loaded.coverImage, "string");
    assert.ok((loaded.coverImage as string).startsWith("blob:"));
    const chapters = loaded.chapters as Array<{ photos: Array<{ url: string }> }>;
    assert.ok(chapters[0].photos[0].url.startsWith("blob:"));
  });
});

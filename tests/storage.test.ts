import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StorageUploadOptions } from "../src/storage.ts";
import { CloudinaryStorageAdapter } from "../src/storage/cloudinary.ts";
import { createStorageFromEnvironment } from "../src/storage/provider.ts";
import { R2StorageAdapter } from "../src/storage/r2.ts";

const now = 1_800_000_000_000;
const secret = "local-cloudinary-test-secret";
const key = `private/${"a".repeat(43)}-png`;
const legacyKey = `private/${"b".repeat(43)}.png`;
const bytes = new Uint8Array([1, 2, 3, 4]);
const options: StorageUploadOptions = {
  contentType: "image/png",
  sha256: "a".repeat(64),
  width: 1,
  height: 1,
};

async function expectedSignature(parameters: Record<string, string>): Promise<string> {
  const canonical = Object.entries(parameters)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(canonical + secret),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cloudinaryUploadResponse(publicId = key): Response {
  return Response.json({
    public_id: publicId,
    bytes: bytes.byteLength,
    format: "png",
    resource_type: "image",
    type: "authenticated",
  });
}

describe("CloudinaryStorageAdapter", () => {
  it("uses a signed authenticated upload and only emits short-lived private download URLs", async () => {
    let requestBody: FormData | undefined;
    const adapter = new CloudinaryStorageAdapter({
      cloudName: "local-cloud",
      apiKey: "local-api-key",
      apiSecret: secret,
      now: () => now,
      fetcher: async (_input, init) => {
        requestBody = init?.body as FormData;
        return cloudinaryUploadResponse();
      },
    });

    await adapter.upload(key, bytes, options);
    assert.ok(requestBody);
    assert.equal(requestBody.get("public_id"), key);
    assert.equal(requestBody.get("type"), "authenticated");
    assert.equal(requestBody.get("overwrite"), "false");
    assert.equal(requestBody.get("unique_filename"), "false");
    assert.equal(requestBody.get("api_key"), "local-api-key");
    assert.equal(
      requestBody.get("signature"),
      await expectedSignature({
        overwrite: "false",
        public_id: key,
        timestamp: String(Math.floor(now / 1000)),
        type: "authenticated",
        unique_filename: "false",
      }),
    );
    assert.equal(JSON.stringify([...requestBody.entries()]).includes(secret), false);

    const url = new URL(await adapter.privateAssetUrl(key, Math.floor(now / 1000) + 60));
    assert.equal(url.pathname, "/v1_1/local-cloud/image/private_download");
    assert.equal(url.searchParams.get("type"), "authenticated");
    assert.equal(url.searchParams.get("format"), "png");
    assert.equal(url.searchParams.get("expires_at"), String(Math.floor(now / 1000) + 60));
    assert.equal(
      url.searchParams.get("signature"),
      await expectedSignature({
        expires_at: String(Math.floor(now / 1000) + 60),
        format: "png",
        public_id: key,
        type: "authenticated",
      }),
    );
    assert.equal(url.toString().includes(secret), false);
  });

  it("rejects expired or excessively long private URLs and invalid upload metadata", async () => {
    const adapter = new CloudinaryStorageAdapter({
      cloudName: "local-cloud",
      apiKey: "local-api-key",
      apiSecret: secret,
      now: () => now,
      fetcher: async () => cloudinaryUploadResponse(),
    });
    const currentSecond = Math.floor(now / 1000);

    await assert.rejects(adapter.privateAssetUrl(key, currentSecond), /expiry/);
    await assert.rejects(adapter.privateAssetUrl(key, currentSecond + 301), /expiry/);
    await assert.rejects(adapter.upload("private/client-controlled.png", bytes, options), /server-generated/);
    await assert.rejects(
      adapter.upload(key, new Uint8Array(5 * 1024 * 1024 + 1), options),
      /size/,
    );
    await assert.rejects(
      adapter.upload(key, bytes, { ...options, contentType: "image/gif" as "image/png" }),
      /type/,
    );
  });

  it("validates Cloudinary upload metadata and reports provider failures without response secrets", async () => {
    const mismatch = new CloudinaryStorageAdapter({
      cloudName: "local-cloud",
      apiKey: "local-api-key",
      apiSecret: secret,
      now: () => now,
      fetcher: async () => cloudinaryUploadResponse(`${key}-other`),
    });
    await assert.rejects(mismatch.upload(key, bytes, options), /inconsistent upload metadata/);

    const failure = new CloudinaryStorageAdapter({
      cloudName: "local-cloud",
      apiKey: "local-api-key",
      apiSecret: secret,
      now: () => now,
      fetcher: async () => new Response(`provider rejected ${secret}`, { status: 500 }),
    });
    await assert.rejects(failure.upload(key, bytes, options), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /status 500/);
      assert.equal(error.message.includes(secret), false);
      return true;
    });
  });

  it("streams only bounded image responses and propagates binary deletion failures", async () => {
    let requestedUrl = "";
    let deleteRequest: FormData | undefined;
    const adapter = new CloudinaryStorageAdapter({
      cloudName: "local-cloud",
      apiKey: "local-api-key",
      apiSecret: secret,
      now: () => now,
      fetcher: async (input, init) => {
        requestedUrl = String(input);
        if (requestedUrl.endsWith("/image/destroy")) {
          deleteRequest = init?.body as FormData;
          return Response.json({ result: "error" });
        }
        return new Response(bytes, {
          headers: { "Content-Type": "image/png", "Content-Length": String(bytes.length) },
        });
      },
    });
    const stored = await adapter.get(key);
    assert.equal(new URL(requestedUrl).searchParams.get("type"), "authenticated");
    assert.equal(stored?.size, bytes.length);
    assert.equal(stored?.contentType, "image/png");
    assert.deepEqual(new Uint8Array(await stored!.arrayBuffer()), bytes);

    await assert.rejects(adapter.delete(key), /did not confirm asset deletion/);
    assert.ok(deleteRequest);
    assert.equal(deleteRequest.get("type"), "authenticated");
    assert.equal(deleteRequest.get("public_id"), key);
    assert.equal(JSON.stringify([...deleteRequest.entries()]).includes(secret), false);
  });
});

describe("storage provider selection and R2 adapter", () => {
  it("requires explicit configuration and never silently falls back", () => {
    assert.throws(() => createStorageFromEnvironment({}), /explicitly set/);
    assert.throws(
      () => createStorageFromEnvironment({ STORAGE_PROVIDER: "r2" }),
      /requires an R2 binding/,
    );
    assert.throws(
      () => createStorageFromEnvironment({ STORAGE_PROVIDER: "cloudinary" }),
      /credentials are required/,
    );
  });

  it("wraps an R2 binding behind the same private storage contract", async () => {
    const values = new Map<string, Uint8Array>();
    const bucket = {
      async put(objectKey: string, value: Uint8Array) {
        values.set(objectKey, new Uint8Array(value));
        return null;
      },
      async get(objectKey: string) {
        const value = values.get(objectKey);
        if (!value) return null;
        return {
          size: value.byteLength,
          httpMetadata: { contentType: "image/png" },
          body: new Response(value).body,
          arrayBuffer: async () => value.slice().buffer,
        };
      },
      async delete(objectKey: string) {
        values.delete(objectKey);
      },
    } as unknown as R2Bucket;
    const adapter = createStorageFromEnvironment({ STORAGE_PROVIDER: "r2" }, bucket);
    await adapter.upload(key, bytes, options);
    const object = await adapter.get(key);
    assert.equal(object?.size, bytes.length);
    assert.equal(object?.contentType, "image/png");
    assert.deepEqual(new Uint8Array(await object!.arrayBuffer()), bytes);
    assert.equal(await adapter.privateAssetUrl(key, now), null);
    await adapter.delete(key);
    assert.equal(await adapter.get(key), null);
    assert.equal(await adapter.get(legacyKey), null);
  });
});

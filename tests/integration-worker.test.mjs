import assert from "node:assert/strict";
import test from "node:test";
import { ImageNormalizationError } from "../src/image-normalizer.ts";
import { localTestImageNormalizer } from "./integration-worker.mjs";

const bridgeEnv = {
  ENVIRONMENT: "local",
  LOCAL_TEST_MODE: "true",
  LOCAL_TEST_IMAGE_NORMALIZER_URL: "http://127.0.0.1:12345/__crushify_test_image_normalizer",
};
const input = new Uint8Array([1, 2, 3]);

test("local image-normalizer bridge aborts requests after its bounded timeout", async () => {
  let requestSignal;
  const normalize = localTestImageNormalizer(bridgeEnv, {
    timeoutMs: 20,
    fetchImpl: (_url, options) => {
      requestSignal = options.signal;
      return new Promise((_resolve, reject) => {
        requestSignal.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
      });
    },
  });

  await assert.rejects(normalize(input, "image/png"), /timeout/i);
  assert.equal(requestSignal.aborted, true);
});

test("local image-normalizer bridge rejects failed and malformed responses", async (t) => {
  await t.test("non-success response", async () => {
    const normalize = localTestImageNormalizer(bridgeEnv, {
      fetchImpl: async () => Response.json(
        { code: "NORMALIZER_FAILED" },
        { status: 500 },
      ),
    });

    await assert.rejects(normalize(input, "image/png"), /returned 500/);
  });

  await t.test("invalid normalized bytes", async () => {
    const normalize = localTestImageNormalizer(bridgeEnv, {
      fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "X-Image-Width": "1",
          "X-Image-Height": "1",
        },
      }),
    });

    await assert.rejects(
      normalize(input, "image/png"),
      (error) => error instanceof ImageNormalizationError && error.code === "INVALID_IMAGE",
    );
  });
});

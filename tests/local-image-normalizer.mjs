import { createServer } from "node:http";
import { ImageNormalizationError } from "../src/image-normalizer.ts";
import { MAX_IMAGE_BYTES } from "../src/http.ts";
import { normalizeNodeImage } from "../src/platform/node-image-normalizer.ts";

const normalizerPath = "/__crushify_test_image_normalizer";
const imageContentTypes = new Set(["image/png", "image/jpeg"]);

export async function createLocalImageNormalizer() {
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== normalizerPath) {
      if (!response.destroyed) response.writeHead(404).end();
      return;
    }

    const contentType = request.headers["content-type"];
    if (typeof contentType !== "string" || !imageContentTypes.has(contentType)) {
      if (!response.destroyed) {
        response.writeHead(415, { "Cache-Control": "no-store" }).end();
      }
      return;
    }

    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.byteLength;
        if (size > MAX_IMAGE_BYTES) {
          if (!response.destroyed) {
            response.writeHead(413, { "Cache-Control": "no-store" })
              .end(JSON.stringify({ code: "IMAGE_TOO_LARGE" }));
          }
          return;
        }
        chunks.push(bytes);
      }
    } catch {
      if (!request.aborted && !response.destroyed) {
        response.writeHead(400, { "Cache-Control": "no-store" })
          .end(JSON.stringify({ code: "INVALID_REQUEST" }));
      }
      return;
    }

    try {
      const normalized = await normalizeNodeImage(
        new Uint8Array(Buffer.concat(chunks, size)),
        contentType,
      );
      if (!response.destroyed) {
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": normalized.contentType,
          "X-Image-Width": String(normalized.width),
          "X-Image-Height": String(normalized.height),
        }).end(Buffer.from(normalized.bytes));
      }
    } catch (error) {
      if (response.destroyed) return;
      if (!(error instanceof ImageNormalizationError)) {
        response.writeHead(500, { "Cache-Control": "no-store" })
          .end(JSON.stringify({ code: "NORMALIZER_FAILED" }));
        return;
      }
      const status = error.code === "IMAGE_TOO_LARGE" ? 413 : 422;
      response.writeHead(status, { "Cache-Control": "no-store" })
        .end(JSON.stringify({ code: error.code }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolve) => server.close(resolve));
    throw new Error("Local image normalizer did not bind to a TCP port");
  }

  return {
    url: `http://127.0.0.1:${address.port}${normalizerPath}`,
    async close() {
      const closing = new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      server.closeIdleConnections?.();
      await closing;
    },
  };
}

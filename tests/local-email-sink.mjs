import assert from "node:assert/strict";
import { createServer } from "node:http";

const sinkPath = "/__crushify_test_email_sink";

export async function createLocalEmailSink() {
  const messages = [];
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== sinkPath) {
      response.writeHead(404).end();
      return;
    }

    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) {
        response.writeHead(413).end();
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        const message = JSON.parse(body);
        assert.equal(typeof message.text, "string");
        messages.push(message);
        response.writeHead(204).end();
      } catch {
        response.writeHead(400).end();
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolve) => server.close(resolve));
    throw new Error("Local email sink did not bind to a TCP port");
  }

  let cursor = 0;
  return {
    url: `http://127.0.0.1:${address.port}${sinkPath}`,
    messages,
    current: () => messages.length,
    async waitForMagicToken(after = cursor, timeoutMs = 8_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        for (let index = after; index < messages.length; index++) {
          const match = messages[index].text.match(/#magic_token=([A-Za-z0-9_-]+)/);
          if (match) {
            cursor = index + 1;
            return match[1];
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("Local email sink did not receive a synthetic magic link");
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const host = "127.0.0.1";
const defaultPort = 8025;
const sinkPath = "/__crushify_test_email_sink";
const maximumBodyBytes = 64 * 1024;
const maximumMessages = 25;

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]);
}

function localMagicLink(text) {
  const match = text.match(/https?:\/\/[^\s<>]+#magic_token=[A-Za-z0-9_-]+/);
  if (!match) return null;
  try {
    const url = new URL(match[0]);
    if (url.protocol !== "http:" ||
        !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function inboxDocument(messages) {
  const cards = messages.length
    ? messages.map((message) => {
      const link = localMagicLink(message.text);
      return `<li><p><strong>${escapeHtml(message.subject)}</strong></p>` +
        `<p>To: ${escapeHtml(message.to)}</p>` +
        `<p>Received: ${escapeHtml(message.receivedAt)}</p>` +
        (link
          ? `<p><a rel="noreferrer" href="${escapeHtml(link)}">Open local sign-in link</a></p>`
          : "<p>No valid loopback sign-in link found.</p>") +
        "</li>";
    }).join("")
    : "<li>No local sign-in links yet. Refresh after requesting one.</li>";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Cache-Control" content="no-store">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Crushify local email inbox</title>
<style>
body{font:16px system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#242424}
li{border:1px solid #ccc;border-radius:8px;margin:1rem 0;padding:1rem}
a{font-weight:600}small{color:#555}
</style>
</head>
<body>
<h1>Crushify local email inbox</h1>
<p>No email is sent. Links are held in memory on this computer and disappear when this process stops.</p>
<p>Refresh this page after requesting a sign-in link. Only links targeting localhost are shown.</p>
<ul>${cards}</ul>
</body>
</html>`;
}

export async function startLocalEmailInbox({ port = defaultPort } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError("Local email inbox port must be between 0 and 65535");
  }

  const messages = [];
  const server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?", 1)[0];
    if (request.method === "GET" && path === "/") {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      }).end(inboxDocument([...messages].reverse()));
      return;
    }

    if (request.method !== "POST" || path !== sinkPath ||
        !request.headers["content-type"]?.startsWith("application/json")) {
      response.writeHead(404).end();
      return;
    }

    let body = "";
    let tooLarge = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > maximumBodyBytes) {
        tooLarge = true;
        response.writeHead(413).end();
        request.destroy();
      }
    });
    request.on("end", () => {
      if (tooLarge) return;
      try {
        const message = JSON.parse(body);
        if (typeof message.to !== "string" ||
            typeof message.subject !== "string" ||
            typeof message.text !== "string") {
          response.writeHead(400).end();
          return;
        }
        messages.push({
          to: message.to.slice(0, 320),
          subject: message.subject.slice(0, 200),
          text: message.text,
          receivedAt: new Date().toISOString(),
        });
        if (messages.length > maximumMessages) messages.shift();
        response.writeHead(204).end();
      } catch {
        response.writeHead(400).end();
      }
    });
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolveClose) => server.close(resolveClose));
    throw new Error("Local email inbox did not bind to a TCP port");
  }
  const origin = `http://${host}:${address.port}`;

  return {
    inboxUrl: `${origin}/`,
    sinkUrl: `${origin}${sinkPath}`,
    async close() {
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
    },
  };
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryPath && fileURLToPath(import.meta.url) === entryPath) {
  startLocalEmailInbox().then(({ inboxUrl, sinkUrl, close }) => {
    console.info(`Local email inbox: ${inboxUrl}`);
    console.info(`Set LOCAL_TEST_MAIL_SINK_URL=${sinkUrl} in local development config.`);
    const shutdown = () => close().then(() => process.exit(0));
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }).catch((error) => {
    console.error(
      "Local email inbox could not start:",
      error instanceof Error ? error.message : "unknown error",
    );
    process.exitCode = 1;
  });
}

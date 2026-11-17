import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startLocalEmailInbox } from "../scripts/dev-email-sink.mjs";

describe("local development email inbox", () => {
  let inbox;

  before(async () => {
    inbox = await startLocalEmailInbox({ port: 0 });
  });

  after(async () => {
    await inbox.close();
  });

  it("accepts local sign-in mail and renders only a loopback sign-in link", async () => {
    const token = "synthetic-token-123";
    const sent = await fetch(inbox.sinkUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: "customer@example.test",
        subject: "Your Crushify sign-in link",
        text: `Open http://localhost:3000/customers/#magic_token=${token}`,
      }),
    });
    assert.equal(sent.status, 204);

    const page = await fetch(inbox.inboxUrl);
    assert.equal(page.status, 200);
    assert.match(await page.text(), new RegExp(
      `href="http://localhost:3000/customers/#magic_token=${token}"`,
    ));
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  });

  it("escapes untrusted email fields and does not expose non-loopback links", async () => {
    const sent = await fetch(inbox.sinkUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: "customer@example.test",
        subject: "<script>alert(1)</script>",
        text: "Open https://example.test/#magic_token=external-token",
      }),
    });
    assert.equal(sent.status, 204);

    const page = await fetch(inbox.inboxUrl);
    const html = await page.text();
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /href="https:\/\/example\.test/);
    assert.match(html, /No valid loopback sign-in link found/);
  });

  it("rejects malformed or unexpected requests", async () => {
    const wrongPath = await fetch(inbox.inboxUrl, { method: "POST" });
    assert.equal(wrongPath.status, 404);
    const invalidJson = await fetch(inbox.sinkUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    assert.equal(invalidJson.status, 400);
  });
});

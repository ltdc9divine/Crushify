import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleApiRequest } from "../src/index.ts";
import { createEmailService, type EmailMessage } from "../src/auth.ts";
import { validateUniverseDesign } from "../src/universe.ts";
import { detectImage } from "../src/assets.ts";

const noBindings = { DB: undefined } as never;

describe("API foundation", () => {
  it("uses the configured Resend adapter and disables local mail mode in staging", async () => {
    const originalFetch = globalThis.fetch;
    let capturedRequest: { url: string; authorization: string | null; body: Record<string, unknown> } | null = null;
    globalThis.fetch = async (input, init) => {
      capturedRequest = {
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      return new Response(null, { status: 200 });
    };

    try {
      const mailer = createEmailService({
        ENVIRONMENT: "staging",
        LOCAL_TEST_MODE: "true",
        MAIL_PROVIDER: "resend",
        MAIL_API_KEY: "test-key",
        MAIL_FROM_EMAIL: "Crushify <noreply@example.test>",
      } as never, "https://crushify-staging.example.workers.dev");
      assert.ok(mailer);
      const message: EmailMessage = {
        to: "customer@example.test",
        subject: "Đăng nhập Crushify",
        text: "One-time link",
        html: "<h1>CRUSHIFY</h1>",
      };
      await mailer.send(message);
      assert.equal(capturedRequest?.url, "https://api.resend.com/emails");
      assert.equal(capturedRequest?.authorization, "Bearer test-key");
      assert.deepEqual(capturedRequest?.body, {
        from: "Crushify <noreply@example.test>",
        to: ["customer@example.test"],
        subject: "Đăng nhập Crushify",
        text: "One-time link",
        html: "<h1>CRUSHIFY</h1>",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(createEmailService({
      ENVIRONMENT: "staging",
      LOCAL_TEST_MODE: "true",
    } as never, "https://crushify-staging.example.workers.dev"), null);
  });

  it("returns a liveness response with a generated request ID", async () => {
    const response = await handleApiRequest(
      new Request("https://crushify.test/api/v1/health/live"),
      noBindings,
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, "ok");
    assert.equal(response.headers.get("x-request-id"), body.request_id);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  it("returns a structured 404 for unimplemented API routes", async () => {
    const response = await handleApiRequest(
      new Request("https://crushify.test/api/v1/not-implemented"),
      noBindings,
    );
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(body.error.code, "NOT_FOUND");
    assert.equal(response.headers.get("x-request-id"), body.request_id);
  });

  it("rejects non-GET health requests", async () => {
    const response = await handleApiRequest(
      new Request("https://crushify.test/api/v1/health/live", { method: "POST" }),
      noBindings,
    );

    assert.equal(response.status, 405);
  });

  it("reports not ready when the D1 binding is unavailable", async () => {
    const response = await handleApiRequest(
      new Request("https://crushify.test/api/v1/health/ready"),
      noBindings,
    );
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.error.code, "DEPENDENCY_UNAVAILABLE");
  });

  describe("Our Universe schema", () => {
    const valid = {
      sender: "Minh",
      receiver: "Linh",
      nickname: "Bé yêu",
      headline: "Một vũ trụ",
      subheadline: "Hai tâm hồn",
      mainMessage: "Lời nhắn",
      startDate: "2024-02-14",
      theme: "rose-nebula",
      animation: "cinematic",
      memories: [
        { title: "Lần đầu", description: "Bắt đầu" },
        { title: "Hành trình", description: "Cùng nhau" },
        { title: "Tương lai", description: "Mãi mãi" },
      ],
      photos: [],
    };

    it("accepts supported template data", () => {
      assert.deepEqual(validateUniverseDesign(valid).value, valid);
    });

    it("rejects unknown fields, invalid themes, invalid dates, and excess photos", () => {
      assert.ok(validateUniverseDesign({ ...valid, is_paid: true }).fields);
      assert.ok(validateUniverseDesign({ ...valid, theme: "arbitrary" }).fields);
      assert.ok(validateUniverseDesign({ ...valid, startDate: "2024-99-99" }).fields);
      assert.ok(validateUniverseDesign({
        ...valid,
        photos: Array.from({ length: 7 }, (_, index) => ({
          asset_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          caption: "",
        })),
      }).fields);
    });
  });

  describe("Image content validation", () => {
    it("accepts a structurally valid PNG header and rejects MIME-spoofed data", () => {
      const bytes = Uint8Array.from([
        137, 80, 78, 71, 13, 10, 26, 10,
        0, 0, 0, 13, 73, 72, 68, 82,
        0, 0, 0, 1, 0, 0, 0, 1,
        8, 6, 0, 0, 0, 31, 21, 196, 137,
        0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
      ]);
      assert.deepEqual(detectImage(bytes), { contentType: "image/png", width: 1, height: 1 });
      assert.equal(detectImage(new TextEncoder().encode("GIF89a")), null);
    });
  });
});

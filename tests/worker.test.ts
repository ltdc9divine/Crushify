import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleApiRequest } from "../src/index.ts";
import { createEmailService, type EmailMessage } from "../src/auth.ts";
import { validateUniverseDesign } from "../src/universe.ts";
import { detectImage } from "../src/assets.ts";
import worker from "../src/index.ts";
import { PUBLICATION_SHELL_CSP } from "../src/security-headers.ts";
import { createStorageFromEnvironment } from "../src/storage/provider.ts";

const noBindings = { DB: undefined } as never;

describe("legacy Worker storage isolation", () => {
  it("rejects Worker staging before storage or database initialization", async () => {
    const unsafeStaging = {
      ENVIRONMENT: "staging",
      STORAGE_PROVIDER: "cloudinary",
      CLOUDINARY_STAGING_CLOUD_NAME: "synthetic-staging-cloud",
      CLOUDINARY_STAGING_API_KEY: "synthetic-production-key",
      CLOUDINARY_STAGING_API_SECRET: "synthetic-production-secret",
      CLOUDINARY_PRODUCTION_CLOUD_NAME: "synthetic-production-cloud",
      CRON_SECRET: "synthetic-operator-secret-with-32-characters",
      STAGING_LIFECYCLE_SECRET: "c".repeat(64),
    };
    assert.throws(
      () => createStorageFromEnvironment(unsafeStaging),
      /disabled in staging/,
    );

    let databaseAccessed = false;
    const response = await worker.fetch(
      new Request("https://worker.example.test/api/ops/staging/publication-lifecycle", {
        method: "POST",
        headers: { Authorization: `Bearer ${unsafeStaging.STAGING_LIFECYCLE_SECRET}` },
      }),
      {
        ...unsafeStaging,
        DATABASE_PROVIDER: "d1",
        DB: {
          prepare() {
            databaseAccessed = true;
            throw new Error("Worker staging must not access the database");
          },
        } as never,
        ASSETS: { fetch: async () => new Response(null, { status: 404 }) } as never,
      } as never,
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { error: { code: string } }).error.code,
      "STAGING_RUNTIME_DISABLED");
    assert.equal(databaseAccessed, false);
  });

  it("keeps R2 selection explicit at the shared adapter factory", () => {
    const adapter = createStorageFromEnvironment({
      ENVIRONMENT: "staging",
      STORAGE_PROVIDER: "r2",
    }, {
      async put() {},
      async get() { return null; },
      async delete() {},
    } as never);
    assert.equal(adapter.constructor.name, "R2StorageAdapter");
  });

  it("rejects missing and unknown Worker markers instead of treating them as local", async () => {
    for (const environment of [undefined, "unknown"]) {
      const response = await worker.fetch(
        new Request("http://127.0.0.1/api/v1/nonexistent"),
        {
          ENVIRONMENT: environment,
          LOCAL_TEST_MODE: "true",
          DATABASE_PROVIDER: "d1",
          DB: {} as never,
          ASSETS: { fetch: async () => new Response(null, { status: 404 }) } as never,
        } as never,
      );
      assert.equal(response.status, 500);
      assert.equal((await response.json() as { error: { code: string } }).error.code,
        "RUNTIME_CONFIGURATION_ERROR");
    }
  });

  it("rejects staging Cloudinary variables in Production before Worker storage use", async () => {
    let databaseAccessed = false;
    const response = await worker.fetch(
      new Request("https://worker.example.test/api/v1/nonexistent"),
      {
        ENVIRONMENT: "production",
        DATABASE_PROVIDER: "d1",
        STORAGE_PROVIDER: "cloudinary",
        CLOUDINARY_CLOUD_NAME: "synthetic-production-cloud",
        CLOUDINARY_API_KEY: "synthetic-production-key",
        CLOUDINARY_API_SECRET: "synthetic-production-secret",
        CLOUDINARY_STAGING_CLOUD_NAME: "synthetic-staging-cloud",
        CLOUDINARY_STAGING_API_KEY: "synthetic-staging-key",
        CLOUDINARY_STAGING_API_SECRET: "synthetic-staging-secret",
        DB: {
          prepare() {
            databaseAccessed = true;
            throw new Error("Mixed Worker storage scopes must fail before database access");
          },
        } as never,
        ASSETS: { fetch: async () => new Response(null, { status: 404 }) } as never,
      } as never,
    );
    assert.equal(response.status, 500);
    assert.equal((await response.json() as { error: { code: string } }).error.code,
      "RUNTIME_CONFIGURATION_ERROR");
    assert.equal(databaseAccessed, false);
  });

  it("keeps Production Worker Cloudinary selection on generic credentials", async () => {
    const response = await worker.fetch(
      new Request("https://worker.example.test/api/v1/nonexistent"),
      {
        ENVIRONMENT: "production",
        DATABASE_PROVIDER: "d1",
        STORAGE_PROVIDER: "cloudinary",
        CLOUDINARY_CLOUD_NAME: "synthetic-production-cloud",
        CLOUDINARY_API_KEY: "synthetic-production-key",
        CLOUDINARY_API_SECRET: "synthetic-production-secret",
        DB: {} as never,
        ASSETS: { fetch: async () => new Response(null, { status: 404 }) } as never,
      } as never,
    );
    assert.equal(response.status, 404);
  });

  it("does not allow local-only flags in an explicitly Production Worker", async () => {
    const response = await worker.fetch(
      new Request("https://worker.example.test/api/v1/nonexistent"),
      {
        ENVIRONMENT: "production",
        LOCAL_TEST_MODE: "true",
        DATABASE_PROVIDER: "d1",
        DB: {} as never,
        ASSETS: { fetch: async () => new Response(null, { status: 404 }) } as never,
      } as never,
    );
    assert.equal(response.status, 500);
    assert.equal((await response.json() as { error: { code: string } }).error.code,
      "RUNTIME_CONFIGURATION_ERROR");
  });

  it("allows explicit local Worker execution only on a loopback request origin", async () => {
    const localResponse = await worker.fetch(
      new Request("http://127.0.0.1/api/v1/nonexistent"),
      {
        ENVIRONMENT: "local",
        DATABASE_PROVIDER: "d1",
        STORAGE_PROVIDER: "r2",
        DB: {} as never,
        MEDIA: {
          put: async () => undefined,
          get: async () => null,
          delete: async () => undefined,
        } as never,
        ASSETS: { fetch: async () => new Response(null, { status: 404 }) } as never,
      } as never,
    );
    assert.equal(localResponse.status, 404);

    const nonLocalRequest = await worker.fetch(
      new Request("https://worker.example.test/api/v1/nonexistent"),
      {
        ENVIRONMENT: "local",
        DATABASE_PROVIDER: "d1",
        DB: {} as never,
        ASSETS: { fetch: async () => new Response(null, { status: 404 }) } as never,
      } as never,
    );
    assert.equal(nonLocalRequest.status, 500);
    assert.equal((await nonLocalRequest.json() as { error: { code: string } }).error.code,
      "RUNTIME_CONFIGURATION_ERROR");
  });

  it("requires an explicit Production scope for scheduled maintenance", async () => {
    for (const environment of [undefined, "unknown", "staging", "local"]) {
      await assert.rejects(
        worker.scheduled({} as never, {
          ENVIRONMENT: environment,
          DATABASE_PROVIDER: "d1",
          DB: {} as never,
        } as never, { waitUntil() {} } as never),
        /explicitly scoped Production Worker/,
      );
    }
  });
});

describe("API foundation", () => {
  it("uses the configured Resend adapter only in Production and disables mail in Preview", async () => {
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
        ENVIRONMENT: "production",
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
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
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
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  });

  it("exposes approved catalog prices without enabling Production checkout", async () => {
    const response = await handleApiRequest(
      new Request("https://crushify.test/api/v1/catalog"),
      { ...noBindings, ENVIRONMENT: "production" } as never,
    );
    const body = await response.json() as {
      checkout_enabled: boolean;
      pricing_policy: { catalog_enabled: boolean };
      products: Array<{ id: string; base_price_minor: number; currency: string }>;
      storage_durations: Array<{
        id: string;
        amount_minor: number | null;
        hosting_charge_minor: number | null;
        enabled: boolean;
      }>;
    };

    assert.equal(response.status, 200);
    assert.equal(body.pricing_policy.catalog_enabled, true);
    assert.equal(body.checkout_enabled, false);
    assert.deepEqual(body.products.map((product) => product.id).sort(), [
      "distance-means-nothing", "love-letter", "our-memories", "our-universe", "say-yes",
    ]);
    assert.ok(body.products.every((product) =>
      product.base_price_minor === 59_000 && product.currency === "VND"));
    assert.deepEqual(body.storage_durations.map((plan) => plan.id), [
      "1-month", "3-months", "6-months", "12-months", "lifetime",
    ]);
    assert.deepEqual(body.storage_durations.map((plan) => plan.amount_minor), [
      59_000, 79_000, 109_000, 169_000, 199_000,
    ]);
    assert.ok(body.storage_durations.every((plan) => plan.enabled));

    const renewals = await handleApiRequest(
      new Request("https://crushify.test/api/v1/storage-plans"),
      { ...noBindings, ENVIRONMENT: "production" } as never,
    );
    const renewalBody = await renewals.json() as {
      checkout_enabled: boolean;
      plans: Array<{ id: string; amount_minor: number | null; available: boolean }>;
    };
    assert.equal(renewals.status, 200);
    assert.equal(renewalBody.checkout_enabled, false);
    assert.deepEqual(renewalBody.plans.map((plan) => plan.amount_minor), [
      10_000, 30_000, 60_000, 120_000, null,
    ]);
    assert.deepEqual(renewalBody.plans.map((plan) => plan.available), [
      true, true, true, true, false,
    ]);
  });

  it("preserves security headers on dashboard, preview, and error responses", async () => {
    const paths = [
      ["/api/v1/customers/me", 503],
      ["/api/v1/previews", 404],
      ["/api/v1/unimplemented", 404],
    ] as const;

    for (const [path, status] of paths) {
      const response = await handleApiRequest(
        new Request(`https://crushify.test${path}`),
        noBindings,
      );
      assert.equal(response.status, status);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("x-frame-options"), "DENY");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    }
  });

  it("adds a single restrictive policy to generated publication-shell responses", async () => {
    const response = await worker.fetch(new Request("http://127.0.0.1/p/synthetic-slug"), {
      ENVIRONMENT: "local",
      ASSETS: {
        fetch: async () => new Response("<!doctype html><title>Fixture</title>", {
          headers: { "content-type": "text/html" },
        }),
      },
    } as never);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-security-policy"), PUBLICATION_SHELL_CSP);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()");
    assert.equal(response.headers.get("content-security-policy")?.split("default-src").length, 2);
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

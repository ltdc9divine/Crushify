import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEmailService, type EmailMessage } from "../src/auth.ts";
import { logSafeError } from "../src/logging.ts";
import { createVercelApiHandler, validateVercelEnvironment } from "../src/platform/vercel.ts";
import type { Database } from "../src/database.ts";
import { MemoryStorageAdapter } from "../src/storage/mock.ts";
import type { Env } from "../src/types.ts";

const database: Database = {
  prepare() {
    throw new Error("The isolation probe must not query the database");
  },
  async batch() {
    throw new Error("The isolation probe must not query the database");
  },
};

function emailEnvironment(values: Partial<Env>): Env {
  return { ...values, DB: database };
}

const previewEnvironment = {
  DATABASE_PROVIDER: "turso",
  TURSO_STAGING_DATABASE_URL: "libsql://crushify-staging-synthetic.turso.io",
  TURSO_STAGING_AUTH_TOKEN: "synthetic-staging-token",
  STORAGE_PROVIDER: "cloudinary",
  CLOUDINARY_STAGING_CLOUD_NAME: "synthetic-staging-cloud",
  CLOUDINARY_STAGING_API_KEY: "synthetic-staging-key",
  CLOUDINARY_STAGING_API_SECRET: "synthetic-staging-secret",
  CLOUDINARY_PRODUCTION_CLOUD_NAME: "synthetic-production-cloud",
  ENVIRONMENT: "staging",
  APP_ORIGIN: "https://preview.crushify.test",
  VERCEL_ENV: "preview",
  VERCEL_URL: "preview.crushify.test",
} as const;

describe("pre-staging environment and storage isolation", () => {
  it("rejects missing staging database credentials before any provider is initialized", async () => {
    let databaseConnections = 0;
    let storageFactories = 0;
    const handler = createVercelApiHandler({
      ...previewEnvironment,
      STORAGE_PROVIDER: "mock",
      CLOUDINARY_STAGING_CLOUD_NAME: undefined,
      CLOUDINARY_STAGING_API_KEY: undefined,
      CLOUDINARY_STAGING_API_SECRET: undefined,
      TURSO_STAGING_AUTH_TOKEN: undefined,
    }, {
      async connectDatabase() {
        databaseConnections++;
        return { database, close: () => undefined };
      },
      createCloudinaryStorage() {
        storageFactories++;
        return new MemoryStorageAdapter();
      },
    });

    const response = await handler(new Request("https://preview.crushify.test/api/v1/nonexistent"));
    assert.equal(response.status, 500);
    assert.equal((await response.json() as { error: { code: string } }).error.code,
      "DATABASE_CONFIGURATION_ERROR");
    assert.equal(databaseConnections, 0);
    assert.equal(storageFactories, 0);
  });

  it("rejects Production database, Cloudinary, email, and payment credentials in Preview", async () => {
    for (const override of [
      { TURSO_DATABASE_URL: "libsql://production.synthetic.turso.io" },
      { CLOUDINARY_CLOUD_NAME: "synthetic-production-cloud" },
      { MAIL_PROVIDER: "resend" },
      { MAIL_API_KEY: "synthetic-production-mail-key" },
      { PAYMENT_MODE: "sepay-test" },
      { SEPAY_WEBHOOK_SECRET: "synthetic-production-webhook-secret" },
      { LOCAL_TEST_MAIL_SINK_URL: "http://127.0.0.1:1234/__crushify_test_email_sink" },
    ]) {
      const error = validateVercelEnvironment({ ...previewEnvironment, ...override });
      assert.equal(error, "RUNTIME_CONFIGURATION_ERROR");
    }
  });

  it("rejects a Preview Cloudinary identity matching Production before storage use", async () => {
    let databaseConnections = 0;
    let storageFactories = 0;
    const handler = createVercelApiHandler({
      ...previewEnvironment,
      CLOUDINARY_STAGING_CLOUD_NAME: previewEnvironment.CLOUDINARY_PRODUCTION_CLOUD_NAME,
    }, {
      async connectDatabase() {
        databaseConnections++;
        return { database, close: () => undefined };
      },
      createCloudinaryStorage() {
        storageFactories++;
        return new MemoryStorageAdapter();
      },
    });
    const response = await handler(new Request("https://preview.crushify.test/api/v1/nonexistent"));
    assert.equal(response.status, 500);
    assert.equal((await response.json() as { error: { code: string } }).error.code,
      "STORAGE_ISOLATION_ERROR");
    assert.equal(databaseConnections, 0);
    assert.equal(storageFactories, 0, "failed storage isolation must not initialize upload/delete capability");
  });

  it("does not let a self-declared confirmation replace the Production cloud identity", async () => {
    const configuration = {
      ...previewEnvironment,
      CLOUDINARY_PRODUCTION_CLOUD_NAME: undefined,
      CLOUDINARY_STAGING_ISOLATED_ACCOUNT: "I_CONFIRM_SEPARATE_FREE_CLOUD",
    };
    const handler = createVercelApiHandler(configuration, {
      async connectDatabase() {
        return { database, close: () => undefined };
      },
      createCloudinaryStorage: () => new MemoryStorageAdapter(),
    });
    const response = await handler(new Request("https://preview.crushify.test/api/v1/nonexistent"));
    assert.equal(response.status, 500);
    assert.equal((await response.json() as { error: { code: string } }).error.code,
      "STORAGE_ISOLATION_ERROR");
  });

  it("rejects every Preview Cloudinary configuration before initializing dependencies", async () => {
    let databaseConnections = 0;
    let storageFactories = 0;
    const preview = createVercelApiHandler(previewEnvironment, {
      async connectDatabase() {
        databaseConnections++;
        return { database, close: () => undefined };
      },
      createCloudinaryStorage(environment) {
        storageFactories++;
        return new MemoryStorageAdapter();
      },
    });

    it("initializes only explicitly configured Preview storage and does not email unallowlisted users", async () => {
      let databaseConnections = 0;
      let storageFactories = 0;
      let emailCalls = 0;
      const handler = createVercelApiHandler({
        ...previewEnvironment,
        PREVIEW_CUSTOMER_FLOW_ENABLED: "true",
        PREVIEW_ASSET_UPLOADS_ENABLED: "true",
        PREVIEW_AUTH_ALLOWED_EMAILS: "qa@example.test",
        PREVIEW_MAIL_PROVIDER: "resend",
        PREVIEW_MAIL_API_KEY: "synthetic-preview-resend-key",
        PREVIEW_MAIL_FROM_EMAIL: "Crushify Preview <noreply@preview.example.test>",
        PREVIEW_PAYMENT_MODE: "sepay-test",
        PREVIEW_SEPAY_WEBHOOK_SECRET: "a".repeat(64),
        PREVIEW_SEPAY_BANK_CODE: "MB",
        PREVIEW_SEPAY_BANK_ACCOUNT: "1234567890",
        STAGING_LIFECYCLE_SECRET: "b".repeat(64),
        VERCEL_BRANCH_URL: "preview.crushify.test",
      }, {
        async connectDatabase() {
          databaseConnections++;
          return { database, close: () => undefined };
        },
        createCloudinaryStorage() {
          storageFactories++;
          return new MemoryStorageAdapter();
        },
        async previewTestEmailSink() {
          emailCalls++;
        },
      });

      const response = await handler(new Request(
        "https://preview.crushify.test/api/v1/customers/session",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "other@example.test" }),
        },
      ));
      assert.equal(response.status, 202);
      assert.equal(storageFactories, 1);
      assert.equal(databaseConnections, 1);
      assert.equal(emailCalls, 0);
    });
    const response = await preview(new Request("https://preview.crushify.test/api/v1/nonexistent"));
    assert.equal(response.status, 500);
    assert.equal((await response.json() as { error: { code: string } }).error.code,
      "STORAGE_ISOLATION_ERROR");
    assert.equal(databaseConnections, 0);
    assert.equal(storageFactories, 0);

    const stagingOnlyIdentifier = validateVercelEnvironment({
      ...previewEnvironment,
      STORAGE_PROVIDER: "mock",
    });
    assert.equal(stagingOnlyIdentifier, "STORAGE_ISOLATION_ERROR");
  });

  it("does not treat Cloud names, variable names, or self-attestation as account verification", () => {
    const configurations = [
      {
        ...previewEnvironment,
        CLOUDINARY_PRODUCTION_CLOUD_NAME: undefined,
      },
      {
        ...previewEnvironment,
        CLOUDINARY_STAGING_CLOUD_NAME: undefined,
        CLOUDINARY_STAGING_API_KEY: undefined,
        CLOUDINARY_STAGING_API_SECRET: undefined,
        CLOUDINARY_PRODUCTION_CLOUD_NAME: undefined,
      },
      {
        ...previewEnvironment,
        CLOUDINARY_CLOUD_NAME: "synthetic-production-cloud",
        CLOUDINARY_API_KEY: "synthetic-production-key",
        CLOUDINARY_API_SECRET: "synthetic-production-secret",
        CLOUDINARY_STAGING_CLOUD_NAME: undefined,
        CLOUDINARY_STAGING_API_KEY: undefined,
        CLOUDINARY_STAGING_API_SECRET: undefined,
      },
      {
        ...previewEnvironment,
        CLOUDINARY_CLOUD_NAME: "synthetic-production-cloud",
        CLOUDINARY_API_KEY: "synthetic-production-key",
        CLOUDINARY_API_SECRET: "synthetic-production-secret",
      },
      {
        ...previewEnvironment,
        CLOUDINARY_STAGING_CLOUD_NAME: "different-synthetic-cloud",
        CLOUDINARY_PRODUCTION_CLOUD_NAME: "synthetic-production-cloud",
      },
      {
        ...previewEnvironment,
        CLOUDINARY_PRODUCTION_CLOUD_NAME: undefined,
        CLOUDINARY_STAGING_ISOLATED_ACCOUNT: "I_CONFIRM_SEPARATE_ACCOUNT",
      },
      {
        ...previewEnvironment,
        VERCEL_ENV: "unknown",
      },
    ];

    for (const configuration of configurations) {
      assert.notEqual(
        validateVercelEnvironment({ ...configuration, STORAGE_PROVIDER: "cloudinary" }),
        null,
      );
    }
  });

  it("blocks Preview upload, deletion, delivery, and derivative operations before storage initialization", async () => {
    let databaseConnections = 0;
    let cloudinaryFactories = 0;
    let mockFactories = 0;
    const handler = createVercelApiHandler({
      ...previewEnvironment,
      CLOUDINARY_PRODUCTION_CLOUD_NAME: undefined,
    }, {
      async connectDatabase() {
        databaseConnections++;
        return { database, close: () => undefined };
      },
      createCloudinaryStorage() {
        cloudinaryFactories++;
        return new MemoryStorageAdapter();
      },
      createMockStorage() {
        mockFactories++;
        return new MemoryStorageAdapter();
      },
    });

    const assetId = "00000000-0000-4000-8000-000000000001";
    const designId = "00000000-0000-4000-8000-000000000002";
    const publicationId = "00000000-0000-4000-8000-000000000003";
    const requests = [
      new Request("https://preview.crushify.test/api/v1/assets/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ design_id: designId, media_type: "image/png", size: 4 }),
      }),
      new Request(`https://preview.crushify.test/api/v1/assets/${assetId}/content`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${"a".repeat(43)}`, "Content-Type": "image/png" },
        body: new Uint8Array([1, 2, 3, 4]),
      }),
      new Request(`https://preview.crushify.test/api/v1/designs/${designId}`, {
        method: "DELETE",
      }),
      new Request(`https://preview.crushify.test/api/v1/previews/assets/${assetId}`),
      new Request(
        `https://preview.crushify.test/api/v1/publications/${publicationId}/publish`,
        { method: "POST" },
      ),
      new Request(
        `https://preview.crushify.test/api/v1/publications/${publicationId}/revoke`,
        { method: "POST" },
      ),
      new Request(
        `https://preview.crushify.test/api/v1/publications/g${"a".repeat(30)}/assets/${assetId}`,
      ),
    ];

    for (const request of requests) {
      const response = await handler(request);
      assert.equal(response.status, 500);
      assert.equal((await response.json() as { error: { code: string } }).error.code,
        "STORAGE_ISOLATION_ERROR");
    }
    assert.equal(databaseConnections, 0);
    assert.equal(cloudinaryFactories, 0);
    assert.equal(mockFactories, 0, "Cloudinary failures must not silently switch storage providers");
  });

  it("keeps Production Cloudinary selection on the existing generic credential set", async () => {
    let selectedConfiguration: {
      CLOUDINARY_CLOUD_NAME?: string;
      CLOUDINARY_API_KEY?: string;
      CLOUDINARY_API_SECRET?: string;
      CLOUDINARY_STAGING_CLOUD_NAME?: string;
    } | undefined;
    const production = createVercelApiHandler({
      DATABASE_PROVIDER: "turso",
      TURSO_DATABASE_URL: "https://database.synthetic.invalid",
      TURSO_AUTH_TOKEN: "synthetic-database-token",
      STORAGE_PROVIDER: "cloudinary",
      CLOUDINARY_CLOUD_NAME: "synthetic-production-cloud",
      CLOUDINARY_API_KEY: "synthetic-production-key",
      CLOUDINARY_API_SECRET: "synthetic-production-secret",
      ENVIRONMENT: "production",
      VERCEL_ENV: "production",
      VERCEL_PROJECT_PRODUCTION_URL: "crushify.test",
    }, {
      async connectDatabase() {
        return { database, close: () => undefined };
      },
      createCloudinaryStorage(environment) {
        selectedConfiguration = environment;
        return new MemoryStorageAdapter();
      },
    });
    const response = await production(
      new Request("https://crushify.test/api/v1/nonexistent"),
    );
    assert.equal(response.status, 404);
    assert.equal(selectedConfiguration?.CLOUDINARY_CLOUD_NAME, "synthetic-production-cloud");
    assert.equal(selectedConfiguration?.CLOUDINARY_API_KEY, "synthetic-production-key");
    assert.equal(selectedConfiguration?.CLOUDINARY_API_SECRET, "synthetic-production-secret");
    assert.equal(selectedConfiguration?.CLOUDINARY_STAGING_CLOUD_NAME, undefined);
  });

  it("does not instantiate Preview mock storage and keeps local mock selection functional", async () => {
    let previewMockCreated = false;
    const preview = createVercelApiHandler({
      ...previewEnvironment,
      STORAGE_PROVIDER: "mock",
      CLOUDINARY_STAGING_CLOUD_NAME: undefined,
      CLOUDINARY_STAGING_API_KEY: undefined,
      CLOUDINARY_STAGING_API_SECRET: undefined,
    }, {
      async connectDatabase() {
        return { database, close: () => undefined };
      },
      createMockStorage() {
        previewMockCreated = true;
        return new MemoryStorageAdapter();
      },
    });
    assert.equal(
      (await preview(new Request("https://preview.crushify.test/api/v1/nonexistent"))).status,
      404,
    );
    assert.equal(previewMockCreated, false);

    let localMockCreated = false;
    const local = createVercelApiHandler({
      DATABASE_PROVIDER: "turso",
      TURSO_DATABASE_URL: "file:local-test.db",
      STORAGE_PROVIDER: "mock",
      LOCAL_TEST_MODE: "true",
      ENVIRONMENT: "local",
      APP_ORIGIN: "https://crushify.test",
      VERCEL_ENV: "development",
    }, {
      async connectDatabase() {
        return { database, close: () => undefined };
      },
      createMockStorage() {
        localMockCreated = true;
        return new MemoryStorageAdapter();
      },
    });
    assert.equal((await local(new Request("https://crushify.test/api/v1/nonexistent"))).status, 404);
    assert.equal(localMockCreated, true);
  });
});

describe("safe logs", () => {
  it("drops synthetic credentials, URLs, email links, payloads, and user content", () => {
    const sentinels = [
      "SENTINEL_AUTHORIZATION",
      "SENTINEL_COOKIE",
      "SENTINEL_PASSWORD",
      "SENTINEL_TOKEN",
      "libsql://sentinel-db.example?authToken=SENTINEL_DB_URL",
      "SENTINEL_WEBHOOK_SIGNATURE",
      "https://preview.example/#magic_token=SENTINEL_MAGIC_LINK",
      "SENTINEL_USER_CONTENT",
    ];
    const originalError = console.error;
    const output: unknown[][] = [];
    console.error = (...values: unknown[]) => output.push(values);
    try {
      logSafeError("test.synthetic_failure", "api", new Error(sentinels.join(" ")), {
        request_id: "SENTINEL_TOKEN",
        environment: "local",
        ...Object.fromEntries(sentinels.map((value, index) => [`sentinel_${index}`, value])),
      } as never);
      logSafeError(
        sentinels[3],
        "auth",
        new Error("synthetic"),
        { environment: "local" },
      );
    } finally {
      console.error = originalError;
    }
    const serialized = output.flat().join("\n");
    for (const sentinel of sentinels) assert.equal(serialized.includes(sentinel), false);
    assert.match(serialized, /"error_type":"Error"/);
    assert.match(serialized, /test\.synthetic_failure/);
    assert.match(serialized, /invalid\.event/);
  });
});

describe("environment-specific email policy", () => {
  const message: EmailMessage = {
    to: "synthetic-recipient@example.test",
    subject: "Synthetic sign-in",
    text: "https://preview.crushify.test/#magic_token=SENTINEL_MAGIC_LINK",
  };

  it("fails closed in Preview without a sink and discards mail when the sink is enabled", async () => {
    assert.equal(createEmailService(emailEnvironment({
      ENVIRONMENT: "staging",
    }), "https://preview.crushify.test"), null);
    assert.equal(createEmailService({
      DB: database,
      ENVIRONMENT: "staging",
      MAIL_PROVIDER: "resend",
      MAIL_API_KEY: "synthetic-production-key",
      MAIL_FROM_EMAIL: "sender@example.test",
    }, "https://preview.crushify.test"), null);

    const originalInfo = console.info;
    const output: unknown[][] = [];
    console.info = (...values: unknown[]) => output.push(values);
    try {
      const sink = createEmailService({
        DB: database,
        ENVIRONMENT: "staging",
        PREVIEW_EMAIL_SINK: "discard",
      }, "https://preview.crushify.test");
      assert.ok(sink);
      await sink.send(message);
    } finally {
      console.info = originalInfo;
    }
    assert.equal(JSON.stringify(output).includes("SENTINEL_MAGIC_LINK"), false);
    assert.equal(JSON.stringify(output).includes("synthetic-recipient"), false);
  });

  it("rejects conflicting Preview discard and Resend configuration", async () => {
    const originalFetch = globalThis.fetch;
    let sent = false;
    const originalInfo = console.info;
    const output: unknown[][] = [];
    console.info = (...values: unknown[]) => output.push(values);
    globalThis.fetch = async () => {
      sent = true;
      return new Response(null, { status: 200 });
    };
    try {
      const conflicting = createEmailService({
        DB: database,
        ENVIRONMENT: "staging",
        PREVIEW_CUSTOMER_FLOW_ENABLED: "true",
        PREVIEW_AUTH_ALLOWED_EMAILS: "qa@example.test",
        PREVIEW_EMAIL_SINK: "discard",
        PREVIEW_MAIL_PROVIDER: "resend",
        PREVIEW_MAIL_API_KEY: "synthetic-preview-key",
        PREVIEW_MAIL_FROM_EMAIL: "preview@example.test",
      }, "https://preview.crushify.test");
      assert.equal(conflicting, null);
      assert.equal(sent, false);
      assert.equal(JSON.stringify(output).includes("synthetic-recipient"), false);
      assert.equal(JSON.stringify(output).includes("preview@example.test"), false);
    } finally {
      console.info = originalInfo;
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps local mail mock-only and preserves the Production Resend adapter", async () => {
    const localMessages: EmailMessage[] = [];
    const local = createEmailService({
      DB: database,
      ENVIRONMENT: "local",
      LOCAL_TEST_MODE: "true",
      LOCAL_TEST_EMAIL_SINK: async (value) => {
        localMessages.push(value);
      },
    }, "http://localhost:3000");
    assert.ok(local);
    await local.send(message);
    assert.deepEqual(localMessages, [message]);
    assert.equal(createEmailService({
      DB: database,
      ENVIRONMENT: "local",
      LOCAL_TEST_MODE: "true",
      LOCAL_TEST_MAIL_SINK_URL: "https://not-loopback.example/__crushify_test_email_sink",
    }, "http://localhost:3000"), null);

    const originalFetch = globalThis.fetch;
    let sent = false;
    globalThis.fetch = async () => {
      sent = true;
      return new Response(null, { status: 200 });
    };
    try {
      const production = createEmailService({
        DB: database,
        ENVIRONMENT: "production",
        MAIL_PROVIDER: "resend",
        MAIL_API_KEY: "synthetic-production-key",
        MAIL_FROM_EMAIL: "sender@example.test",
      }, "https://crushify.test");
      assert.ok(production);
      await production.send(message);
      assert.equal(sent, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses only dedicated Preview Resend credentials and restricts recipients", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(null, { status: 200 });
    };
    try {
      const preview = createEmailService({
        DB: database,
        ENVIRONMENT: "staging",
        PREVIEW_CUSTOMER_FLOW_ENABLED: "true",
        PREVIEW_AUTH_ALLOWED_EMAILS: "qa@example.test, admin@example.test",
        PREVIEW_MAIL_PROVIDER: "resend",
        PREVIEW_MAIL_API_KEY: "synthetic-preview-key",
        PREVIEW_MAIL_FROM_EMAIL: "Crushify Preview <sender@preview.example.test>",
        MAIL_PROVIDER: undefined,
      }, "https://preview.crushify.test");
      assert.ok(preview);
      await preview.send({
        ...message,
        to: "QA@example.test",
      });
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, "https://api.resend.com/emails");
      assert.equal(requests[0].authorization, "Bearer synthetic-preview-key");
      assert.deepEqual(requests[0].body.to, ["QA@example.test"]);
      assert.equal(requests[0].body.from, "Crushify Preview <sender@preview.example.test>");

      await assert.rejects(
        preview.send({ ...message, to: "arbitrary@example.test" }),
        /recipient is not authorized/,
      );
      assert.equal(requests.length, 1, "an unapproved recipient must not reach Resend");

      assert.equal(createEmailService({
        DB: database,
        ENVIRONMENT: "staging",
        PREVIEW_CUSTOMER_FLOW_ENABLED: "true",
        PREVIEW_AUTH_ALLOWED_EMAILS: "qa@example.test",
        MAIL_PROVIDER: "resend",
        MAIL_API_KEY: "synthetic-production-key",
        MAIL_FROM_EMAIL: "sender@example.test",
      }, "https://preview.crushify.test"), null,
      "Preview must not fall back to Production credentials");
      assert.equal(createEmailService({
        DB: database,
        ENVIRONMENT: "production",
        PREVIEW_MAIL_PROVIDER: "resend",
        PREVIEW_MAIL_API_KEY: "synthetic-preview-key",
        PREVIEW_MAIL_FROM_EMAIL: "sender@preview.example.test",
      }, "https://crushify.test"), null,
      "Production must not use Preview credentials");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("restricts Preview discard to disabled customer flow and fails closed on partial mail settings", async () => {
    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = async () => {
      requestCount++;
      return new Response(null, { status: 200 });
    };
    try {
      const blockedDiscard = createEmailService({
        DB: database,
        ENVIRONMENT: "staging",
        PREVIEW_CUSTOMER_FLOW_ENABLED: "true",
        PREVIEW_EMAIL_SINK: "discard",
      }, "https://preview.crushify.test");
      assert.equal(blockedDiscard, null);

      const discarded = createEmailService({
        DB: database,
        ENVIRONMENT: "staging",
        PREVIEW_EMAIL_SINK: "discard",
      }, "https://preview.crushify.test");
      assert.ok(discarded);
      await discarded.send(message);
      assert.equal(requestCount, 0);

      for (const settings of [
        { PREVIEW_MAIL_PROVIDER: "resend" as const },
        { PREVIEW_MAIL_PROVIDER: "resend" as const, PREVIEW_MAIL_API_KEY: "synthetic-key" },
        {
          PREVIEW_MAIL_PROVIDER: "resend" as const,
          PREVIEW_MAIL_API_KEY: "synthetic-key",
          PREVIEW_MAIL_FROM_EMAIL: "invalid-sender",
        },
      ]) {
        assert.equal(createEmailService({
          DB: database,
          ENVIRONMENT: "staging",
          PREVIEW_CUSTOMER_FLOW_ENABLED: "true",
          PREVIEW_AUTH_ALLOWED_EMAILS: "qa@example.test",
          ...settings,
        }, "https://preview.crushify.test"), null);
      }
      assert.equal(requestCount, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

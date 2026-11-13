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

  it("keeps the explicit Preview mock and local mock selection functional", async () => {
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
    assert.equal(previewMockCreated, true);

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
});

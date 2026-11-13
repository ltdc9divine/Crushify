import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createVercelApiHandler } from "../src/platform/vercel.ts";
import { createPublicationUrl } from "../src/publications.ts";

function preflight(handler: (request: Request) => Promise<Response>, origin: string): Promise<Response> {
  return handler(new Request(`${origin}/api/v1/nonexistent`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "content-type",
    },
  }));
}

describe("Vercel environment and origin isolation", () => {
  it("uses the current Preview deployment origin and never the Production URL", async () => {
    const handler = createVercelApiHandler({
      VERCEL_ENV: "preview",
      ENVIRONMENT: "staging",
      VERCEL_URL: "deployment-123.preview.test",
      VERCEL_PROJECT_PRODUCTION_URL: "crushify.example.com",
      STORAGE_PROVIDER: "mock",
    });

    assert.equal((await preflight(handler, "https://deployment-123.preview.test")).status, 204);
    assert.equal((await preflight(handler, "https://crushify.example.com")).status, 403);
  });

  it("rejects Preview origin overrides that are Production, malformed, or ambiguous", async () => {
    const common = {
      VERCEL_ENV: "preview",
      ENVIRONMENT: "staging",
      VERCEL_URL: "deployment-123.preview.test",
      VERCEL_PROJECT_PRODUCTION_URL: "crushify.example.com",
      STORAGE_PROVIDER: "mock",
    };

    for (const APP_ORIGIN of [
      "https://crushify.example.com",
      "https://deployment-123.preview.test/path",
      "https://user@deployment-123.preview.test",
    ]) {
      const handler = createVercelApiHandler({ ...common, APP_ORIGIN });
      const response = await preflight(handler, "https://deployment-123.preview.test");
      assert.equal(response.status, 500);
      assert.equal((await response.json() as { error: { code: string } }).error.code,
        "RUNTIME_CONFIGURATION_ERROR");
    }

    const missingDeploymentUrl = createVercelApiHandler({
      VERCEL_ENV: "preview",
      ENVIRONMENT: "staging",
      APP_ORIGIN: "https://deployment-123.preview.test",
      VERCEL_PROJECT_PRODUCTION_URL: "crushify.example.com",
      STORAGE_PROVIDER: "mock",
    });
    assert.equal((await preflight(missingDeploymentUrl, "https://deployment-123.preview.test")).status, 500);

    for (const override of [
      { VERCEL_URL: "https://deployment-123.preview.test/path" },
      { VERCEL_PROJECT_PRODUCTION_URL: "crushify..example.com" },
    ]) {
      const handler = createVercelApiHandler({ ...common, ...override });
      assert.equal((await preflight(handler, "https://deployment-123.preview.test")).status, 500);
    }
  });

  it("requires a known Vercel environment and explicit Preview pairing", async () => {
    for (const environment of [
      { ENVIRONMENT: "local" },
      { VERCEL_ENV: "unknown", ENVIRONMENT: "local" },
      { VERCEL_ENV: "preview" },
      { VERCEL_ENV: "preview", ENVIRONMENT: "production" },
    ]) {
      const handler = createVercelApiHandler({
        ...environment,
        APP_ORIGIN: "https://deployment-123.preview.test",
        VERCEL_URL: "deployment-123.preview.test",
      });
      const response = await handler(new Request("https://request.invalid/api/v1/health/live"));
      assert.equal(response.status, 500);
      assert.equal((await response.json() as { error: { code: string } }).error.code,
        "RUNTIME_CONFIGURATION_ERROR");
    }
  });

  it("preserves Production origin resolution and explicit local development", async () => {
    const production = createVercelApiHandler({
      VERCEL_ENV: "production",
      ENVIRONMENT: "production",
      VERCEL_URL: "deployment-123.preview.test",
      VERCEL_PROJECT_PRODUCTION_URL: "crushify.example.com",
    });
    assert.equal((await preflight(production, "https://crushify.example.com")).status, 204);
    assert.equal((await preflight(production, "https://deployment-123.preview.test")).status, 403);

    const local = createVercelApiHandler({
      VERCEL_ENV: "development",
      ENVIRONMENT: "local",
    });
    assert.equal((await preflight(local, "http://127.0.0.1:8787")).status, 204);
  });

  it("blocks remote database credentials in local development", async () => {
    let databaseConnections = 0;
    const handler = createVercelApiHandler({
      VERCEL_ENV: "development",
      ENVIRONMENT: "local",
      APP_ORIGIN: "http://127.0.0.1:8787",
      DATABASE_PROVIDER: "turso",
      TURSO_DATABASE_URL: "libsql://production.example.turso.io",
      TURSO_AUTH_TOKEN: "synthetic-token",
      STORAGE_PROVIDER: "mock",
      LOCAL_TEST_MODE: "true",
    }, {
      async connectDatabase() {
        databaseConnections++;
        throw new Error("Remote database must not be used by local development");
      },
    });

    const response = await handler(new Request("http://127.0.0.1:8787/api/v1/nonexistent"));
    assert.equal(response.status, 500);
    assert.equal((await response.json() as { error: { code: string } }).error.code,
      "DATABASE_CONFIGURATION_ERROR");
    assert.equal(databaseConnections, 0);
  });

  it("uses the validated application origin for publication links", () => {
    const request = new Request("https://crushify.example.com/api/v1/publications");
    const previewEnvironment = {
      ENVIRONMENT: "staging",
      APP_ORIGIN: "https://deployment-123.preview.test",
    };
    assert.equal(
      createPublicationUrl(request, "synthetic-slug", previewEnvironment as never),
      "https://deployment-123.preview.test/p/synthetic-slug",
    );
    assert.throws(
      () => createPublicationUrl(request, "synthetic-slug", {
        ENVIRONMENT: "staging",
      } as never),
      /validated application origin/,
    );
  });

  it("rejects a staging-scoped lifecycle request in Production or an unknown environment", async () => {
    const secret = "synthetic-cron-secret-with-at-least-32-characters";
    for (const environment of [
      { VERCEL_ENV: "production", ENVIRONMENT: "staging" },
      { VERCEL_ENV: undefined, ENVIRONMENT: "staging" },
    ]) {
      const handler = createVercelApiHandler({
        ...environment,
        CRON_SECRET: secret,
      });
      const response = await handler(new Request(
        "https://crushify.example.com/api/cron/publication-lifecycle",
        { headers: { Authorization: `Bearer ${secret}` } },
      ));
      assert.equal(response.status, 404);
    }
  });
});

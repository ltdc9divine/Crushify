import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleApiRequest } from "../src/index.ts";
import type {
  Database,
  DatabaseResult,
  DatabaseStatement,
} from "../src/database.ts";
import { createEmailService, getSession, requireSession, type EmailMessage } from "../src/auth.ts";
import type { Env } from "../src/types.ts";

const requestId = "00000000-0000-4000-8000-000000000001";

function databaseResult(): DatabaseResult {
  return {
    results: [],
    success: true,
    meta: { changes: 1, last_row_id: 1 },
  };
}

class SyntheticAuthDatabase implements Database {
  readonly queries: string[] = [];
  batchCalls = 0;

  prepare(query: string): DatabaseStatement {
    this.queries.push(query);
    const statement: DatabaseStatement = {
      bind() {
        return statement;
      },
      async first<T>() {
        const normalized = query.replace(/\s+/g, " ").trim();
        if (normalized.startsWith("SELECT request_count")) {
          return { request_count: 1 } as T;
        }
        if (normalized.startsWith("SELECT id, status FROM customers")) {
          return { id: "synthetic-customer-id", status: "ACTIVE" } as T;
        }
        if (normalized.startsWith("UPDATE login_tokens SET consumed_at")) {
          return { customer_id: "synthetic-customer-id" } as T;
        }
        if (normalized.startsWith("SELECT status FROM customers")) {
          return { status: "ACTIVE" } as T;
        }
        if (normalized.startsWith("SELECT s.id, s.customer_id")) {
          return {
            id: "synthetic-session-id",
            customer_id: "synthetic-customer-id",
            csrf_token_hash: "synthetic-csrf-hash",
            email_normalized: "qa-auth@example.test",
          } as T;
        }
        if (normalized.startsWith("SELECT status, email_normalized FROM customers")) {
          return { status: "ACTIVE", email_normalized: "qa-auth@example.test" } as T;
        }
        if (normalized.startsWith("SELECT email FROM customers")) {
          return { email: "qa-auth@example.test" } as T;
        }
        return null;
      },
      async all<T>() {
        return { ...databaseResult(), results: [] as T[] };
      },
      async run<T>() {
        return { ...databaseResult(), results: [] as T[] };
      },
    };
    return statement;
  }

  async batch(_statements: DatabaseStatement[]): Promise<DatabaseResult[]> {
    this.batchCalls++;
    return [databaseResult(), databaseResult()];
  }
}

function makeRequest(
  path: string,
  method = "GET",
  options: { body?: string; cookie?: string; headers?: HeadersInit } = {},
): Request {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.cookie) headers.set("Cookie", options.cookie);
  return new Request(`https://preview.crushify.test/api/v1${path}`, {
    method,
    headers,
    body: options.body,
  });
}

function spyOnRandomTokenGeneration(): { calls: number; restore(): void } {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, "getRandomValues");
  const original = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  let calls = 0;
  Object.defineProperty(globalThis.crypto, "getRandomValues", {
    configurable: true,
    writable: true,
    value: (array: Uint8Array) => {
      calls++;
      return original(array);
    },
  });
  return {
    get calls() {
      return calls;
    },
    restore() {
      if (descriptor) {
        Object.defineProperty(globalThis.crypto, "getRandomValues", descriptor);
      } else {
        Reflect.deleteProperty(globalThis.crypto, "getRandomValues");
      }
    },
  };
}

function spyOnConsoleInfo(): { events: string[]; restore(): void } {
  const descriptor = Object.getOwnPropertyDescriptor(console, "info");
  const events: string[] = [];
  Object.defineProperty(console, "info", {
    configurable: true,
    writable: true,
    value: (...values: unknown[]) => events.push(values.map(String).join(" ")),
  });
  return {
    events,
    restore() {
      if (descriptor) {
        Object.defineProperty(console, "info", descriptor);
      } else {
        Reflect.deleteProperty(console, "info");
      }
    },
  };
}

describe("environment-scoped authentication", () => {
  it("does not allow discarded Preview email to enable customer authentication", () => {
    const service = createEmailService({
      DB: new SyntheticAuthDatabase(),
      ENVIRONMENT: "staging",
      PREVIEW_CUSTOMER_FLOW_ENABLED: "true",
      PREVIEW_EMAIL_SINK: "discard",
    }, "https://preview.crushify.test");

    assert.equal(service, null);
  });

  it("rejects Preview authentication before database, token, or email side effects", async () => {
    const db = new SyntheticAuthDatabase();
    const emailMessages: EmailMessage[] = [];
    let providerCalls = 0;
    const env: Env = {
      DB: db,
      ENVIRONMENT: "staging",
      APP_ORIGIN: "https://preview.crushify.test",
      PREVIEW_EMAIL_SINK: "discard",
      MAILER: {
        async fetch() {
          providerCalls++;
          return new Response(null, { status: 200 });
        },
      },
      LOCAL_TEST_EMAIL_SINK: async (message) => emailMessages.push(message),
    };
    const randomSpy = spyOnRandomTokenGeneration();
    const logSpy = spyOnConsoleInfo();

    try {
      const login = await handleApiRequest(
        makeRequest("/customers/session", "POST", { body: "{" }),
        env,
      );
      const verify = await handleApiRequest(
        makeRequest("/customers/session/verify", "POST", { body: "{" }),
        env,
      );
      const me = await handleApiRequest(
        makeRequest("/customers/me", "GET", { cookie: "crushify_session=synthetic-valid-session" }),
        env,
      );

      for (const response of [login, verify, me]) {
        assert.equal(response.status, 503);
        assert.equal(
          (await response.json() as { error: { code: string } }).error.code,
          "AUTH_UNAVAILABLE",
        );
        assert.equal(response.headers.get("set-cookie"), null);
      }
      assert.deepEqual(db.queries, []);
      assert.equal(db.batchCalls, 0);
      assert.equal(randomSpy.calls, 0);
      assert.equal(providerCalls, 0);
      assert.deepEqual(emailMessages, []);
      assert.equal(logSpy.events.some((event) => event.includes("email.preview_sink_discarded")), false);

      const existingSession = await getSession(
        makeRequest("/customers/me", "GET", { cookie: "crushify_session=synthetic-valid-session" }),
        env,
      );
      assert.equal(existingSession, null);
      assert.deepEqual(db.queries, [], "Preview must not query or refresh a matching session record");
      assert.equal(randomSpy.calls, 0);
    } finally {
      randomSpy.restore();
      logSpy.restore();
    }
  });

  it("fails closed for an unknown runtime even when request data claims Production", async () => {
    const db = new SyntheticAuthDatabase();
    const randomSpy = spyOnRandomTokenGeneration();
    const env: Env = { DB: db };

    try {
      const response = await handleApiRequest(
        makeRequest("/customers/session", "POST", {
          body: JSON.stringify({ email: "qa-auth@example.test", environment: "production" }),
          headers: { "x-vercel-env": "production" },
        }),
        env,
      );
      assert.equal(response.status, 503);
      assert.equal(
        (await response.json() as { error: { code: string } }).error.code,
        "AUTH_UNAVAILABLE",
      );
      assert.deepEqual(db.queries, []);
      assert.equal(randomSpy.calls, 0);

      const required = await requireSession(
        makeRequest("/customers/me", "GET", { cookie: "crushify_session=synthetic-session" }),
        env,
        requestId,
      );
      assert.equal(required.response?.status, 503);
      assert.deepEqual(db.queries, []);
    } finally {
      randomSpy.restore();
    }
  });

  it("allows safe Preview logout cookie cleanup without reading or mutating session records", async () => {
    const db = new SyntheticAuthDatabase();
    const response = await handleApiRequest(
      makeRequest("/customers/session", "DELETE", {
        cookie: "crushify_session=stale; crushify_csrf=stale",
      }),
      { DB: db, ENVIRONMENT: "staging" },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(db.queries, []);
    assert.equal(db.batchCalls, 0);
    const cookies = response.headers.get("set-cookie") ?? "";
    assert.match(cookies, /crushify_session=;[^,]*Max-Age=0/);
    assert.match(cookies, /crushify_csrf=;[^,]*Max-Age=0/);
    assert.doesNotMatch(cookies, /crushify_session=[^;,]+/);
  });

  it("enables Preview magic links only for an allowlisted address and keeps cookies secure", async () => {
    const db = new SyntheticAuthDatabase();
    const messages: EmailMessage[] = [];
    const env: Env = {
      DB: db,
      ENVIRONMENT: "staging",
      PREVIEW_CUSTOMER_FLOW_ENABLED: "true",
      PREVIEW_AUTH_ALLOWED_EMAILS: "qa-auth@example.test",
      APP_ORIGIN: "https://preview.crushify.test",
      PREVIEW_TEST_EMAIL_SINK: async (message) => messages.push(message),
    };
    const responseMessage = "If the address can be used, a sign-in link has been sent.";
    const blocked = await handleApiRequest(
      makeRequest("/customers/session", "POST", {
        body: JSON.stringify({ email: "other@example.test" }),
      }),
      env,
    );
    assert.equal(blocked.status, 202);
    assert.equal((await blocked.json() as { message: string }).message, responseMessage);
    assert.deepEqual(db.queries, []);
    assert.deepEqual(messages, []);

    const invalidDraftReturn = await handleApiRequest(
      makeRequest("/customers/session", "POST", {
        body: JSON.stringify({
          email: "qa-auth@example.test",
          return_to: "/templates/our-universe/?guest_draft=not-a-uuid",
        }),
      }),
      env,
    );
    assert.equal(invalidDraftReturn.status, 400);

    const login = await handleApiRequest(
      makeRequest("/customers/session", "POST", {
        body: JSON.stringify({
          email: "QA-Auth@example.test",
          return_to: "/templates/our-universe/?guest_draft=123e4567-e89b-42d3-a456-426614174000",
        }),
      }),
      env,
    );
    assert.equal(login.status, 202);
    const loginBody = await login.json();
    assert.equal((loginBody as { message: string }).message, responseMessage);
    assert.doesNotMatch(JSON.stringify(loginBody), /magic_token|https:\/\/preview\.crushify\.test/);
    assert.equal(messages.length, 1);
    assert.match(messages[0].text, /\/templates\/our-universe\/\?guest_draft=123e4567-e89b-42d3-a456-426614174000#magic_token=/);
    const token = messages[0].text.match(/#magic_token=([A-Za-z0-9_-]+)/)?.[1];
    assert.ok(token);

    const dashboardLogin = await handleApiRequest(
      makeRequest("/customers/session", "POST", {
        body: JSON.stringify({
          email: "qa-auth@example.test",
          return_to: "/account/websites/",
        }),
      }),
      env,
    );
    assert.equal(dashboardLogin.status, 202);
    assert.match(messages[1].text, /\/account\/websites\/#magic_token=/);

    const verified = await handleApiRequest(
      makeRequest("/customers/session/verify", "POST", {
        body: JSON.stringify({ token }),
      }),
      env,
    );
    assert.equal(verified.status, 200);
    assert.match(verified.headers.get("set-cookie") ?? "", /crushify_session=[^;,]+;[^,]*Secure/);
    assert.match(verified.headers.get("set-cookie") ?? "", /crushify_csrf=[^;,]+;[^,]*Secure/);

    const sessionCookie = verified.headers.get("set-cookie")
      ?.match(/crushify_session=[^;,]+/)?.[0];
    assert.ok(sessionCookie);
    const session = await handleApiRequest(
      makeRequest("/customers/me", "GET", { cookie: sessionCookie }),
      env,
    );
    assert.equal(session.status, 200);
  });

  it("does not expose Preview magic-link content when email delivery fails", async () => {
    const db = new SyntheticAuthDatabase();
    let messageText = "";
    const env: Env = {
      DB: db,
      ENVIRONMENT: "staging",
      PREVIEW_CUSTOMER_FLOW_ENABLED: "true",
      PREVIEW_AUTH_ALLOWED_EMAILS: "qa-auth@example.test",
      APP_ORIGIN: "https://preview.crushify.test",
      PREVIEW_TEST_EMAIL_SINK: async (message) => {
        messageText = message.text;
        throw new Error(message.text);
      },
    };
    const originalError = console.error;
    const logged: string[] = [];
    console.error = (...values: unknown[]) => logged.push(values.map(String).join(" "));
    try {
      const response = await handleApiRequest(
        makeRequest("/customers/session", "POST", {
          body: JSON.stringify({ email: "qa-auth@example.test" }),
        }),
        env,
      );
      assert.equal(response.status, 502);
      const responseText = await response.text();
      const token = messageText.match(/#magic_token=([A-Za-z0-9_-]+)/)?.[1];
      assert.ok(token);
      for (const output of [responseText, logged.join("\n")]) {
        assert.equal(output.includes(token), false);
        assert.equal(output.includes("https://preview.crushify.test"), false);
        assert.equal(output.includes("qa-auth@example.test"), false);
      }
    } finally {
      console.error = originalError;
    }
  });

  it("keeps a public read-only health route available in Preview", async () => {
    const response = await handleApiRequest(
      makeRequest("/health/live"),
      { DB: new SyntheticAuthDatabase(), ENVIRONMENT: "staging" },
    );

    assert.equal(response.status, 200);
    assert.equal((await response.json() as { status: string }).status, "ok");
  });

  it("preserves synthetic Production and local magic-link/session flows", async () => {
    for (const runtime of ["production", "local"] as const) {
      const db = new SyntheticAuthDatabase();
      const messages: EmailMessage[] = [];
      let providerCalls = 0;
      const env: Env = runtime === "production"
        ? {
            DB: db,
            ENVIRONMENT: runtime,
            APP_ORIGIN: "https://crushify.test",
            MAILER_AUTH_TOKEN: "synthetic-mailer-token",
            MAILER: {
              async fetch(input, init) {
                providerCalls++;
                const request = new Request(input, init);
                messages.push(await request.json() as EmailMessage);
                return new Response(null, { status: 200 });
              },
            },
          }
        : {
            DB: db,
            ENVIRONMENT: runtime,
            LOCAL_TEST_MODE: "true",
            APP_ORIGIN: "http://127.0.0.1:8787",
            LOCAL_TEST_EMAIL_SINK: async (message) => messages.push(message),
          };

      const origin = runtime === "production"
        ? "https://crushify.test"
        : "http://127.0.0.1:8787";
      const login = await handleApiRequest(new Request(`${origin}/api/v1/customers/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "qa-auth@example.test" }),
      }), env);
      assert.equal(login.status, 202, `${runtime}: login request remains enabled`);
      assert.equal(messages.length, 1, `${runtime}: synthetic mail sink is invoked`);
      assert.equal(providerCalls, runtime === "production" ? 1 : 0);
      assert.ok(db.queries.some((query) => query.includes("INSERT INTO customers")));
      assert.ok(db.queries.some((query) => query.includes("INSERT INTO login_tokens")));

      const token = messages[0].text.match(/#magic_token=([A-Za-z0-9_-]+)/)?.[1];
      assert.ok(token, `${runtime}: synthetic magic-link token is created`);
      const verified = await handleApiRequest(new Request(`${origin}/api/v1/customers/session/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      }), env);
      assert.equal(verified.status, 200, `${runtime}: session verification remains enabled`);
      assert.match(verified.headers.get("set-cookie") ?? "", /crushify_session=/);
      assert.match(verified.headers.get("set-cookie") ?? "", /crushify_csrf=/);
      assert.equal(db.batchCalls, 1, `${runtime}: a synthetic session is persisted`);

      const sessionCookie = verified.headers.get("set-cookie")
        ?.match(/crushify_session=[^;,]+/)?.[0];
      assert.ok(sessionCookie);
      const account = await handleApiRequest(new Request(`${origin}/api/v1/customers/me`, {
        headers: { Cookie: sessionCookie },
      }), env);
      assert.equal(account.status, 200, `${runtime}: the created session remains usable`);
    }
  });
});

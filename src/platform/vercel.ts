import { apiError } from "../http.ts";
import { handleApiRequest } from "../index.ts";
import { connectDatabaseFromEnvironment } from "../database/provider.ts";
import type { Database } from "../database.ts";
import type { Storage } from "../storage.ts";
import { CloudinaryStorageAdapter } from "../storage/cloudinary.ts";
import { MemoryStorageAdapter } from "../storage/mock.ts";
import { runScheduledPublicationLifecycle } from "../scheduler.ts";
import {
  handleStagingOperationsRequest,
  type StagingOperation,
  type StagingOperationResult,
} from "./staging-operations.ts";
import type { Env } from "../types.ts";

export const VERCEL_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
const allowedMethods = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const allowedHeaders = new Set(["authorization", "content-type", "idempotency-key", "x-csrf-token"]);

export interface VercelEnvironment {
  DATABASE_PROVIDER?: string;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  ENVIRONMENT?: string;
  STORAGE_PROVIDER?: string;
  CLOUDINARY_CLOUD_NAME?: string;
  CLOUDINARY_API_KEY?: string;
  CLOUDINARY_API_SECRET?: string;
  MAIL_PROVIDER?: string;
  MAIL_API_KEY?: string;
  MAIL_FROM_EMAIL?: string;
  APP_ORIGIN?: string;
  LOCAL_TEST_MODE?: string;
  VERCEL_ENV?: string;
  VERCEL_URL?: string;
  VERCEL_PROJECT_ID?: string;
  CRON_SECRET?: string;
  STAGING_OPS_TOKEN?: string;
  DATA_RETENTION_DAYS?: string;
  PAYMENT_MODE?: string;
  SEPAY_WEBHOOK_SECRET?: string;
  SEPAY_BANK_CODE?: string;
  SEPAY_BANK_ACCOUNT?: string;
  SEPAY_ACCOUNT_NAME?: string;
}

interface DatabaseConnection {
  database: Database;
  close: () => void;
}

export interface VercelRuntimeDependencies {
  connectDatabase?: (environment: VercelEnvironment) => Promise<DatabaseConnection>;
  createCloudinaryStorage?: (environment: VercelEnvironment) => Storage;
  createMockStorage?: () => Storage;
  runStagingOperation?: (
    environment: VercelEnvironment,
    operation: StagingOperation,
    preflightId: string | null,
  ) => Promise<Omit<StagingOperationResult, "operation_id">>;
}

function requestId(): string {
  return crypto.randomUUID();
}

function originFromEnvironment(environment: VercelEnvironment): string | null {
  if (environment.APP_ORIGIN) {
    try {
      const parsed = new URL(environment.APP_ORIGIN);
      if (parsed.origin !== environment.APP_ORIGIN ||
          (parsed.protocol !== "https:" &&
            !(environment.VERCEL_ENV === "development" &&
              (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") &&
              parsed.protocol === "http:"))) {
        return null;
      }
      return parsed.origin;
    } catch {
      return null;
    }
  }
  if (environment.VERCEL_ENV === "preview" && environment.VERCEL_URL &&
      /^[A-Za-z0-9.-]+$/.test(environment.VERCEL_URL)) {
    return `https://${environment.VERCEL_URL}`;
  }
  return null;
}

function runtimeEnvironment(environment: VercelEnvironment): Env["ENVIRONMENT"] {
  if (environment.ENVIRONMENT === "staging" &&
      (environment.VERCEL_ENV === "preview" || environment.VERCEL_ENV === "production")) {
    return "staging";
  }
  if (environment.ENVIRONMENT === "local" && environment.VERCEL_ENV === "development") {
    return "local";
  }
  if (environment.ENVIRONMENT === "production" && environment.VERCEL_ENV === "production") {
    return "production";
  }
  if (environment.VERCEL_ENV === "production") return "production";
  if (environment.VERCEL_ENV === "preview") return "staging";
  return "local";
}

function validateEnvironmentOverride(environment: VercelEnvironment): boolean {
  if (environment.ENVIRONMENT === undefined) return true;
  if (environment.ENVIRONMENT === "staging") {
    return environment.VERCEL_ENV === "preview" || environment.VERCEL_ENV === "production";
  }
  if (environment.ENVIRONMENT === "production") return environment.VERCEL_ENV === "production";
  if (environment.ENVIRONMENT === "local") return environment.VERCEL_ENV === "development";
  return false;
}

function corsHeaders(origin: string): Headers {
  return new Headers({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": allowedMethods,
    "Access-Control-Allow-Headers": [...allowedHeaders].join(", "),
    "Access-Control-Max-Age": "600",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  });
}

function withCors(response: Response, request: Request, allowedOrigin: string | null): Response {
  if (!allowedOrigin || request.headers.get("origin") !== allowedOrigin) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", allowedOrigin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.append("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function validateDatabaseConfiguration(environment: VercelEnvironment): string | null {
  if (environment.DATABASE_PROVIDER !== "turso") return "DATABASE_CONFIGURATION_ERROR";
  const url = environment.TURSO_DATABASE_URL;
  if (!url) return "DATABASE_CONFIGURATION_ERROR";
  let protocol: string;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
    protocol = parsedUrl.protocol;
  } catch {
    return "DATABASE_CONFIGURATION_ERROR";
  }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    return "DATABASE_CONFIGURATION_ERROR";
  }
  if (protocol === "file:" && environment.VERCEL_ENV !== "development") {
    return "DATABASE_CONFIGURATION_ERROR";
  }
  if (protocol !== "file:" && !environment.TURSO_AUTH_TOKEN?.trim()) {
    return "DATABASE_CONFIGURATION_ERROR";
  }
  if (protocol !== "file:" && protocol !== "libsql:" && protocol !== "https:") {
    return "DATABASE_CONFIGURATION_ERROR";
  }
  if (environment.ENVIRONMENT === "staging") {
    const hostname = parsedUrl.hostname;
    if (protocol === "file:" || !/^crushify-staging(?:-[a-z0-9-]+)?\.turso\.io$/i.test(hostname)) {
      return "DATABASE_CONFIGURATION_ERROR";
    }
  }
  return null;
}

function createStorage(
  environment: VercelEnvironment,
  dependencies: VercelRuntimeDependencies,
): Storage {
  if (environment.STORAGE_PROVIDER === "cloudinary") {
    const cloudName = environment.CLOUDINARY_CLOUD_NAME;
    const apiKey = environment.CLOUDINARY_API_KEY;
    const apiSecret = environment.CLOUDINARY_API_SECRET;
    if (!cloudName || !apiKey || !apiSecret ||
        (environment.ENVIRONMENT === "staging" && cloudName !== "hgtcizux")) {
      throw new TypeError("Cloudinary configuration is incomplete");
    }
    return dependencies.createCloudinaryStorage
      ? dependencies.createCloudinaryStorage(environment)
      : new CloudinaryStorageAdapter({ cloudName, apiKey, apiSecret });
  }
  if (environment.STORAGE_PROVIDER === "mock" &&
      environment.LOCAL_TEST_MODE === "true" &&
      environment.VERCEL_ENV === "development") {
    return (dependencies.createMockStorage ?? (() => new MemoryStorageAdapter()))();
  }
  throw new TypeError("Storage provider is not configured for this runtime");
}

const livenessDatabase: Database = {
  prepare() {
    throw new Error("Database is not used by the liveness endpoint");
  },
  async batch() {
    throw new Error("Database is not used by the liveness endpoint");
  },
};

function safeErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error &&
      typeof error.code === "string" && /^[A-Z0-9_-]{1,40}$/i.test(error.code)) {
    return error.code;
  }
  return error instanceof Error ? error.name : "UnknownError";
}

function secureSecretMatch(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected || expected.length < 32) return false;
  const left = new TextEncoder().encode(provided);
  const right = new TextEncoder().encode(expected);
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export function createVercelApiHandler(
  environment: VercelEnvironment,
  dependencies: VercelRuntimeDependencies = {},
): (request: Request) => Promise<Response> {
  let databasePromise: Promise<DatabaseConnection> | undefined;
  let storage: Storage | undefined;

  const connectDatabase = dependencies.connectDatabase ?? (async (config: VercelEnvironment) =>
    connectDatabaseFromEnvironment(config));

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/api/ops/staging") {
      return handleStagingOperationsRequest(request, environment, {
        runOperation: dependencies.runStagingOperation,
      });
    }
    if (url.pathname === "/api/cron/publication-lifecycle") {
      if (request.method !== "GET") {
        return apiError(requestId(), 405, "METHOD_NOT_ALLOWED", "Method not allowed");
      }
      if (!secureSecretMatch(
        request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null,
        environment.CRON_SECRET,
      )) {
        return apiError(requestId(), 401, "UNAUTHENTICATED", "Scheduled request is not authorized");
      }
      if (environment.ENVIRONMENT !== "staging" ||
          !["preview", "production"].includes(environment.VERCEL_ENV ?? "")) {
        return apiError(requestId(), 404, "NOT_FOUND", "Route not found");
      }
      const databaseError = validateDatabaseConfiguration(environment);
      if (databaseError) {
        return apiError(requestId(), 500, databaseError, "Database provider is not configured for this runtime");
      }
      try {
        storage ??= createStorage(environment, dependencies);
      } catch {
        return apiError(requestId(), 500, "STORAGE_CONFIGURATION_ERROR", "Storage provider is not configured for this runtime");
      }
      if (!databasePromise) {
        const connection = connectDatabase(environment).catch((error: unknown) => {
          if (databasePromise === connection) databasePromise = undefined;
          throw error;
        });
        databasePromise = connection;
      }
      try {
        const connection = await databasePromise;
        const result = await runScheduledPublicationLifecycle({
          DB: connection.database,
          STORAGE: storage,
          ENVIRONMENT: "staging",
          DATA_RETENTION_DAYS: environment.DATA_RETENTION_DAYS,
        });
        return Response.json(result, {
          status: result.acquired ? 200 : 202,
          headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
        });
      } catch (error) {
        console.error("Vercel scheduled lifecycle failed", { code: safeErrorCode(error) });
        return apiError(requestId(), 503, "DEPENDENCY_UNAVAILABLE", "Scheduled maintenance could not complete");
      }
    }

    const origin = originFromEnvironment(environment);
    const requestOrigin = request.headers.get("origin");

    if (request.method === "OPTIONS") {
      const requestedMethod = request.headers.get("access-control-request-method")?.toUpperCase();
      const requestedHeaders = (request.headers.get("access-control-request-headers") ?? "")
        .split(",").map((header) => header.trim().toLowerCase()).filter(Boolean);
      if (!origin || requestOrigin !== origin || !requestedMethod ||
          !allowedMethods.split(", ").includes(requestedMethod) ||
          requestedHeaders.some((header) => !allowedHeaders.has(header))) {
        return apiError(requestId(), 403, "CORS_REJECTED", "Request origin is not allowed");
      }
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === "/api/v1/health/live") {
      return withCors(await handleApiRequest(request, { DB: livenessDatabase }), request, origin);
    }

    if (!["development", "preview", "production"].includes(environment.VERCEL_ENV ?? "") || !origin) {
      return apiError(requestId(), 500, "RUNTIME_CONFIGURATION_ERROR", "Application origin is not configured for this runtime");
    }
    if (!validateEnvironmentOverride(environment)) {
      return apiError(requestId(), 500, "RUNTIME_CONFIGURATION_ERROR", "Application environment does not match the Vercel deployment");
    }

    const databaseError = validateDatabaseConfiguration(environment);
    if (databaseError) {
      return withCors(
        apiError(requestId(), 500, databaseError, "Database provider is not configured for this runtime"),
        request,
        origin,
      );
    }

    try {
      storage ??= createStorage(environment, dependencies);
    } catch {
      return withCors(
        apiError(requestId(), 500, "STORAGE_CONFIGURATION_ERROR", "Storage provider is not configured for this runtime"),
        request,
        origin,
      );
    }

    if (!databasePromise) {
      const connection = connectDatabase(environment).catch((error: unknown) => {
        if (databasePromise === connection) databasePromise = undefined;
        throw error;
      });
      databasePromise = connection;
    }

    let connection: DatabaseConnection;
    try {
      connection = await databasePromise;
    } catch (error) {
      console.error("Vercel database initialization failed", { code: safeErrorCode(error) });
      return withCors(
        apiError(requestId(), 503, "DEPENDENCY_UNAVAILABLE", "Service unavailable"),
        request,
        origin,
      );
    }

    const appEnvironment = runtimeEnvironment(environment);
    const appOrigin = origin ?? undefined;
    const appEnv: Env = {
      DB: connection.database,
      STORAGE: storage,
      DATABASE_PROVIDER: "turso",
      STORAGE_PROVIDER: environment.STORAGE_PROVIDER === "cloudinary" ? "cloudinary" : undefined,
      CLOUDINARY_CLOUD_NAME: environment.CLOUDINARY_CLOUD_NAME,
      CLOUDINARY_API_KEY: environment.CLOUDINARY_API_KEY,
      CLOUDINARY_API_SECRET: environment.CLOUDINARY_API_SECRET,
      ENVIRONMENT: appEnvironment,
      MAIL_PROVIDER: environment.MAIL_PROVIDER === "resend" ? "resend" : undefined,
      MAIL_API_KEY: environment.MAIL_API_KEY,
      MAIL_FROM_EMAIL: environment.MAIL_FROM_EMAIL,
      APP_ORIGIN: appOrigin,
      LOCAL_TEST_MODE: environment.LOCAL_TEST_MODE === "true" &&
          environment.VERCEL_ENV === "development" && appEnvironment === "local"
        ? "true"
        : undefined,
      PAYMENT_MODE: environment.VERCEL_ENV === "development" &&
          environment.LOCAL_TEST_MODE === "true" &&
          (environment.PAYMENT_MODE === "mock" || environment.PAYMENT_MODE === "sepay-test")
        ? environment.PAYMENT_MODE
        : undefined,
      SEPAY_WEBHOOK_SECRET: environment.VERCEL_ENV === "development" &&
          environment.LOCAL_TEST_MODE === "true" ? environment.SEPAY_WEBHOOK_SECRET : undefined,
      SEPAY_BANK_CODE: environment.VERCEL_ENV === "development" &&
          environment.LOCAL_TEST_MODE === "true" ? environment.SEPAY_BANK_CODE : undefined,
      SEPAY_BANK_ACCOUNT: environment.VERCEL_ENV === "development" &&
          environment.LOCAL_TEST_MODE === "true" ? environment.SEPAY_BANK_ACCOUNT : undefined,
      SEPAY_ACCOUNT_NAME: environment.VERCEL_ENV === "development" &&
          environment.LOCAL_TEST_MODE === "true" ? environment.SEPAY_ACCOUNT_NAME : undefined,
      UPLOAD_MAX_BYTES: VERCEL_UPLOAD_MAX_BYTES,
    };

    return withCors(await handleApiRequest(request, appEnv), request, origin);
  };
}

import { apiError } from "../http.ts";
import { handleApiRequest } from "../index.ts";
import { connectDatabaseFromEnvironment } from "../database/provider.ts";
import type { Database } from "../database.ts";
import type { Storage } from "../storage.ts";
import { CloudinaryStorageAdapter } from "../storage/cloudinary.ts";
import { MemoryStorageAdapter } from "../storage/mock.ts";
import { runScheduledPublicationLifecycle } from "../scheduler.ts";
import type { Env } from "../types.ts";

export const VERCEL_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
const allowedMethods = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const allowedHeaders = new Set(["authorization", "content-type", "idempotency-key", "x-csrf-token"]);
const stagingTursoHostname = /^crushify-staging(?:-[a-z0-9-]+)?\.turso\.io$/i;
const previouslyAssumedCloudinaryTestCloud = "hgtcizux";
const stagingCloudinaryConfirmation = "I_CONFIRM_SEPARATE_FREE_CLOUD";

export interface VercelEnvironment {
  DATABASE_PROVIDER?: string;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  TURSO_STAGING_DATABASE_URL?: string;
  TURSO_STAGING_AUTH_TOKEN?: string;
  ENVIRONMENT?: string;
  STORAGE_PROVIDER?: string;
  CLOUDINARY_CLOUD_NAME?: string;
  CLOUDINARY_API_KEY?: string;
  CLOUDINARY_API_SECRET?: string;
  CLOUDINARY_STAGING_CLOUD_NAME?: string;
  CLOUDINARY_STAGING_API_KEY?: string;
  CLOUDINARY_STAGING_API_SECRET?: string;
  CLOUDINARY_STAGING_ISOLATED_ACCOUNT?: string;
  MAIL_PROVIDER?: string;
  MAIL_API_KEY?: string;
  MAIL_FROM_EMAIL?: string;
  APP_ORIGIN?: string;
  LOCAL_TEST_MODE?: string;
  LOCAL_TEST_CATALOG_OVERRIDE?: string;
  VERCEL_ENV?: string;
  VERCEL_URL?: string;
  VERCEL_BRANCH_URL?: string;
  VERCEL_PROJECT_ID?: string;
  VERCEL_PROJECT_PRODUCTION_URL?: string;
  CRON_SECRET?: string;
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
}

function requestId(): string {
  return crypto.randomUUID();
}

function normalizeOrigin(value: string, allowLocalHttp: boolean): string | null {
  try {
    const parsed = new URL(value);
    const isLocalHost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.origin !== value ||
        (parsed.protocol !== "https:" &&
          !(allowLocalHttp && parsed.protocol === "http:" && isLocalHost))) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function originFromEnvironment(environment: VercelEnvironment): string | null {
  const configuredOrigin = environment.APP_ORIGIN
    ? normalizeOrigin(environment.APP_ORIGIN, environment.VERCEL_ENV === "development")
    : null;
  const productionOrigin = environment.VERCEL_PROJECT_PRODUCTION_URL
    ? normalizeOrigin(
        /^https?:\/\//i.test(environment.VERCEL_PROJECT_PRODUCTION_URL)
          ? environment.VERCEL_PROJECT_PRODUCTION_URL
          : `https://${environment.VERCEL_PROJECT_PRODUCTION_URL}`,
        false,
      )
    : null;

  if (configuredOrigin && productionOrigin &&
      (environment.VERCEL_ENV === "production" || environment.ENVIRONMENT === "production") &&
      configuredOrigin !== productionOrigin) {
    return null;
  }
  if (configuredOrigin) return configuredOrigin;
  if (productionOrigin) return productionOrigin;
  if (environment.VERCEL_ENV === "preview" && environment.VERCEL_URL &&
      /^[A-Za-z0-9.-]+$/.test(environment.VERCEL_URL)) {
    return `https://${environment.VERCEL_URL}`;
  }
  return null;
}

function runtimeEnvironment(environment: VercelEnvironment): Env["ENVIRONMENT"] {
  if (environment.ENVIRONMENT === "staging" && environment.VERCEL_ENV === "preview") {
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
  if (environment.VERCEL_ENV === "preview") {
    return environment.ENVIRONMENT === "staging";
  }
  if (environment.ENVIRONMENT === undefined) return true;
  if (environment.ENVIRONMENT === "staging") return false;
  if (environment.ENVIRONMENT === "production") return environment.VERCEL_ENV === "production";
  if (environment.ENVIRONMENT === "local") return environment.VERCEL_ENV === "development";
  return false;
}

function validateCredentialScope(environment: VercelEnvironment): boolean {
  const previewHasProductionCredentials = environment.VERCEL_ENV === "preview" &&
    [
      environment.TURSO_DATABASE_URL,
      environment.TURSO_AUTH_TOKEN,
      environment.CLOUDINARY_CLOUD_NAME,
      environment.CLOUDINARY_API_KEY,
      environment.CLOUDINARY_API_SECRET,
    ].some((value) => value !== undefined);
  const productionHasStagingCredentials = environment.VERCEL_ENV === "production" &&
    [
      environment.TURSO_STAGING_DATABASE_URL,
      environment.TURSO_STAGING_AUTH_TOKEN,
      environment.CLOUDINARY_STAGING_CLOUD_NAME,
      environment.CLOUDINARY_STAGING_API_KEY,
      environment.CLOUDINARY_STAGING_API_SECRET,
      environment.CLOUDINARY_STAGING_ISOLATED_ACCOUNT,
    ].some((value) => value !== undefined);
  return !previewHasProductionCredentials && !productionHasStagingCredentials;
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

function stagingRuntime(environment: VercelEnvironment): boolean {
  return runtimeEnvironment(environment) === "staging";
}

function databaseCredentials(environment: VercelEnvironment): {
  url?: string;
  authToken?: string;
} {
  return stagingRuntime(environment)
    ? {
        url: environment.TURSO_STAGING_DATABASE_URL,
        authToken: environment.TURSO_STAGING_AUTH_TOKEN,
      }
    : {
        url: environment.TURSO_DATABASE_URL,
        authToken: environment.TURSO_AUTH_TOKEN,
      };
}

function validateDatabaseConfiguration(environment: VercelEnvironment): string | null {
  if (environment.DATABASE_PROVIDER !== "turso") return "DATABASE_CONFIGURATION_ERROR";
  const { url, authToken } = databaseCredentials(environment);
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
  if (protocol !== "file:" && !authToken?.trim()) {
    return "DATABASE_CONFIGURATION_ERROR";
  }
  if (protocol !== "file:" && protocol !== "libsql:" && protocol !== "https:") {
    return "DATABASE_CONFIGURATION_ERROR";
  }
  const isStagingDatabase = stagingTursoHostname.test(parsedUrl.hostname);
  if (runtimeEnvironment(environment) === "staging" &&
      (protocol === "file:" || !isStagingDatabase)) {
    return "DATABASE_CONFIGURATION_ERROR";
  }
  if (runtimeEnvironment(environment) === "production" && isStagingDatabase) {
    return "DATABASE_CONFIGURATION_ERROR";
  }
  return null;
}

function cloudinaryConfiguration(environment: VercelEnvironment): {
  cloudName?: string;
  apiKey?: string;
  apiSecret?: string;
} {
  return stagingRuntime(environment)
    ? {
        cloudName: environment.CLOUDINARY_STAGING_CLOUD_NAME,
        apiKey: environment.CLOUDINARY_STAGING_API_KEY,
        apiSecret: environment.CLOUDINARY_STAGING_API_SECRET,
      }
    : {
        cloudName: environment.CLOUDINARY_CLOUD_NAME,
        apiKey: environment.CLOUDINARY_API_KEY,
        apiSecret: environment.CLOUDINARY_API_SECRET,
      };
}

function localMockPaymentEnabled(environment: VercelEnvironment): boolean {
  if (environment.PAYMENT_MODE !== "mock" ||
      environment.LOCAL_TEST_MODE !== "true" ||
      environment.ENVIRONMENT !== "local" ||
      environment.VERCEL_ENV !== "development" ||
      environment.DATABASE_PROVIDER !== "turso" ||
      environment.STORAGE_PROVIDER !== "mock") {
    return false;
  }
  try {
    const databaseUrl = new URL(environment.TURSO_DATABASE_URL ?? "");
    return databaseUrl.protocol === "file:" &&
      !databaseUrl.host &&
      !databaseUrl.username &&
      !databaseUrl.password &&
      !databaseUrl.search &&
      !databaseUrl.hash;
  } catch {
    return false;
  }
}

function runtimePaymentMode(environment: VercelEnvironment): Env["PAYMENT_MODE"] {
  if (environment.VERCEL_ENV !== "development" ||
      environment.LOCAL_TEST_MODE !== "true") {
    return undefined;
  }
  if (environment.PAYMENT_MODE === "sepay-test") return "sepay-test";
  return localMockPaymentEnabled(environment) ? "mock" : undefined;
}

function createStorage(
  environment: VercelEnvironment,
  dependencies: VercelRuntimeDependencies,
): Storage {
  if (environment.STORAGE_PROVIDER === "cloudinary") {
    const { cloudName, apiKey, apiSecret } = cloudinaryConfiguration(environment);
    if (!cloudName || !apiKey || !apiSecret ||
        (stagingRuntime(environment) &&
          (cloudName === previouslyAssumedCloudinaryTestCloud ||
           environment.CLOUDINARY_STAGING_ISOLATED_ACCOUNT !== stagingCloudinaryConfirmation))) {
      throw new TypeError("Cloudinary configuration is incomplete");
    }
    return dependencies.createCloudinaryStorage
      ? dependencies.createCloudinaryStorage(environment)
      : new CloudinaryStorageAdapter({ cloudName, apiKey, apiSecret });
  }
  if (environment.STORAGE_PROVIDER === "mock" &&
      ((environment.LOCAL_TEST_MODE === "true" &&
        environment.VERCEL_ENV === "development") ||
       (stagingRuntime(environment) && environment.VERCEL_ENV === "preview"))) {
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

  const connectDatabase = dependencies.connectDatabase ?? (async (config: VercelEnvironment) => {
    const { url, authToken } = databaseCredentials(config);
    return connectDatabaseFromEnvironment({
      ...config,
      TURSO_DATABASE_URL: url,
      TURSO_AUTH_TOKEN: authToken,
    });
  });

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
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
      if (environment.ENVIRONMENT !== "staging" || environment.VERCEL_ENV !== "preview") {
        return apiError(requestId(), 404, "NOT_FOUND", "Route not found");
      }
      if (!validateCredentialScope(environment)) {
        return apiError(requestId(), 500, "RUNTIME_CONFIGURATION_ERROR", "Credentials do not match the Vercel deployment environment");
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
    if (!validateCredentialScope(environment)) {
      return apiError(requestId(), 500, "RUNTIME_CONFIGURATION_ERROR", "Credentials do not match the Vercel deployment environment");
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
    const { cloudName, apiKey, apiSecret } = cloudinaryConfiguration(environment);
    const appEnv: Env = {
      DB: connection.database,
      STORAGE: storage,
      DATABASE_PROVIDER: "turso",
      STORAGE_PROVIDER: environment.STORAGE_PROVIDER === "cloudinary" ? "cloudinary" : undefined,
      CLOUDINARY_CLOUD_NAME: cloudName,
      CLOUDINARY_API_KEY: apiKey,
      CLOUDINARY_API_SECRET: apiSecret,
      ENVIRONMENT: appEnvironment,
      MAIL_PROVIDER: environment.VERCEL_ENV === "production" &&
          environment.MAIL_PROVIDER === "resend" ? "resend" : undefined,
      MAIL_API_KEY: environment.VERCEL_ENV === "production" ? environment.MAIL_API_KEY : undefined,
      MAIL_FROM_EMAIL: environment.VERCEL_ENV === "production" ? environment.MAIL_FROM_EMAIL : undefined,
      APP_ORIGIN: appOrigin,
      LOCAL_TEST_MODE: environment.LOCAL_TEST_MODE === "true" &&
          environment.VERCEL_ENV === "development" && appEnvironment === "local"
        ? "true"
        : undefined,
      LOCAL_TEST_CATALOG_OVERRIDE: environment.LOCAL_TEST_CATALOG_OVERRIDE === "true" &&
          environment.LOCAL_TEST_MODE === "true" &&
          environment.VERCEL_ENV === "development" && appEnvironment === "local"
        ? "true"
        : undefined,
      PAYMENT_MODE: runtimePaymentMode(environment),
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

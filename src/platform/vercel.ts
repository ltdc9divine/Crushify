import { apiError } from "../http.ts";
import { handleApiRequest } from "../index.ts";
import { connectDatabaseFromEnvironment } from "../database/provider.ts";
import type { Database } from "../database.ts";
import type { Storage } from "../storage.ts";
import { CloudinaryStorageAdapter } from "../storage/cloudinary.ts";
import {
  CloudinaryConfigurationError,
  resolveCloudinaryConfiguration,
} from "../storage/cloudinary-policy.ts";
import { MemoryStorageAdapter } from "../storage/mock.ts";
import { runScheduledPublicationLifecycle } from "../scheduler.ts";
import { logSafeError } from "../logging.ts";
import { resolvePaymentEnvironmentPolicy } from "../payments/policy.ts";
import type { Env } from "../types.ts";
import {
  classifyVercelEnvironment,
  isLoopbackOrigin,
  normalizeEnvironmentOrigin,
  vercelHostOrigin,
  type DeploymentEnvironment,
} from "./environment.ts";

export const VERCEL_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
const allowedMethods = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const allowedHeaders = new Set(["authorization", "content-type", "idempotency-key", "x-csrf-token"]);
const stagingTursoHostname = /^crushify-staging(?:-[a-z0-9-]+)?\.turso\.io$/i;

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
  CLOUDINARY_PRODUCTION_CLOUD_NAME?: string;
  MAIL_PROVIDER?: string;
  MAIL_API_KEY?: string;
  MAIL_FROM_EMAIL?: string;
  PREVIEW_EMAIL_SINK?: string;
  LOCAL_TEST_MAIL_SINK_URL?: string;
  APP_ORIGIN?: string;
  LOCAL_TEST_MODE?: string;
  LOCAL_TEST_CATALOG_OVERRIDE?: string;
  LOCAL_TEST_PRICING_POLICY?: string;
  VERCEL_ENV?: string;
  VERCEL_URL?: string;
  VERCEL_BRANCH_URL?: string;
  VERCEL_PROJECT_ID?: string;
  VERCEL_PROJECT_PRODUCTION_URL?: string;
  CRON_SECRET?: string;
  STAGING_LIFECYCLE_SECRET?: string;
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
  localTestEmailSink?: (message: import("../auth.ts").EmailMessage) => Promise<void>;
}

function requestId(): string {
  return crypto.randomUUID();
}

export function resolveVercelOrigin(
  environment: VercelEnvironment,
  requestOrigin?: string,
): string | null {
  const runtime = classifyVercelEnvironment(environment.VERCEL_ENV, environment.ENVIRONMENT);
  if (!runtime) return null;

  const configuredOrigin = environment.APP_ORIGIN === undefined
    ? undefined
    : normalizeEnvironmentOrigin(environment.APP_ORIGIN, runtime);
  if (environment.APP_ORIGIN !== undefined && !configuredOrigin) return null;

  if (runtime === "local") {
    if (configuredOrigin) return configuredOrigin;
    if (!requestOrigin) return null;
    const localRequestOrigin = normalizeEnvironmentOrigin(requestOrigin, "local");
    return localRequestOrigin && isLoopbackOrigin(localRequestOrigin)
      ? localRequestOrigin
      : null;
  }

  const productionOrigin = environment.VERCEL_PROJECT_PRODUCTION_URL === undefined
    ? undefined
    : vercelHostOrigin(environment.VERCEL_PROJECT_PRODUCTION_URL);
  if (environment.VERCEL_PROJECT_PRODUCTION_URL !== undefined && !productionOrigin) return null;

  if (runtime === "staging") {
    const deploymentOrigin = vercelHostOrigin(environment.VERCEL_URL);
    if (!deploymentOrigin || deploymentOrigin === productionOrigin ||
        (configuredOrigin && configuredOrigin !== deploymentOrigin)) {
      return null;
    }
    return deploymentOrigin;
  }

  if (configuredOrigin && productionOrigin && configuredOrigin !== productionOrigin) return null;
  return configuredOrigin ?? productionOrigin ?? null;
}

function originFromEnvironment(environment: VercelEnvironment, request: Request): string | null {
  let requestOrigin: string | undefined;
  try {
    requestOrigin = new URL(request.url).origin;
  } catch {
    return null;
  }
  return resolveVercelOrigin(environment, requestOrigin);
}

function runtimeEnvironment(environment: VercelEnvironment): DeploymentEnvironment {
  const runtime = classifyVercelEnvironment(environment.VERCEL_ENV, environment.ENVIRONMENT);
  if (!runtime) throw new TypeError("Vercel deployment environment is not explicitly classified");
  return runtime;
}

function validateCredentialScope(environment: VercelEnvironment): boolean {
  const hasLocalOnlyConfiguration = [
    environment.LOCAL_TEST_MODE,
    environment.LOCAL_TEST_CATALOG_OVERRIDE,
    environment.LOCAL_TEST_PRICING_POLICY,
    environment.LOCAL_TEST_MAIL_SINK_URL,
    environment.PAYMENT_MODE,
    environment.SEPAY_WEBHOOK_SECRET,
    environment.SEPAY_BANK_CODE,
    environment.SEPAY_BANK_ACCOUNT,
    environment.SEPAY_ACCOUNT_NAME,
  ].some((value) => value !== undefined);
  const previewHasProductionCredentials = environment.VERCEL_ENV === "preview" &&
    [
      environment.TURSO_DATABASE_URL,
      environment.TURSO_AUTH_TOKEN,
      environment.CLOUDINARY_CLOUD_NAME,
      environment.CLOUDINARY_API_KEY,
      environment.CLOUDINARY_API_SECRET,
      environment.MAIL_PROVIDER,
      environment.MAIL_API_KEY,
      environment.MAIL_FROM_EMAIL,
      environment.PAYMENT_MODE,
      environment.SEPAY_WEBHOOK_SECRET,
      environment.SEPAY_BANK_CODE,
      environment.SEPAY_BANK_ACCOUNT,
      environment.SEPAY_ACCOUNT_NAME,
      environment.LOCAL_TEST_MODE,
      environment.LOCAL_TEST_CATALOG_OVERRIDE,
      environment.LOCAL_TEST_PRICING_POLICY,
      environment.LOCAL_TEST_MAIL_SINK_URL,
    ].some((value) => value !== undefined);
  const productionHasStagingCredentials = environment.VERCEL_ENV === "production" &&
    [
      environment.TURSO_STAGING_DATABASE_URL,
      environment.TURSO_STAGING_AUTH_TOKEN,
      environment.CLOUDINARY_STAGING_CLOUD_NAME,
      environment.CLOUDINARY_STAGING_API_KEY,
      environment.CLOUDINARY_STAGING_API_SECRET,
      environment.PREVIEW_EMAIL_SINK,
      environment.LOCAL_TEST_MAIL_SINK_URL,
      environment.LOCAL_TEST_MODE,
      environment.LOCAL_TEST_CATALOG_OVERRIDE,
      environment.LOCAL_TEST_PRICING_POLICY,
      environment.PAYMENT_MODE,
      environment.SEPAY_WEBHOOK_SECRET,
      environment.SEPAY_BANK_CODE,
      environment.SEPAY_BANK_ACCOUNT,
      environment.SEPAY_ACCOUNT_NAME,
    ].some((value) => value !== undefined);
  const localHasRemoteCredentials = environment.VERCEL_ENV === "development" &&
    [
      environment.TURSO_STAGING_DATABASE_URL,
      environment.TURSO_STAGING_AUTH_TOKEN,
      environment.CLOUDINARY_CLOUD_NAME,
      environment.CLOUDINARY_API_KEY,
      environment.CLOUDINARY_API_SECRET,
      environment.CLOUDINARY_STAGING_CLOUD_NAME,
      environment.CLOUDINARY_STAGING_API_KEY,
      environment.CLOUDINARY_STAGING_API_SECRET,
      environment.CLOUDINARY_PRODUCTION_CLOUD_NAME,
      environment.MAIL_PROVIDER,
      environment.MAIL_API_KEY,
      environment.MAIL_FROM_EMAIL,
      environment.PREVIEW_EMAIL_SINK,
    ].some((value) => value !== undefined) ||
    (environment.VERCEL_ENV === "development" && environment.STORAGE_PROVIDER === "cloudinary");
  const localFlagsOutsideDevelopment = environment.VERCEL_ENV !== "development" &&
    hasLocalOnlyConfiguration;
  return !previewHasProductionCredentials &&
    !productionHasStagingCredentials &&
    !localHasRemoteCredentials &&
    !localFlagsOutsideDevelopment;
}

export function validateVercelEnvironment(environment: VercelEnvironment): string | null {
  const runtime = classifyVercelEnvironment(environment.VERCEL_ENV, environment.ENVIRONMENT);
  if (!runtime || !validateCredentialScope(environment)) {
    return "RUNTIME_CONFIGURATION_ERROR";
  }
  if (environment.APP_ORIGIN !== undefined &&
      !normalizeEnvironmentOrigin(environment.APP_ORIGIN, runtime)) {
    return "RUNTIME_CONFIGURATION_ERROR";
  }
  if (runtime === "staging" || runtime === "production") {
    if (!resolveVercelOrigin(environment)) return "RUNTIME_CONFIGURATION_ERROR";
  }
  if (runtime === "staging") {
    if (environment.PREVIEW_EMAIL_SINK !== undefined &&
        environment.PREVIEW_EMAIL_SINK !== "discard") {
      return "RUNTIME_CONFIGURATION_ERROR";
    }
    if (environment.STORAGE_PROVIDER === "cloudinary" ||
        environment.CLOUDINARY_STAGING_CLOUD_NAME !== undefined ||
        environment.CLOUDINARY_STAGING_API_KEY !== undefined ||
        environment.CLOUDINARY_STAGING_API_SECRET !== undefined) {
      return "STORAGE_ISOLATION_ERROR";
    }
  }
  return null;
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
  if (!url || url.trim() !== url) return "DATABASE_CONFIGURATION_ERROR";
  let protocol: string;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
    protocol = parsedUrl.protocol;
  } catch {
    return "DATABASE_CONFIGURATION_ERROR";
  }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash ||
      parsedUrl.port || (parsedUrl.protocol !== "file:" &&
        parsedUrl.pathname && parsedUrl.pathname !== "/") ||
      (parsedUrl.protocol === "file:" && parsedUrl.hostname)) {
    return "DATABASE_CONFIGURATION_ERROR";
  }
  const runtime = runtimeEnvironment(environment);
  if ((runtime === "local" && protocol !== "file:") ||
      (runtime !== "local" && protocol === "file:")) {
    return "DATABASE_CONFIGURATION_ERROR";
  }
  if (runtime === "local" && authToken?.trim()) return "DATABASE_CONFIGURATION_ERROR";
  if (protocol !== "file:" && !authToken?.trim()) {
    return "DATABASE_CONFIGURATION_ERROR";
  }
  if (protocol !== "file:" && protocol !== "libsql:" && protocol !== "https:") {
    return "DATABASE_CONFIGURATION_ERROR";
  }
  const isStagingDatabase = stagingTursoHostname.test(parsedUrl.hostname);
  if (runtime === "staging" &&
      (protocol === "file:" || !isStagingDatabase)) {
    return "DATABASE_CONFIGURATION_ERROR";
  }
  if (runtime === "production" && isStagingDatabase) {
    return "DATABASE_CONFIGURATION_ERROR";
  }
  return null;
}

export function resolveVercelDatabaseConfiguration(
  environment: VercelEnvironment,
): {
  DATABASE_PROVIDER: "turso";
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN?: string;
} | null {
  if (validateVercelEnvironment(environment) ||
      validateDatabaseConfiguration(environment)) {
    return null;
  }
  const { url, authToken } = databaseCredentials(environment);
  if (!url) return null;
  return {
    DATABASE_PROVIDER: "turso",
    TURSO_DATABASE_URL: url,
    TURSO_AUTH_TOKEN: authToken,
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
  const runtime = runtimeEnvironment(environment);
  const policy = resolvePaymentEnvironmentPolicy({
    ENVIRONMENT: runtime,
    LOCAL_TEST_MODE: environment.LOCAL_TEST_MODE === "true" &&
        environment.VERCEL_ENV === "development"
      ? "true"
      : undefined,
    PAYMENT_MODE: environment.PAYMENT_MODE === "mock" ||
        environment.PAYMENT_MODE === "sepay-test"
      ? environment.PAYMENT_MODE
      : undefined,
  });
  if (runtime === "local" && policy.mode === "mock" &&
      !localMockPaymentEnabled(environment)) {
    return undefined;
  }
  return policy.mode ?? undefined;
}

function createStorage(
  environment: VercelEnvironment,
  dependencies: VercelRuntimeDependencies,
): Storage | undefined {
  if (stagingRuntime(environment)) return undefined;
  if (environment.STORAGE_PROVIDER === "cloudinary") {
    if (runtimeEnvironment(environment) !== "production") {
      throw new TypeError("Cloudinary is not configured for this runtime");
    }
    const config = resolveCloudinaryConfiguration({
      ...environment,
      ENVIRONMENT: runtimeEnvironment(environment),
    });
    return dependencies.createCloudinaryStorage
      ? dependencies.createCloudinaryStorage(environment)
      : new CloudinaryStorageAdapter(config);
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

function secureStagingLifecycleSecretMatch(
  provided: string | null,
  expected: string | undefined,
): boolean {
  const strongHexSecret = /^[\da-f]{64}$/i;
  if (!provided || !expected ||
      !strongHexSecret.test(provided) || !strongHexSecret.test(expected)) {
    return false;
  }
  return secureSecretMatch(provided, expected);
}

export function createVercelApiHandler(
  environment: VercelEnvironment,
  dependencies: VercelRuntimeDependencies = {},
): (request: Request) => Promise<Response> {
  let databasePromise: Promise<DatabaseConnection> | undefined;
  let storage: Storage | undefined;

  const connectDatabase = dependencies.connectDatabase ?? (async (config: VercelEnvironment) => {
    const databaseConfiguration = resolveVercelDatabaseConfiguration(config);
    if (!databaseConfiguration) {
      throw new TypeError("Database provider is not configured for this runtime");
    }
    return connectDatabaseFromEnvironment(databaseConfiguration);
  });

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/api/ops/staging/publication-lifecycle") {
      const requestIdValue = requestId();
      if (classifyVercelEnvironment(environment.VERCEL_ENV, environment.ENVIRONMENT) !== "staging") {
        return apiError(requestIdValue, 404, "NOT_FOUND", "Route not found");
      }
      if (request.method !== "POST") {
        return apiError(requestIdValue, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
      }
      if (!secureStagingLifecycleSecretMatch(
        request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1] ?? null,
        environment.STAGING_LIFECYCLE_SECRET,
      )) {
        return apiError(requestIdValue, 401, "UNAUTHENTICATED", "Operator request is not authorized");
      }
      if (url.search || request.body !== null) {
        return apiError(requestIdValue, 400, "INVALID_REQUEST", "Lifecycle trigger does not accept parameters");
      }
      const scopeError = validateVercelEnvironment(environment);
      if (scopeError) {
        return apiError(requestIdValue, 500, scopeError, "Runtime configuration does not match the Vercel deployment environment");
      }
      const databaseError = validateDatabaseConfiguration(environment);
      if (databaseError) {
        return apiError(requestIdValue, 500, databaseError, "Database provider is not configured for this runtime");
      }
      try {
        storage ??= createStorage(environment, dependencies);
      } catch (error) {
        if (error instanceof CloudinaryConfigurationError) {
          return apiError(requestIdValue, 500, error.code, error.message);
        }
        return apiError(requestIdValue, 500, "STORAGE_CONFIGURATION_ERROR", "Storage provider is not configured for this runtime");
      }
      if (!storage) {
        return apiError(
          requestIdValue,
          503,
          "STORAGE_UNAVAILABLE",
          "Durable media storage is unavailable for this runtime",
        );
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
        }, { limit: 10 });
        return Response.json(result, {
          status: result.acquired ? 200 : 202,
          headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
        });
      } catch (error) {
        logSafeError("vercel.preview_lifecycle_failed", "lifecycle", error, {
          environment: "staging",
        });
        return apiError(requestIdValue, 503, "DEPENDENCY_UNAVAILABLE", "Staging maintenance could not complete");
      }
    }

    if (url.pathname === "/api/cron/publication-lifecycle") {
      if (request.method !== "GET") {
        return apiError(requestId(), 405, "METHOD_NOT_ALLOWED", "Method not allowed");
      }
      if (!secureSecretMatch(
        request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1] ?? null,
        environment.CRON_SECRET,
      )) {
        return apiError(requestId(), 401, "UNAUTHENTICATED", "Scheduled request is not authorized");
      }
      const runtime = classifyVercelEnvironment(environment.VERCEL_ENV, environment.ENVIRONMENT);
      const production = runtime === "production";
      if (!production) {
        return apiError(requestId(), 404, "NOT_FOUND", "Route not found");
      }
      const scopeError = validateVercelEnvironment(environment);
      if (scopeError) {
        return apiError(requestId(), 500, scopeError, "Runtime configuration does not match the Vercel deployment environment");
      }
      const databaseError = validateDatabaseConfiguration(environment);
      if (databaseError) {
        return apiError(requestId(), 500, databaseError, "Database provider is not configured for this runtime");
      }
      try {
        storage ??= createStorage(environment, dependencies);
      } catch (error) {
        if (error instanceof CloudinaryConfigurationError) {
          return apiError(requestId(), 500, error.code, error.message);
        }
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
          ENVIRONMENT: production ? "production" : "staging",
          DATA_RETENTION_DAYS: environment.DATA_RETENTION_DAYS,
        });
        return Response.json(result, {
          status: result.acquired ? 200 : 202,
          headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
        });
      } catch (error) {
        logSafeError("vercel.scheduled_lifecycle_failed", "lifecycle", error, {
          environment: production ? "production" : "staging",
        });
        return apiError(requestId(), 503, "DEPENDENCY_UNAVAILABLE", "Scheduled maintenance could not complete");
      }
    }

    const scopeError = validateVercelEnvironment(environment);
    if (scopeError) {
      return apiError(requestId(), 500, scopeError, "Application environment or credentials do not match the Vercel deployment");
    }

    const origin = originFromEnvironment(environment, request);
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

    if (!origin) {
      return apiError(requestId(), 500, "RUNTIME_CONFIGURATION_ERROR", "Application origin is not configured for this runtime");
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
    } catch (error) {
      if (error instanceof CloudinaryConfigurationError) {
        return withCors(
          apiError(requestId(), 500, error.code, error.message),
          request,
          origin,
        );
      }
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

    const appEnvironment = runtimeEnvironment(environment);
    let connection: DatabaseConnection;
    try {
      connection = await databasePromise;
    } catch (error) {
      logSafeError("vercel.database_initialization_failed", "database", error, {
        environment: appEnvironment,
      });
      return withCors(
        apiError(requestId(), 503, "DEPENDENCY_UNAVAILABLE", "Service unavailable"),
        request,
        origin,
      );
    }

    const appOrigin = origin ?? undefined;
    const cloudinary = environment.STORAGE_PROVIDER === "cloudinary"
      ? resolveCloudinaryConfiguration({
          ...environment,
          ENVIRONMENT: appEnvironment,
        })
      : undefined;
    const appEnv: Env = {
      DB: connection.database,
      STORAGE: storage,
      DATABASE_PROVIDER: "turso",
      STORAGE_PROVIDER: environment.STORAGE_PROVIDER === "cloudinary" ? "cloudinary" : undefined,
      CLOUDINARY_CLOUD_NAME: cloudinary?.cloudName,
      CLOUDINARY_API_KEY: cloudinary?.apiKey,
      CLOUDINARY_API_SECRET: cloudinary?.apiSecret,
      ENVIRONMENT: appEnvironment,
      MAIL_PROVIDER: environment.VERCEL_ENV === "production" &&
          environment.MAIL_PROVIDER === "resend" ? "resend" : undefined,
      MAIL_API_KEY: environment.VERCEL_ENV === "production" ? environment.MAIL_API_KEY : undefined,
      MAIL_FROM_EMAIL: environment.VERCEL_ENV === "production" ? environment.MAIL_FROM_EMAIL : undefined,
      PREVIEW_EMAIL_SINK: environment.VERCEL_ENV === "preview" &&
          environment.PREVIEW_EMAIL_SINK === "discard" ? "discard" : undefined,
      LOCAL_TEST_EMAIL_SINK: environment.VERCEL_ENV === "development" &&
          environment.LOCAL_TEST_MODE === "true" && appEnvironment === "local"
        ? dependencies.localTestEmailSink
        : undefined,
      LOCAL_TEST_MAIL_SINK_URL: environment.VERCEL_ENV === "development" &&
          environment.LOCAL_TEST_MODE === "true" && appEnvironment === "local"
        ? environment.LOCAL_TEST_MAIL_SINK_URL
        : undefined,
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

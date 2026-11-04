import { apiError } from "../http.ts";
import { handleApiRequest } from "../index.ts";
import { connectDatabaseFromEnvironment } from "../database/provider.ts";
import type { Database } from "../database.ts";
import type { Storage } from "../storage.ts";
import { CloudinaryStorageAdapter } from "../storage/cloudinary.ts";
import { MemoryStorageAdapter } from "../storage/mock.ts";
import type { Env } from "../types.ts";

export const VERCEL_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
const allowedMethods = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const allowedHeaders = new Set(["authorization", "content-type", "x-csrf-token"]);

export interface VercelEnvironment {
  DATABASE_PROVIDER?: string;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
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
  if (environment.VERCEL_ENV === "production") return "production";
  if (environment.VERCEL_ENV === "preview") return "staging";
  return "local";
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
  try {
    protocol = new URL(url).protocol;
  } catch {
    return "DATABASE_CONFIGURATION_ERROR";
  }
  if (protocol === "file:" && environment.VERCEL_ENV !== "development") {
    return "DATABASE_CONFIGURATION_ERROR";
  }
  if (protocol !== "file:" && !environment.TURSO_AUTH_TOKEN) {
    return "DATABASE_CONFIGURATION_ERROR";
  }
  if (protocol !== "file:" && protocol !== "libsql:" && protocol !== "https:") {
    return "DATABASE_CONFIGURATION_ERROR";
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
    if (!cloudName || !apiKey || !apiSecret) {
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
      UPLOAD_MAX_BYTES: VERCEL_UPLOAD_MAX_BYTES,
    };

    return withCors(await handleApiRequest(request, appEnv), request, origin);
  };
}

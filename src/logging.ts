export type LogCategory =
  | "api"
  | "auth"
  | "database"
  | "email"
  | "lifecycle"
  | "payment"
  | "storage";

export interface SafeLogContext {
  request_id?: string;
  environment?: "local" | "staging" | "production";
  counts?: {
    expired?: number;
    erased?: number;
    retryable?: number;
    completed?: number;
  };
}

const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeErrorNames = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "StorageError",
  "StagingConfigurationError",
]);
const safeCategories = new Set<LogCategory>([
  "api",
  "auth",
  "database",
  "email",
  "lifecycle",
  "payment",
  "storage",
]);
const safeCountKeys = ["expired", "erased", "retryable", "completed"] as const;
const eventPattern = /^[a-z][a-z0-9._-]{0,80}$/;

function errorType(error: unknown): string {
  if (!(error instanceof Error) || !safeErrorNames.has(error.name)) return "UnknownError";
  return error.name;
}

function safeEvent(event: string): string {
  return eventPattern.test(event) ? event : "invalid.event";
}

function safeCategory(category: LogCategory): LogCategory {
  return safeCategories.has(category) ? category : "api";
}

function safeEnvironment(environment: SafeLogContext["environment"]): SafeLogContext["environment"] {
  return environment === "local" || environment === "staging" || environment === "production"
    ? environment
    : undefined;
}

function safeCounts(counts: SafeLogContext["counts"]): SafeLogContext["counts"] | undefined {
  if (!counts) return undefined;
  const entries = safeCountKeys.flatMap((key) => {
    const value = counts[key];
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? [[key, value] as const]
      : [];
  });
  return entries.length ? Object.fromEntries(entries) as SafeLogContext["counts"] : undefined;
}

export function logSafeError(
  event: string,
  category: LogCategory,
  error: unknown,
  context: SafeLogContext = {},
): void {
  const record = {
    event: safeEvent(event),
    category: safeCategory(category),
    error_type: errorType(error),
    ...(context.request_id && requestIdPattern.test(context.request_id)
      ? { request_id: context.request_id }
      : {}),
    ...(safeEnvironment(context.environment)
      ? { environment: safeEnvironment(context.environment) }
      : {}),
    ...(safeCounts(context.counts) ? { counts: safeCounts(context.counts) } : {}),
    timestamp: new Date().toISOString(),
  };
  console.error(JSON.stringify(record));
}

export function logSafeInfo(
  event: string,
  category: LogCategory,
  context: SafeLogContext = {},
): void {
  const record = {
    event: safeEvent(event),
    category: safeCategory(category),
    ...(context.request_id && requestIdPattern.test(context.request_id)
      ? { request_id: context.request_id }
      : {}),
    ...(safeEnvironment(context.environment)
      ? { environment: safeEnvironment(context.environment) }
      : {}),
    ...(safeCounts(context.counts) ? { counts: safeCounts(context.counts) } : {}),
    timestamp: new Date().toISOString(),
  };
  console.info(JSON.stringify(record));
}

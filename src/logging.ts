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
  operation_id?: string;
  recovery_outcome?: "provider_object_confirmed" | "provider_object_absent_inconclusive" | "recheck_failed";
  environment?: "local" | "staging" | "production";
  counts?: {
    expired?: number;
    erased?: number;
    retryable?: number;
    completed?: number;
    manual_review?: number;
    upload_cleanup_processed?: number;
    upload_cleanup_cleaned?: number;
    upload_cleanup_retryable?: number;
    upload_cleanup_manual_review?: number;
    derivative_cleanup_processed?: number;
    derivative_cleanup_cleaned?: number;
    derivative_cleanup_pending?: number;
    derivative_cleanup_deferred?: number;
    derivative_cleanup_failed?: number;
    derivative_cleanup_retryable?: number;
    derivative_cleanup_manual_review?: number;
    derivative_cleanup_has_more?: number;
    sepay_scan_pages?: number;
    sepay_scan_observations?: number;
    sepay_scan_failures?: number;
    sepay_scan_lease_held?: number;
    sepay_scan_partial?: number;
  };
}

const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const operationIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
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
const safeCountKeys = [
  "expired", "erased", "retryable", "completed", "manual_review",
  "upload_cleanup_processed", "upload_cleanup_cleaned", "upload_cleanup_retryable",
  "upload_cleanup_manual_review",
  "derivative_cleanup_processed", "derivative_cleanup_cleaned",
  "derivative_cleanup_pending", "derivative_cleanup_deferred",
  "derivative_cleanup_failed", "derivative_cleanup_retryable",
  "derivative_cleanup_manual_review", "derivative_cleanup_has_more",
  "sepay_scan_pages", "sepay_scan_observations", "sepay_scan_failures",
  "sepay_scan_lease_held", "sepay_scan_partial",
] as const;
const eventPattern = /^[a-z][a-z0-9._-]{0,80}$/;
const safeRecoveryOutcomes = new Set<NonNullable<SafeLogContext["recovery_outcome"]>>([
  "provider_object_confirmed",
  "provider_object_absent_inconclusive",
  "recheck_failed",
]);

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

function safeOperationId(operationId: string | undefined): string | undefined {
  return operationId && operationIdPattern.test(operationId) ? operationId : undefined;
}

function safeRecoveryOutcome(
  outcome: SafeLogContext["recovery_outcome"],
): SafeLogContext["recovery_outcome"] {
  return outcome && safeRecoveryOutcomes.has(outcome) ? outcome : undefined;
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
    ...(safeOperationId(context.operation_id)
      ? { operation_id: safeOperationId(context.operation_id) }
      : {}),
    ...(safeRecoveryOutcome(context.recovery_outcome)
      ? { recovery_outcome: safeRecoveryOutcome(context.recovery_outcome) }
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
    ...(safeOperationId(context.operation_id)
      ? { operation_id: safeOperationId(context.operation_id) }
      : {}),
    ...(safeRecoveryOutcome(context.recovery_outcome)
      ? { recovery_outcome: safeRecoveryOutcome(context.recovery_outcome) }
      : {}),
    ...(safeEnvironment(context.environment)
      ? { environment: safeEnvironment(context.environment) }
      : {}),
    ...(safeCounts(context.counts) ? { counts: safeCounts(context.counts) } : {}),
    timestamp: new Date().toISOString(),
  };
  console.info(JSON.stringify(record));
}

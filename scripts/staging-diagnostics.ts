export const stagingOperationStages = [
  "validate-mode",
  "resolve-target",
  "load-migrations",
  "validate-migration-sequence",
  "create-client",
  "read-migration-ledger",
  "read-unmanaged-tables",
  "validate-unmanaged-tables",
  "read-migration-records",
  "validate-migration-ledger",
  "check-foreign-keys",
  "validate-foreign-keys",
  "build-expected-schema",
  "read-schema",
  "validate-schema",
  "report-preflight",
  "apply-migrations",
  "close-client",
  "report-migration-result",
] as const;

export type StagingOperationStage = typeof stagingOperationStages[number];

const safeErrorNames = new Set([
  "AbortError",
  "AggregateError",
  "ClientError",
  "ClosedError",
  "DOMException",
  "Error",
  "HttpServerError",
  "InternalError",
  "LibsqlBatchError",
  "LibsqlError",
  "ProtocolVersionError",
  "RangeError",
  "ReferenceError",
  "ResponseError",
  "StagingConfigurationError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "WebSocketError",
]);

const safeErrorCodes = new Set([
  "AUTHENTICATION_ERROR",
  "AUTHENTICATION_FAILED",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "ERR_HTTP_INVALID_HEADER_VALUE",
  "ERR_INVALID_CHAR",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "HRANA_CLOSED_ERROR",
  "HRANA_PROTO_ERROR",
  "HRANA_WEBSOCKET_ERROR",
  "INTERNAL_ERROR",
  "PERMISSION_DENIED",
  "PROTOCOL_VERSION_ERROR",
  "SERVER_ERROR",
  "SQLITE_BUSY",
  "SQLITE_CONSTRAINT",
  "SQLITE_ERROR",
  "SQLITE_LOCKED",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNKNOWN",
  "URL_INVALID",
  "URL_PARAM_NOT_SUPPORTED",
  "URL_SCHEME_NOT_SUPPORTED",
]);

export interface StagingOperationDiagnostic {
  stage: StagingOperationStage;
  error_name: string;
  error_code?: string;
  cause_chain: Array<{ name: string; code?: string }>;
}

export class StagingOperationTrace {
  private currentStage: StagingOperationStage = "validate-mode";

  get stage(): StagingOperationStage {
    return this.currentStage;
  }

  setStage(stage: StagingOperationStage): void {
    this.currentStage = stage;
  }

  async run<T>(
    stage: StagingOperationStage,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    this.setStage(stage);
    return await operation();
  }
}

function safeName(value: unknown): string {
  if (!(value instanceof Error)) return "UnknownError";
  try {
    return safeErrorNames.has(value.name) ? value.name : "UnknownError";
  } catch {
    return "UnknownError";
  }
}

function safeCode(value: unknown): string | undefined {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return undefined;
  }
  try {
    const code = (value as { code?: unknown }).code;
    return typeof code === "string" && safeErrorCodes.has(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

function errorCause(value: object): unknown {
  try {
    return (value as { cause?: unknown }).cause;
  } catch {
    return undefined;
  }
}

export function createStagingOperationDiagnostic(
  stage: StagingOperationStage,
  error: unknown,
): StagingOperationDiagnostic {
  const seen = new Set<object>();
  const chain: Array<{ name: string; code?: string }> = [];
  let current = error;

  while (typeof current === "object" && current !== null && chain.length < 4 &&
      !seen.has(current)) {
    seen.add(current);
    const code = safeCode(current);
    chain.push({
      name: safeName(current),
      ...(code ? { code } : {}),
    });
    current = errorCause(current);
  }

  const [root, ...causeChain] = chain;
  return {
    stage,
    error_name: root?.name ?? "UnknownError",
    ...(root?.code ? { error_code: root.code } : {}),
    cause_chain: causeChain,
  };
}

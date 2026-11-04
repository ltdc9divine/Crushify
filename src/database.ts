export type DatabaseValue = string | number | bigint | boolean | Date | null | ArrayBuffer | Uint8Array;

export type DatabaseErrorCode = "CONSTRAINT" | "BUSY" | "UNAVAILABLE";

export class DatabaseError extends Error {
  readonly code: DatabaseErrorCode;
  readonly driverCode?: string;

  constructor(
    code: DatabaseErrorCode,
    message: string,
    driverCode?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DatabaseError";
    this.code = code;
    this.driverCode = driverCode;
  }
}

export function normalizeDatabaseValues(values: readonly unknown[]): DatabaseValue[] {
  return values.map((value) => {
    if (value === undefined) {
      throw new TypeError("Database parameters cannot be undefined; use null for SQL NULL");
    }
    if (typeof value === "boolean") return value ? 1 : 0;
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) throw new TypeError("Invalid Date database parameter");
      return value.toISOString();
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("Database number parameters must be finite");
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" ||
        value === null || value instanceof ArrayBuffer || value instanceof Uint8Array) {
      return value;
    }
    throw new TypeError(`Unsupported database parameter type: ${typeof value}`);
  });
}

export function mapDatabaseError(error: unknown): unknown {
  if (error instanceof DatabaseError || !(error instanceof Error)) return error;
  const driverCode = "code" in error && typeof error.code === "string" ? error.code : undefined;
  const message = error.message;
  if (driverCode?.startsWith("SQLITE_CONSTRAINT") ||
      /\b(?:UNIQUE|FOREIGN KEY|CHECK|NOT NULL|PRIMARY KEY) constraint failed\b/i.test(message)) {
    return new DatabaseError("CONSTRAINT", message, driverCode, { cause: error });
  }
  if (driverCode?.startsWith("SQLITE_BUSY") || driverCode === "SQLITE_LOCKED") {
    return new DatabaseError("BUSY", message, driverCode, { cause: error });
  }
  return error;
}

export async function mapDatabaseOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

export interface DatabaseMeta {
  changes: number;
  last_row_id: number | bigint | null;
}

export interface DatabaseResult<T = unknown> {
  results: T[];
  success: true;
  meta: DatabaseMeta;
}

export interface DatabaseStatement {
  bind(...values: DatabaseValue[]): DatabaseStatement;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<DatabaseResult<T>>;
  run<T = Record<string, unknown>>(): Promise<DatabaseResult<T>>;
}

export interface Database {
  prepare(query: string): DatabaseStatement;
  batch(statements: DatabaseStatement[]): Promise<DatabaseResult[]>;
}

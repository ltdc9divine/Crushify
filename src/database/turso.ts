import { createClient, type Client, type Config, type ResultSet } from "@libsql/client";
import type {
  Database,
  DatabaseResult,
  DatabaseStatement,
  DatabaseValue,
} from "../database.ts";
import { mapDatabaseOperation, normalizeDatabaseValues } from "../database.ts";

class TursoStatementAdapter implements DatabaseStatement {
  private readonly client: Client;
  private readonly sql: string;
  private readonly values: DatabaseValue[];

  constructor(
    client: Client,
    sql: string,
    values: DatabaseValue[] = [],
  ) {
    this.client = client;
    this.sql = sql;
    this.values = normalizeDatabaseValues(values);
  }

  bind(...values: DatabaseValue[]): DatabaseStatement {
    return new TursoStatementAdapter(this.client, this.sql, values);
  }

  async first<T = Record<string, unknown>>(columnName?: string): Promise<T | null> {
    const result = await mapDatabaseOperation(
      () => this.client.execute({ sql: this.sql, args: this.values }),
    );
    const row = result.rows[0];
    if (!row) return null;
    return (columnName === undefined ? row : row[columnName]) as T;
  }

  async all<T = Record<string, unknown>>(): Promise<DatabaseResult<T>> {
    return toDatabaseResult<T>(await mapDatabaseOperation(
      () => this.client.execute({ sql: this.sql, args: this.values }),
    ));
  }

  async run<T = Record<string, unknown>>(): Promise<DatabaseResult<T>> {
    return toDatabaseResult<T>(await mapDatabaseOperation(
      () => this.client.execute({ sql: this.sql, args: this.values }),
    ));
  }

  getBatchStatement(): { sql: string; args: DatabaseValue[] } {
    return { sql: this.sql, args: this.values };
  }
}

function toDatabaseResult<T>(result: ResultSet): DatabaseResult<T> {
  return {
    results: result.rows as unknown as T[],
    success: true,
    meta: {
      changes: result.rowsAffected,
      last_row_id: result.lastInsertRowid ?? null,
    },
  };
}

export class TursoDatabaseAdapter implements Database {
  private readonly client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  prepare(query: string): DatabaseStatement {
    return new TursoStatementAdapter(this.client, query);
  }

  async batch(statements: DatabaseStatement[]): Promise<DatabaseResult[]> {
    const batch = statements.map((statement) => {
      if (!(statement instanceof TursoStatementAdapter)) {
        throw new TypeError("Turso batch requires statements from the same database adapter");
      }
      return statement.getBatchStatement();
    });
    const results = await mapDatabaseOperation(() => this.client.batch(batch, "write"));
    return results.map((result) => toDatabaseResult(result));
  }
}

export async function connectTursoDatabase(
  config: Config,
): Promise<{ database: Database; close: () => void }> {
  const client = createClient({ ...config, intMode: "number" });
  try {
    await client.execute("PRAGMA foreign_keys = ON");
    const status = await client.execute("PRAGMA foreign_keys");
    if (Number(status.rows[0]?.foreign_keys) !== 1) {
      throw new Error("Turso connection does not enforce foreign keys");
    }
  } catch (error) {
    client.close();
    throw error;
  }
  return {
    database: new TursoDatabaseAdapter(client),
    close: () => client.close(),
  };
}

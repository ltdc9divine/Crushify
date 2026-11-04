import type {
  Database,
  DatabaseResult,
  DatabaseStatement,
  DatabaseValue,
} from "../database.ts";
import { mapDatabaseOperation, normalizeDatabaseValues } from "../database.ts";

class D1StatementAdapter implements DatabaseStatement {
  private readonly statement: D1PreparedStatement;

  constructor(statement: D1PreparedStatement) {
    this.statement = statement;
  }

  bind(...values: DatabaseValue[]): DatabaseStatement {
    return new D1StatementAdapter(this.statement.bind(...normalizeDatabaseValues(values)));
  }

  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null> {
    return mapDatabaseOperation(() => columnName === undefined
      ? this.statement.first<T>()
      : this.statement.first<T>(columnName));
  }

  all<T = Record<string, unknown>>(): Promise<DatabaseResult<T>> {
    return mapDatabaseOperation(() => this.statement.all<T>());
  }

  run<T = Record<string, unknown>>(): Promise<DatabaseResult<T>> {
    return mapDatabaseOperation(() => this.statement.run<T>());
  }

  getNativeStatement(): D1PreparedStatement {
    return this.statement;
  }
}

export class D1DatabaseAdapter implements Database {
  private readonly database: D1Database;

  constructor(database: D1Database) {
    this.database = database;
  }

  prepare(query: string): DatabaseStatement {
    return new D1StatementAdapter(this.database.prepare(query));
  }

  batch(statements: DatabaseStatement[]): Promise<DatabaseResult[]> {
    const nativeStatements = statements.map((statement) => {
      if (!(statement instanceof D1StatementAdapter)) {
        throw new TypeError("D1 batch requires statements from the same database adapter");
      }
      return statement.getNativeStatement();
    });
    return mapDatabaseOperation(() => this.database.batch(nativeStatements));
  }
}

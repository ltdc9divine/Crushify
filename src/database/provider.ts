import { D1DatabaseAdapter } from "./d1.ts";
import { connectTursoDatabase } from "./turso.ts";

export interface DatabaseEnvironment {
  DATABASE_PROVIDER?: string;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
}

export async function connectDatabaseFromEnvironment(
  environment: DatabaseEnvironment,
  d1Binding?: D1Database,
): Promise<{ database: import("../database.ts").Database; close: () => void }> {
  if (environment.DATABASE_PROVIDER === "d1") {
    if (!d1Binding) throw new Error("DATABASE_PROVIDER=d1 requires a D1 database binding");
    return {
      database: new D1DatabaseAdapter(d1Binding),
      close: () => undefined,
    };
  }

  if (environment.DATABASE_PROVIDER === "turso") {
    const url = environment.TURSO_DATABASE_URL;
    if (!url) throw new Error("TURSO_DATABASE_URL is required for DATABASE_PROVIDER=turso");
    if (!url.startsWith("file:") && !environment.TURSO_AUTH_TOKEN) {
      throw new Error("TURSO_AUTH_TOKEN is required for a remote Turso database");
    }
    return connectTursoDatabase({ url, authToken: environment.TURSO_AUTH_TOKEN || undefined });
  }

  throw new Error("DATABASE_PROVIDER must be explicitly set to d1 or turso");
}

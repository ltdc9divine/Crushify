import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { assertTursoStagingConfiguration } from "./staging-config.ts";

async function main(): Promise<void> {
  const target = assertTursoStagingConfiguration(process.env, true);
  const table = `crushify_smoke_${randomUUID().replaceAll("-", "")}`;
  const first = createClient({ ...target, intMode: "number" });
  const second = createClient({ ...target, intMode: "number" });
  let created = false;
  let failure: unknown;
  try {
    created = true;
    await first.execute(
      `CREATE TABLE "${table}" (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL)`,
    );
    const id = randomUUID();
    const payload = JSON.stringify({ fixture: "synthetic", phase: "7b" });
    const createdAt = new Date().toISOString();
    await first.execute({
      sql: `INSERT INTO "${table}" (id, payload, created_at) VALUES (?, ?, ?)`,
      args: [id, payload, createdAt],
    });
    const persisted = await second.execute({
      sql: `SELECT id, payload, created_at FROM "${table}" WHERE id = ?`,
      args: [id],
    });
    if (persisted.rows.length !== 1 ||
        persisted.rows[0]?.id !== id ||
        persisted.rows[0]?.payload !== payload ||
        persisted.rows[0]?.created_at !== createdAt) {
      throw new Error("Independent-connection persistence check failed");
    }
    const update = await second.execute({
      sql: `UPDATE "${table}" SET payload = ? WHERE id = ?`,
      args: [JSON.stringify({ fixture: "synthetic", phase: "7b", updated: true }), id],
    });
    if (Number(update.rowsAffected) !== 1) throw new Error("Synthetic update check failed");
    const deleted = await first.execute({
      sql: `DELETE FROM "${table}" WHERE id = ?`,
      args: [id],
    });
    if (Number(deleted.rowsAffected) !== 1) throw new Error("Synthetic delete check failed");
  } catch (error) {
    failure = error;
  } finally {
    if (created) {
      try {
        await first.execute(`DROP TABLE "${table}"`);
      } catch {
        failure = new Error(`Smoke-test cleanup failed; remove temporary table ${table} after verifying its identity`);
      }
    }
    first.close();
    second.close();
  }
  if (failure) throw new Error(
    failure instanceof Error && failure.message.startsWith("Smoke-test cleanup failed")
      ? failure.message
      : `Remote database operation failed (${failure instanceof Error ? failure.name : "UnknownError"})`,
  );
  console.info("Remote Turso synthetic CRUD and cross-connection persistence checks passed; temporary table removed");
}

main().catch((error: unknown) => {
  console.error("Remote Turso smoke test failed", error instanceof Error ? error.message : "Unknown error");
  process.exitCode = 1;
});

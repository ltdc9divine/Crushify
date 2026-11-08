import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";

const expectedDatabase = "crushify-staging";
const expectedGroup = "crushify-staging-sg";
const expectedRegion = "Singapore";

function assertStagingTarget(): { url: string; authToken: string } {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (process.env.ENVIRONMENT !== "staging" ||
      process.env.DATABASE_PROVIDER !== "turso" ||
      process.env.TURSO_CONFIRM_DATABASE !== expectedDatabase ||
      process.env.TURSO_CONFIRM_GROUP !== expectedGroup ||
      process.env.TURSO_CONFIRM_REGION !== expectedRegion ||
      process.env.TURSO_SMOKE_TEST !== "I_CONFIRM_SYNTHETIC_DATA" ||
      !url || !authToken?.trim()) {
    throw new Error("Remote Turso smoke test requires the staging target confirmations and explicit synthetic-data opt-in");
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "libsql:" || parsed.username || parsed.password || parsed.search || parsed.hash ||
      !/^crushify-staging-[a-z0-9-]+\.turso\.io$/i.test(parsed.hostname)) {
    throw new Error("Turso URL does not match the confirmed staging target");
  }
  return { url: parsed.toString(), authToken };
}

async function main(): Promise<void> {
  const target = assertStagingTarget();
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

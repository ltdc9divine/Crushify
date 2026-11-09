import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { applyMigrations, type SqlMigration } from "../src/database/migrations.ts";

async function loadMigrations(directory: string): Promise<SqlMigration[]> {
  const files = (await readdir(directory))
    .filter((file) => file.toLowerCase().endsWith(".sql"))
    .sort();
  return Promise.all(files.map(async (file) => {
    const match = file.match(/^(\d{4})_([a-z0-9_-]+)\.sql$/i);
    if (!match) throw new Error(`Invalid migration filename: ${file}`);
    return {
      version: Number(match[1]),
      name: match[2],
      sql: await readFile(join(directory, file), "utf8"),
    };
  }));
}

async function main(): Promise<void> {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL is required");

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("TURSO_DATABASE_URL must be a local SQLite file URL");
  }
  if (parsedUrl.protocol !== "file:" || parsedUrl.host || parsedUrl.search || parsedUrl.hash) {
    throw new Error("TURSO_DATABASE_URL must be a local SQLite file URL");
  }
  if (process.env.TURSO_AUTH_TOKEN?.trim()) {
    throw new Error("TURSO_AUTH_TOKEN must be empty for local SQLite migrations");
  }

  const filePath = url.startsWith("file://")
    ? fileURLToPath(parsedUrl)
    : isAbsolute(url.slice("file:".length))
      ? url.slice("file:".length)
      : resolve(process.cwd(), url.slice("file:".length));
  if (!filePath) throw new Error("TURSO_DATABASE_URL must include a local SQLite file path");
  await mkdir(dirname(filePath), { recursive: true });

  const client = createClient({
    url,
    intMode: "number",
  });
  try {
    const migrations = await loadMigrations(join(process.cwd(), "migrations"));
    if (migrations.length === 0) throw new Error("No database migrations were found");
    const applied = await applyMigrations(client, migrations);
    console.info(
      applied.length
        ? `Applied Turso migrations: ${applied.join(", ")}`
        : "Turso database is up to date",
    );
  } finally {
    client.close();
  }
}

main().catch((error: unknown) => {
  console.error("Turso migration failed", error);
  process.exitCode = 1;
});

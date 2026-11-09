import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

describe("local Turso migration command boundary", () => {
  it("rejects remote URLs before opening a client and does not echo auth values", () => {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/migrate-turso.ts"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          TURSO_DATABASE_URL: "libsql://remote-staging.invalid",
          TURSO_AUTH_TOKEN: "synthetic-token-must-not-appear",
        },
      },
    );

    assert.notEqual(result.status, 0);
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /TURSO_DATABASE_URL must be a local SQLite file URL/);
    assert.doesNotMatch(output, /synthetic-token-must-not-appear|remote-staging\.invalid/);
  });

  it("rejects a local file URL when a remote database token is configured", () => {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/migrate-turso.ts"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          TURSO_DATABASE_URL: "file:.local/must-not-be-created.db",
          TURSO_AUTH_TOKEN: "synthetic-token-must-not-appear",
        },
      },
    );

    assert.notEqual(result.status, 0);
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /TURSO_AUTH_TOKEN must be empty for local SQLite migrations/);
    assert.doesNotMatch(output, /synthetic-token-must-not-appear/);
  });
});

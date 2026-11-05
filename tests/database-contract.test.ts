import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { describe, it } from "node:test";
import { handleApiRequest } from "../src/index.ts";
import { applyMigrations, type SqlMigration } from "../src/database/migrations.ts";
import { TursoDatabaseAdapter } from "../src/database/turso.ts";
import { connectDatabaseFromEnvironment } from "../src/database/provider.ts";
import type { Storage, StorageObject, StorageUploadOptions } from "../src/storage.ts";
import { runDatabaseContract } from "./database-contract.mjs";

async function loadMigrations(): Promise<SqlMigration[]> {
  const directory = join(process.cwd(), "migrations");
  const files = (await readdir(directory)).filter((file) => file.toLowerCase().endsWith(".sql")).sort();
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

function createStorageBinding(): { storage: Storage; failNextDelete: () => void } {
  const objects = new Map<string, { bytes: Uint8Array; httpMetadata?: R2HTTPMetadata }>();
  let shouldFailDelete = false;
  const storage: Storage = {
    async upload(key: string, value: Uint8Array, options: StorageUploadOptions) {
      objects.set(key, {
        bytes: new Uint8Array(value),
        httpMetadata: { contentType: options.contentType },
      });
    },
    async get(key: string): Promise<StorageObject | null> {
      const stored = objects.get(key);
      if (!stored) return null;
      const bytes = stored.bytes;
      return {
        size: bytes.byteLength,
        contentType: stored.httpMetadata?.contentType ?? "",
        body: new Response(bytes).body,
        async arrayBuffer() {
          return bytes.slice().buffer;
        },
      };
    },
    async delete(key) {
      if (shouldFailDelete) {
        shouldFailDelete = false;
        throw new Error("Injected local binary deletion failure");
      }
      objects.delete(key);
    },
    async privateAssetUrl() {
      return null;
    },
  };
  return {
    storage,
    failNextDelete: () => {
      shouldFailDelete = true;
    },
  };
}

describe("shared API database contract on local Turso/libSQL", () => {
  it("runs the same auth, design, revision, preview, and asset contract as local D1", async () => {
    const directory = await mkdtemp(join(tmpdir(), "crushify-turso-contract-"));
    const databasePath = join(directory, "contract.db");
    const client = createClient({ url: pathToFileURL(databasePath).href, intMode: "number" });
    const tokenQueue: string[] = [];
    let closeDatabase = () => undefined;

    try {
      assert.deepEqual(await applyMigrations(client, await loadMigrations()), [1, 2, 3]);
      const { database, close } = await connectDatabaseFromEnvironment(
        { DATABASE_PROVIDER: "turso", TURSO_DATABASE_URL: pathToFileURL(databasePath).href },
      );
      closeDatabase = close;
      const media = createStorageBinding();
      const mailer = {
        async fetch(_url: string, init?: RequestInit) {
          const message = JSON.parse(String(init?.body)) as { text: string };
          const match = message.text.match(/#magic_token=([A-Za-z0-9_-]+)/);
          if (!match) throw new Error("Magic link did not contain a fragment token");
          tokenQueue.push(match[1]);
          return new Response(null, { status: 200 });
        },
      };
      const env = {
        DB: database,
        STORAGE: media.storage,
        APP_ORIGIN: "https://crushify.test",
        MAILER: mailer,
        MAILER_AUTH_TOKEN: "local-contract-mailer",
      };

      const request = async (path: string, session?: { cookies: string[]; csrf: string }, options = {}) => {
        const requestOptions = options as {
          method?: string;
          mutating?: boolean;
          json?: unknown;
          token?: string;
          headers?: HeadersInit;
          body?: BodyInit;
        };
        const headers = new Headers(requestOptions.headers);
        if (session?.cookies.length) headers.set("Cookie", session.cookies.join("; "));
        if (requestOptions.mutating) {
          headers.set("Origin", "https://crushify.test");
          if (session?.csrf) headers.set("X-CSRF-Token", session.csrf);
        }
        if (requestOptions.json !== undefined) {
          headers.set("Content-Type", "application/json");
        }
        if (requestOptions.token) headers.set("Authorization", `Bearer ${requestOptions.token}`);
        const requestBody = requestOptions.json === undefined
          ? requestOptions.body
          : JSON.stringify(requestOptions.json);
        const response = await handleApiRequest(
          new Request(`https://crushify.test/api/v1${path}`, {
            method: requestOptions.method ?? "GET",
            headers,
            body: requestBody,
          }),
          env as never,
        );
        const body = response.status === 204 ||
          !response.headers.get("content-type")?.includes("application/json")
          ? null
          : await response.json();
        return { response, body };
      };

      await runDatabaseContract({
        request,
        getMagicToken: async () => {
          const token = tokenQueue.shift();
          assert.ok(token, "local test mailer should capture a magic link");
          return token;
        },
        label: "Turso local file + fake R2",
        beforeAssetDelete: async () => media.failNextDelete(),
      });

      const integrity = await database.prepare("PRAGMA foreign_key_check").all();
      assert.equal(integrity.results.length, 0);
    } finally {
      closeDatabase();
      client.close();
      if (process.platform === "win32") {
        const cleanup = spawn(
          process.execPath,
          [
            "-e",
            "const fs=require('node:fs');setTimeout(()=>fs.rmSync(process.argv[1],{recursive:true,force:true}),3000)",
            directory,
          ],
          { detached: true, stdio: "ignore", windowsHide: true },
        );
        cleanup.unref();
      } else {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
});

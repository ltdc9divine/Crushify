import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

test("Vercel release retains runtime entry points and migration packaging", async () => {
  const [vercelSource, packageSource, ignoreSource, handoff] = await Promise.all([
    readFile(join(root, "vercel.json"), "utf8"),
    readFile(join(root, "package.json"), "utf8"),
    readFile(join(root, ".vercelignore"), "utf8"),
    readFile(join(root, "docs/FINAL-API-HANDOFF.md"), "utf8"),
  ]);
  const vercel = JSON.parse(vercelSource) as {
    functions?: Record<string, { includeFiles?: string }>;
    builds?: unknown;
  };
  const packageJson = JSON.parse(packageSource) as { scripts?: Record<string, string> };

  assert.equal(vercel.functions?.["api/[...path].ts"]?.includeFiles, "migrations/**");
  assert.equal(vercel.builds, undefined);
  assert.equal(packageJson.scripts?.build, undefined);
  for (const pattern of [
    ".agents",
    ".assetsignore",
    ".dev.vars",
    ".env",
    "_headers",
    "*.vars",
    "docs",
    "tests",
    "scripts",
    "*.db",
    "*.log",
    "test-output.txt",
    "session.json",
    "wrangler*.jsonc",
  ]) {
    assert.ok(ignoreSource.split(/\r?\n/).includes(pattern), `release excludes ${pattern}`);
  }
  assert.doesNotMatch(ignoreSource, /^(?:api|src|migrations|css|js|templates|shared|admin)$/m);

  for (const file of [
    "api/[...path].ts",
    "api/cron/publication-lifecycle.ts",
    "index.html",
    "css/style.css",
    "js/main.js",
    "admin/index.html",
    "shared/customer-editor.js",
    "p/index.html",
    "custom-design/index.html",
    "account/websites/index.html",
    "checkout/index.html",
    "templates/our-universe/index.html",
    "templates/love-letter/index.html",
    "templates/our-memories/index.html",
    "templates/say-yes/index.html",
    "templates/distance-means-nothing/index.html",
    "migrations/0021_admin_activity_audit.sql",
    "migrations/0022_custom_design_customer_replies.sql",
    "migrations/0023_manual_bank_transfer_settlement.sql",
  ]) {
    await access(join(root, file));
  }

  const migrations = (await readdir(join(root, "migrations")))
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort();
  const manifestRows = [...handoff.matchAll(
    /^\| (\d{4}) \| `migrations\/([^`]+)` \| `([a-f\d]{64})` \|$/gm,
  )];
  assert.equal(manifestRows.length, migrations.length);
  for (const [index, migration] of migrations.entries()) {
    const row = manifestRows[index];
    assert.ok(row);
    assert.equal(row[1], migration.slice(0, 4));
    assert.equal(row[2], migration);
    const contents = await readFile(join(root, "migrations", migration));
    assert.equal(row[3], createHash("sha256").update(contents).digest("hex"));
  }
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { PUBLICATION_SHELL_CSP } from "../src/security-headers.ts";

const root = new URL("../", import.meta.url);
const policyRoutes = [
  { route: "/", file: "index.html" },
  { route: "/templates/our-universe/", file: "templates/our-universe/index.html" },
  { route: "/templates/love-letter/", file: "templates/love-letter/index.html" },
  { route: "/templates/our-memories/", file: "templates/our-memories/index.html" },
  { route: "/templates/say-yes/", file: "templates/say-yes/index.html" },
  { route: "/templates/distance-means-nothing/", file: "templates/distance-means-nothing/index.html" },
  { route: "/p/index.html", file: "p/index.html" },
];

function hash(value: string): string {
  const browserText = value.replace(/\r\n?/g, "\n");
  return `'sha256-${createHash("sha256").update(browserText).digest("base64")}'`;
}

function parseHeaderRules(source: string): Map<string, Map<string, string>> {
  const rules = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const line of source.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    if (!line.startsWith(" ")) {
      current = new Map();
      rules.set(line, current);
      continue;
    }
    const match = line.match(/^\s+([^:]+):\s*(.*)$/);
    assert.ok(match && current, `Invalid _headers line: ${line}`);
    assert.equal(current.has(match[1]), false, `Duplicate ${match[1]} header in one rule`);
    current.set(match[1], match[2]);
  }
  return rules;
}

function mergedHeaders(rules: Map<string, Map<string, string>>, route: string): Map<string, string> {
  const baseline = rules.get("/*") ?? new Map<string, string>();
  const specific = rules.get(route === "/" || route === "/p/index.html"
    ? route
    : `${route.slice(0, -1)}/*`);
  assert.ok(specific, `Missing _headers rule for ${route}`);
  for (const name of baseline.keys()) {
    assert.equal(specific.has(name), false, `Duplicate ${name} rule for ${route}`);
  }
  return new Map([...baseline, ...specific]);
}

function directive(policy: string, name: string): string[] {
  const value = policy.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));
  return value ? value.split(/\s+/).slice(1) : [];
}

describe("static security headers and CSP", () => {
  it("defines one compatible header policy per customer-facing static page", async () => {
    const headerText = await readFile(new URL("_headers", root), "utf8");
    const rules = parseHeaderRules(headerText);
    const baseline = rules.get("/*");
    assert.ok(baseline, "Missing baseline static response security headers");
    assert.deepEqual([...baseline.keys()], [
      "X-Content-Type-Options",
      "Referrer-Policy",
      "X-Frame-Options",
      "Permissions-Policy",
    ]);

    for (const { route, file } of policyRoutes) {
      const rule = mergedHeaders(rules, route);
      const policy = rule.get("Content-Security-Policy");
      assert.ok(policy, `Missing CSP for ${route}`);
      assert.equal(rule.get("X-Content-Type-Options"), "nosniff");
      assert.equal(rule.get("Referrer-Policy"), "no-referrer");
      assert.equal(rule.get("X-Frame-Options"), "DENY");
      assert.equal(rule.get("Permissions-Policy"), "camera=(), microphone=(), geolocation=()");
      assert.ok(rule.has("Cache-Control"));

      const html = await readFile(new URL(file, root), "utf8");
      const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/i)?.[1];
      assert.ok(meta, `Missing CSP meta fallback in ${file}`);
      assert.equal(policy, `${meta}; frame-ancestors 'none'`, `Meta/header CSP mismatch in ${file}`);
      assert.equal((policy.match(/Content-Security-Policy/g) ?? []).length, 0);

      const scriptSources = directive(policy, "script-src");
      const styleSources = directive(policy, "style-src");
      assert.ok(scriptSources.length > 0);
      assert.ok(styleSources.length > 0);
      assert.ok(!scriptSources.includes("'unsafe-inline'"));
      assert.ok(!scriptSources.includes("'unsafe-eval'"));
      assert.ok(!styleSources.includes("'unsafe-inline'"));
      assert.ok(!styleSources.includes("'unsafe-eval'"));
      assert.ok(directive(policy, "object-src").includes("'none'"));
      assert.ok(directive(policy, "base-uri").includes("'self'"));
      assert.ok(directive(policy, "form-action").includes("'self'"));
      if (route === "/p/index.html") assert.equal(policy, PUBLICATION_SHELL_CSP);

      for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        const attrs = match[1];
        const body = match[2];
        if (/\bsrc\s*=/.test(attrs) || !body.trim()) continue;
        assert.ok(scriptSources.includes(hash(body)), `Inline script hash missing in ${file}`);
      }
      for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
        assert.ok(styleSources.includes(hash(match[1])), `Inline style hash missing in ${file}`);
      }
    }
  });

  it("uses only the intended remote resources and trusted dynamic style values", async () => {
    const headerText = await readFile(new URL("_headers", root), "utf8");
    const rules = parseHeaderRules(headerText);
    const runtimeFiles = new Map([
      ["templates/our-memories/index.html", ["templates/our-memories/our-memories.js"]],
      ["templates/say-yes/index.html", ["templates/say-yes/say-yes.js"]],
      ["templates/distance-means-nothing/index.html", [
        "templates/distance-means-nothing/app.js",
        "templates/distance-means-nothing/DistanceScene.js",
        "templates/distance-means-nothing/core.js",
      ]],
    ]);
    const expectedDynamicStyleValues = new Map([
      ["templates/our-universe/index.html", ["margin-top:16px"]],
      ["templates/love-letter/index.html", ["margin-top:8px", "margin-top:14px"]],
      ["templates/our-memories/index.html", ["--c:#8a1740", "--c:#1b1f4b", "--c:#6c4aa6", "--c:#7a5230"]],
      ["templates/say-yes/index.html", ["--c:#ff2f7d", "--c:#4b6bff", "--c:#a86bff", "--c:#ffa920"]],
      ["templates/distance-means-nothing/index.html", ["font-size:14px;margin-top:4px"]],
    ]);

    for (const { route, file } of policyRoutes) {
      const rule = mergedHeaders(rules, route);
      const policy = rule.get("Content-Security-Policy");
      assert.ok(policy);
      const scriptSources = directive(policy, "script-src");
      const styleAttrSources = directive(policy, "style-src-attr");
      const html = await readFile(new URL(file, root), "utf8");
      const sourceTexts = [html];
      for (const runtimeFile of runtimeFiles.get(file) ?? []) {
        sourceTexts.push(await readFile(new URL(runtimeFile, root), "utf8"));
      }

      for (const sourceText of sourceTexts) {
        for (const resource of new Set(sourceText.match(/https:\/\/[^"'`\s<>]+/g) ?? [])) {
          if (resource.includes("fonts.googleapis.com")) {
            assert.ok(directive(policy, "style-src").includes("https://fonts.googleapis.com"), `${file} font stylesheet denied`);
          } else if (resource.includes("fonts.gstatic.com")) {
            assert.ok(directive(policy, "font-src").includes("https://fonts.gstatic.com"), `${file} font denied`);
          } else if (resource.includes("cdnjs.cloudflare.com") || resource.includes("cdn.jsdelivr.net")) {
            assert.ok(scriptSources.some((source) => resource.startsWith(source)), `${file} script resource denied: ${resource}`);
          } else {
            assert.fail(`Unreviewed external resource in ${file}: ${resource}`);
          }
        }
      }

      for (const value of expectedDynamicStyleValues.get(file) ?? []) {
        assert.ok(styleAttrSources.includes(hash(value)), `Dynamic inline style hash missing for ${value} in ${file}`);
      }
    }
  });

  it("loads the shared customer editor styles without runtime inline style injection", async () => {
    const source = await readFile(new URL("../shared/customer-editor.js", import.meta.url), "utf8");
    assert.doesNotMatch(source, /createElement\(["']style["']\)/);

    for (const { file } of policyRoutes.slice(1, 6)) {
      const html = await readFile(new URL(file, root), "utf8");
      assert.match(html, /href=["']\/shared\/customer-editor\.css["']/);
    }
  });

  it("configures Vercel static responses without overlapping API or conflicting CSP rules", async () => {
    const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8")) as {
      rewrites?: unknown[];
      crons?: unknown[];
      functions?: Record<string, unknown>;
      headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
    };
    const headerRules = new Map((vercel.headers ?? []).map((rule) => {
      const values = new Map<string, string>();
      for (const header of rule.headers) {
        const key = header.key.toLowerCase();
        assert.equal(values.has(key), false, `Duplicate ${header.key} in ${rule.source}`);
        values.set(key, header.value);
      }
      return [rule.source, values];
    }));
    const cloudflareRules = parseHeaderRules(await readFile(new URL("../_headers", import.meta.url), "utf8"));
    const baseline = {
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
    };

    assert.deepEqual(vercel.rewrites, [
      { source: "/p/:slug", destination: "/p/index.html" },
    ]);
    assert.deepEqual(vercel.crons, [
      { path: "/api/cron/publication-lifecycle", schedule: "0 3 * * *" },
    ]);
    assert.deepEqual(vercel.functions, { "api/[...path].ts": { includeFiles: "migrations/**" } });

    const pageSources = new Map([
      ["/", "/"],
      ["/index.html", "/index.html"],
      ...policyRoutes.slice(1, 6).map(({ route }) => [
        route,
        `${route.slice(0, -1)}/:path*`,
      ] as const),
      ["/p/index.html", "/p/:path*"],
    ]);
    for (const { route, file } of policyRoutes) {
      const source = pageSources.get(route);
      assert.ok(source, `No Vercel source mapping for ${route}`);
      const configured = headerRules.get(source);
      assert.ok(configured, `Missing Vercel header rule for ${source}`);
      const headerRule = mergedHeaders(cloudflareRules, route);
      assert.equal(
        configured.get("content-security-policy"),
        headerRule.get("Content-Security-Policy"),
        `Vercel and Cloudflare CSP differ for ${route}`,
      );
      for (const [name, value] of Object.entries(baseline)) {
        assert.equal(configured.get(name), value, `Missing Vercel ${name} for ${route}`);
      }
      assert.equal(configured.get("cache-control"), headerRule.get("Cache-Control"));

      const html = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
      const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/i)?.[1];
      assert.ok(meta);
      assert.equal(configured.get("content-security-policy"), `${meta}; frame-ancestors 'none'`);
    }

    for (const source of ["/shared/:path*", "/css/:path*", "/js/:path*"]) {
      const configured = headerRules.get(source);
      assert.ok(configured, `Missing Vercel static asset headers for ${source}`);
      for (const [name, value] of Object.entries(baseline)) {
        assert.equal(configured.get(name), value);
      }
      assert.equal(configured.has("content-security-policy"), false);
      assert.equal(configured.has("cache-control"), false);
    }

    assert.deepEqual([...headerRules.keys()], [
      "/",
      "/index.html",
      "/templates/our-universe/:path*",
      "/templates/love-letter/:path*",
      "/templates/our-memories/:path*",
      "/templates/say-yes/:path*",
      "/templates/distance-means-nothing/:path*",
      "/p/:path*",
      "/shared/:path*",
      "/css/:path*",
      "/js/:path*",
    ]);
    assert.ok([...headerRules.values()].every((headers) =>
      !headers.has("strict-transport-security")), "Do not duplicate the hosting platform's HTTPS-only HSTS policy");
  });
});

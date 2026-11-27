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
  { route: "/checkout/", file: "checkout/index.html" },
  { route: "/admin/", file: "admin/index.html" },
  { route: "/p/index.html", file: "p/index.html" },
];

function hash(value: string): string {
  const browserText = value.replace(/\r\n?/g, "\n");
  return `'sha256-${createHash("sha256").update(browserText).digest("base64")}'`;
}

type VercelHeaderRule = {
  source: string;
  headers: Array<{ key: string; value: string }>;
};

async function readVercelHeaderRules(): Promise<Map<string, Map<string, string>>> {
  const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8")) as {
    headers?: VercelHeaderRule[];
  };
  assert.ok(Array.isArray(vercel.headers), "Missing Vercel header rules");
  const rules = new Map<string, Map<string, string>>();
  for (const rule of vercel.headers) {
    const values = new Map<string, string>();
    for (const header of rule.headers) {
      const key = header.key.toLowerCase();
      assert.equal(values.has(key), false, `Duplicate ${header.key} in ${rule.source}`);
      values.set(key, header.value);
    }
    assert.equal(rules.has(rule.source), false, `Duplicate Vercel header rule for ${rule.source}`);
    rules.set(rule.source, values);
  }
  return rules;
}

function vercelPageSources(): Map<string, string> {
  return new Map([
    ["/", "/"],
    ["/index.html", "/index.html"],
    ...policyRoutes.slice(1, 6).map(({ route }) => [
      route,
      `${route.slice(0, -1)}/:path*`,
    ] as const),
    ["/checkout/", "/checkout/"],
    ["/admin/", "/admin/:path*"],
    ["/p/index.html", "/p/:path*"],
  ]);
}

function vercelHeadersForRoute(
  rules: Map<string, Map<string, string>>,
  pageSources: Map<string, string>,
  route: string,
): Map<string, string> {
  const source = pageSources.get(route);
  assert.ok(source, `No Vercel source mapping for ${route}`);
  const headers = rules.get(source);
  assert.ok(headers, `Missing Vercel header rule for ${source}`);
  return headers;
}

function expectedCacheControl(route: string): string {
  return ["/checkout/", "/admin/", "/p/index.html"].includes(route)
    ? "no-store"
    : "public, max-age=0, must-revalidate";
}

function directive(policy: string, name: string): string[] {
  const value = policy.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));
  return value ? value.split(/\s+/).slice(1) : [];
}

describe("static security headers and CSP", () => {
  it("defines a compatible Vercel header policy per customer-facing static page", async () => {
    const rules = await readVercelHeaderRules();
    const pageSources = vercelPageSources();
    const baseline = {
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
    };

    for (const { route, file } of policyRoutes) {
      const rule = vercelHeadersForRoute(rules, pageSources, route);
      const policy = rule.get("content-security-policy");
      assert.ok(policy, `Missing CSP for ${route}`);
      for (const [name, value] of Object.entries(baseline)) {
        assert.equal(rule.get(name), value, `Missing Vercel ${name} for ${route}`);
      }
      assert.equal(rule.get("cache-control"), expectedCacheControl(route),
        `Unexpected Vercel cache policy for ${route}`);

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

    for (const source of ["/checkout/", "/checkout/:path*"]) {
      const headers = rules.get(source);
      assert.ok(headers, `Missing Vercel header rule for ${source}`);
      assert.equal(headers.get("content-security-policy"), rules.get("/checkout/")?.get("content-security-policy"));
      assert.equal(headers.get("cache-control"), "no-store", `Checkout must not be cached for ${source}`);
      for (const [name, value] of Object.entries(baseline)) {
        assert.equal(headers.get(name), value, `Missing Vercel ${name} for ${source}`);
      }
    }
  });

  it("uses only the intended remote resources and trusted dynamic style values", async () => {
    const rules = await readVercelHeaderRules();
    const pageSources = vercelPageSources();
    const runtimeFiles = new Map([
      ["checkout/index.html", ["checkout/checkout.js"]],
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
      const rule = vercelHeadersForRoute(rules, pageSources, route);
      const policy = rule.get("content-security-policy");
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
          } else if (resource.includes("vietqr.app")) {
            assert.ok(directive(policy, "img-src").includes("https://vietqr.app"), `${file} QR image denied: ${resource}`);
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

  it("pins every remote Three.js script and import-map module with Subresource Integrity", async () => {
    const threeR128Integrity =
      "sha384-CI3ELBVUz9XQO+97x6nwMDPosPR5XvsxW2ua7N1Xeygeh1IxtgqtCkGfQY9WWdHu";
    for (const file of ["templates/our-universe/index.html", "templates/love-letter/index.html"]) {
      const html = await readFile(new URL(file, root), "utf8");
      assert.ok(html.includes("https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"),
        `Missing primary Three.js URL in ${file}`);
      assert.ok(html.includes(`THREE_INTEGRITY='${threeR128Integrity}'`),
        `Missing primary/fallback SRI mapping in ${file}`);
      assert.match(html, /s\.integrity=integrity;s\.crossOrigin='anonymous';s\.referrerPolicy='no-referrer'/);
    }

    for (const file of ["templates/our-universe/index.html", "templates/love-letter/index.html"]) {
      const source = await readFile(new URL(file, root), "utf8");
      assert.ok(source.includes(
        `THREE_FALLBACK_URL='https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js',THREE_INTEGRITY='${threeR128Integrity}'`,
      ), `Missing fallback SRI mapping in ${file}`);
      assert.match(source, /s\.integrity=integrity;s\.crossOrigin='anonymous';s\.referrerPolicy='no-referrer'/);
    }

    for (const file of ["templates/our-memories/our-memories.js", "templates/say-yes/say-yes.js"]) {
      const source = await readFile(new URL(file, root), "utf8");
      assert.ok(source.includes(`'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js':'${threeR128Integrity}'`),
        `Missing cdnjs SRI mapping in ${file}`);
      assert.ok(source.includes(`'https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js':'${threeR128Integrity}'`),
        `Missing jsDelivr SRI mapping in ${file}`);
      assert.match(source, /e\.integrity=integrity;e\.crossOrigin='anonymous';e\.referrerPolicy='no-referrer'/);
    }

    const distanceHtml = await readFile(
      new URL("templates/distance-means-nothing/index.html", root),
      "utf8",
    );
    const importMapBody = distanceHtml.match(/<script type="importmap">([\s\S]*?)<\/script>/i)?.[1];
    assert.ok(importMapBody, "Missing Distance Means Nothing import map");
    const importMap = JSON.parse(importMapBody) as {
      integrity?: Record<string, string>;
    };
    assert.deepEqual(importMap.integrity, {
      "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js":
        "sha384-61S/Nu32S3E5+n+KpCOTb2eRYps6fVKm+9Gz1QBvSePFthb46f063Aa/qe/lykFZ",
      "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js":
        "sha384-qlO/ZugKPxAQUAvTlQoo0QECzxJIJySZmCF/DHdb2Xn/hHndFwX/vfUAC9Hbk6LP",
      "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/postprocessing/EffectComposer.js":
        "sha384-L+Ns9skCAqjab7aG8LH5VLknBCoENW7p37sOj39jnITwlWZFabWc29JwzgYf6ygy",
      "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/postprocessing/OutputPass.js":
        "sha384-RJJc+pg+Ue2ZwXlf8n78cPHMiHrqfr+AxxabF5vkXMXjNPF6nSUoqb20IQXkMo6c",
      "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/postprocessing/RenderPass.js":
        "sha384-LwKrkOBAkmQ2KT4cv6P6q9Rb9L01GIFU34Zp16tGWZoBnrVuujfjpYZb7OxEMb0J",
      "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/postprocessing/UnrealBloomPass.js":
        "sha384-R734/7SvtqjjeteDKG4qcQA0adDCZ1ZcKfYUZsbVr9qqHGlgSXH9eNN4b3NIgwuc",
      "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/postprocessing/Pass.js":
        "sha384-gSqIFh8vMmp1veyOysIS3KPVUl/A5JPefYvW4b89OeYeW0bwkrjN7qcC1h0XJK/K",
      "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/postprocessing/MaskPass.js":
        "sha384-SDM80tiGflO8UDV/QzR/mASjcc/+wF7KfRVFNHJUIPcTctwoPI8GoWVTlccZw7V4",
      "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/postprocessing/ShaderPass.js":
        "sha384-zetU6HhR/vTtgSvnS9DE+GQPZhVT/ZOSLa/1+DSM6rkM9hvBgQWr9bCEosZt93ch",
      "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/shaders/CopyShader.js":
        "sha384-kzVlcj2amFaRNIWZ5zE0PmIN+QTNWWvrgKk31S8N/7w0nf7Qq3xqxHRLbD2UPPSl",
      "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/shaders/LuminosityHighPassShader.js":
        "sha384-621kiA/kIdX8rtH6VU6+SwMVx+B8g7MQ6x0fei5dZVX3CQZSLkpOlglIk9sxE+/g",
      "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/shaders/OutputShader.js":
        "sha384-fT4woAJJtXcAxElHG1cGfIZkiSxaj7u+24LHlfNVDZZ9aSjZvr2emMGPmcD9eF0V",
    });
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
    const baseline = {
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
    };

    assert.deepEqual(vercel.rewrites, [
      { source: "/api/v1/:path*", destination: "/api/v1?__crushify_path=:path*" },
      { source: "/p/:slug", destination: "/p/index.html" },
    ]);
    assert.deepEqual(vercel.crons, [
      { path: "/api/cron/publication-lifecycle", schedule: "0 3 * * *" },
    ]);
    assert.deepEqual(vercel.functions, { "api/[...path].ts": { includeFiles: "migrations/**" } });

    const pageSources = vercelPageSources();
    for (const { route, file } of policyRoutes) {
      const configured = vercelHeadersForRoute(headerRules, pageSources, route);
      for (const [name, value] of Object.entries(baseline)) {
        assert.equal(configured.get(name), value, `Missing Vercel ${name} for ${route}`);
      }
      assert.equal(configured.get("cache-control"), expectedCacheControl(route),
        `Unexpected Vercel cache policy for ${route}`);

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
      "/checkout/",
      "/checkout/:path*",
      "/admin/:path*",
      "/p/:path*",
      "/shared/:path*",
      "/css/:path*",
      "/js/:path*",
    ]);
    assert.ok([...headerRules.values()].every((headers) =>
      !headers.has("strict-transport-security")), "Do not duplicate the hosting platform's HTTPS-only HSTS policy");
  });
});

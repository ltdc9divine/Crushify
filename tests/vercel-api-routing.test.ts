import assert from "node:assert/strict";
import test from "node:test";
import { resolveVersionedApiPath } from "../api/v1.ts";

test("dispatches rewritten Vercel API paths while preserving query parameters", () => {
  assert.equal(
    resolveVersionedApiPath("/api/v1?__crushify_path=designs/8fef2c0a-1234-4234-8234-123456789abc&view=latest"),
    "/api/v1/designs/8fef2c0a-1234-4234-8234-123456789abc?view=latest",
  );
  assert.equal(
    resolveVersionedApiPath("/api/v1?__crushify_path=designs/abc/preview"),
    "/api/v1/designs/abc/preview",
  );
});

test("rejects ambiguous or malformed Vercel API dispatch paths", () => {
  assert.equal(resolveVersionedApiPath("/api/v1?__crushify_path=designs&__crushify_path=orders"), null);
  assert.equal(resolveVersionedApiPath("/api/v1?__crushify_path=../designs"), null);
  assert.equal(resolveVersionedApiPath("/api/v1?__crushify_path=designs//abc"), null);
});

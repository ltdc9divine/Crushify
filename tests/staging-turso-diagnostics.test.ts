import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createStagingOperationDiagnostic,
  StagingOperationTrace,
} from "../scripts/staging-diagnostics.ts";

describe("Turso staging diagnostics", () => {
  it("reports the exact stage for client creation and preflight reads", async () => {
    const trace = new StagingOperationTrace();
    for (const stage of ["create-client", "read-migration-ledger", "read-schema"] as const) {
      let thrown: unknown;
      await assert.rejects(
        trace.run(stage, () => {
          throw new TypeError("sensitive diagnostic message");
        }),
        (error: unknown) => {
          thrown = error;
          return error instanceof TypeError;
        },
      );
      assert.equal(createStagingOperationDiagnostic(trace.stage, thrown).stage, stage);
    }
  });

  it("includes only allowlisted error codes and never serializes messages or stacks", () => {
    const error = Object.assign(
      new TypeError("https://private.example/path?auth=token-secret"),
      { code: "ENOTFOUND" },
    );
    error.stack = "stack-secret Authorization: Bearer token-secret";
    Object.defineProperty(error, "cause", {
      value: Object.assign(new Error("database-url-secret"), { code: "token-secret" }),
    });

    const diagnostic = createStagingOperationDiagnostic("read-migration-ledger", error);
    const serialized = JSON.stringify(diagnostic);

    assert.equal(diagnostic.error_name, "TypeError");
    assert.equal(diagnostic.error_code, "ENOTFOUND");
    assert.deepEqual(diagnostic.cause_chain, [{ name: "Error" }]);
    for (const secret of [
      "private.example",
      "auth=token-secret",
      "token-secret",
      "database-url-secret",
      "stack-secret",
      "Authorization",
    ]) {
      assert.equal(serialized.includes(secret), false);
    }
  });

  it("limits the full error chain to four levels", () => {
    const errors = Array.from({ length: 7 }, () => new Error("private message"));
    for (let index = 0; index < errors.length - 1; index += 1) {
      Object.defineProperty(errors[index], "cause", { value: errors[index + 1] });
    }

    const diagnostic = createStagingOperationDiagnostic("read-schema", errors[0]);

    assert.equal(1 + diagnostic.cause_chain.length, 4);
    assert.deepEqual(diagnostic.cause_chain, [
      { name: "Error" },
      { name: "Error" },
      { name: "Error" },
    ]);
  });

  it("stops a circular cause chain without leaking error contents", () => {
    const first = new TypeError("first-secret");
    const second = new Error("second-secret");
    Object.defineProperty(first, "cause", { value: second });
    Object.defineProperty(second, "cause", { value: first });

    const diagnostic = createStagingOperationDiagnostic("create-client", first);

    assert.deepEqual(diagnostic.cause_chain, [{ name: "Error" }]);
    assert.equal(JSON.stringify(diagnostic).includes("secret"), false);
  });

  it("omits unrecognized codes while retaining the existing configuration error name", () => {
    const error = new Error("existing configuration failure") as Error & { code?: string };
    error.name = "StagingConfigurationError";
    error.code = "url-and-token-secret";

    const diagnostic = createStagingOperationDiagnostic("resolve-target", error);

    assert.equal(diagnostic.error_name, "StagingConfigurationError");
    assert.equal("error_code" in diagnostic, false);
    assert.equal(JSON.stringify(diagnostic).includes("existing configuration failure"), false);
    assert.equal(JSON.stringify(diagnostic).includes("url-and-token-secret"), false);
  });
});

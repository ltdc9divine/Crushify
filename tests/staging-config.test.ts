import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertTursoMigrationConfirmation,
  assertCloudinaryStagingConfiguration,
  assertTursoStagingConfiguration,
} from "../scripts/staging-config.ts";

const validTursoEnvironment = {
  CRUSHIFY_STAGING_PROFILE: "local",
  ENVIRONMENT: "staging",
  DATABASE_PROVIDER: "turso",
  TURSO_STAGING_DATABASE_URL: "libsql://crushify-staging-test-org.turso.io",
  TURSO_STAGING_AUTH_TOKEN: "synthetic-turso-token",
  TURSO_CONFIRM_DATABASE: "crushify-staging",
  TURSO_CONFIRM_GROUP: "crushify-staging-sg",
  TURSO_CONFIRM_REGION: "Singapore",
};

const validCloudinaryEnvironment = {
  CRUSHIFY_STAGING_PROFILE: "local",
  ENVIRONMENT: "staging",
  STORAGE_PROVIDER: "cloudinary",
  CLOUDINARY_STAGING_CLOUD_NAME: "crushify-staging-free",
  CLOUDINARY_STAGING_API_KEY: "synthetic-cloudinary-key",
  CLOUDINARY_STAGING_API_SECRET: "synthetic-cloudinary-secret",
  CLOUDINARY_STAGING_ISOLATED_ACCOUNT: "I_CONFIRM_SEPARATE_FREE_CLOUD",
  CLOUDINARY_SMOKE_TEST: "I_CONFIRM_SYNTHETIC_DATA",
};

describe("staging script environment guards", () => {
  it("requires a separate explicit confirmation before applying migrations", () => {
    assert.throws(
      () => assertTursoMigrationConfirmation({}),
      /explicit TURSO_MIGRATE_CONFIRM confirmation/,
    );
    assert.throws(
      () => assertTursoMigrationConfirmation({
        TURSO_MIGRATE_CONFIRM: "I_CONFIRM_DATA",
      }),
      /explicit TURSO_MIGRATE_CONFIRM confirmation/,
    );
    assert.doesNotThrow(() => assertTursoMigrationConfirmation({
      TURSO_MIGRATE_CONFIRM: "I_CONFIRM_APPLY_STAGING_MIGRATIONS",
    }));
  });

  it("rejects production deployments for migrations and Turso smoke tests", () => {
    for (const requireOptIn of [false, true]) {
      assert.throws(
        () => assertTursoStagingConfiguration({
          ...validTursoEnvironment,
          VERCEL_ENV: "production",
          TURSO_SMOKE_TEST: "I_CONFIRM_SYNTHETIC_DATA",
        }, requireOptIn),
        /cannot run in Vercel Production/,
      );
    }
  });

  it("requires staging mode, the expected database, group, and Singapore region", () => {
    for (const override of [
      { TURSO_CONFIRM_DATABASE: "crushify-production" },
      { TURSO_CONFIRM_GROUP: "another-group" },
      { TURSO_CONFIRM_REGION: "Frankfurt" },
      { TURSO_CONFIRM_DATABASE: undefined },
      { TURSO_CONFIRM_GROUP: undefined },
      { TURSO_CONFIRM_REGION: undefined },
    ]) {
      assert.throws(
        () => assertTursoStagingConfiguration({
          ...validTursoEnvironment,
          ...override,
        }),
        /Turso staging operation requires/,
      );
    }
  });

  it("requires an explicit local staging profile", () => {
    for (const override of [
      { CRUSHIFY_STAGING_PROFILE: undefined },
      { ENVIRONMENT: "production" },
      { VERCEL_ENV: "production" },
    ]) {
      assert.throws(
        () => assertTursoStagingConfiguration({
          ...validTursoEnvironment,
          ...override,
        }),
        /local staging profile/,
      );
      assert.throws(
        () => assertCloudinaryStagingConfiguration({
          ...validCloudinaryEnvironment,
          ...override,
        }),
        /local staging profile/,
      );
    }
  });

  it("rejects non-staging hosts and never includes credentials in errors", () => {
    const secretUrl = "libsql://production-secret.turso.io";
    const secretToken = "synthetic-turso-token";
    assert.throws(
      () => assertTursoStagingConfiguration({
        ...validTursoEnvironment,
        TURSO_STAGING_DATABASE_URL: secretUrl,
        TURSO_STAGING_AUTH_TOKEN: secretToken,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /production-secret|synthetic-turso-token/);
        return /confirmed staging database identity/.test(error.message);
      },
    );
  });

  it("requires synthetic-data opt-in for Turso smoke tests", () => {
    assert.throws(
      () => assertTursoStagingConfiguration(validTursoEnvironment, true),
      /synthetic-data confirmations/,
    );
  });

  it("does not fall back to generic production Turso credentials", () => {
    assert.throws(
      () => assertTursoStagingConfiguration({
        ...validTursoEnvironment,
        TURSO_STAGING_DATABASE_URL: undefined,
        TURSO_STAGING_AUTH_TOKEN: undefined,
        TURSO_DATABASE_URL: validTursoEnvironment.TURSO_STAGING_DATABASE_URL,
        TURSO_AUTH_TOKEN: validTursoEnvironment.TURSO_STAGING_AUTH_TOKEN,
      }),
      /Turso staging credentials are required/,
    );
  });

  it("accepts only the confirmed synthetic Turso test target", () => {
    assert.deepEqual(
      assertTursoStagingConfiguration({
        ...validTursoEnvironment,
        TURSO_SMOKE_TEST: "I_CONFIRM_SYNTHETIC_DATA",
      }, true),
      {
        url: validTursoEnvironment.TURSO_STAGING_DATABASE_URL,
        authToken: validTursoEnvironment.TURSO_STAGING_AUTH_TOKEN,
      },
    );
  });

  it("requires a separate free cloud, Cloudinary storage, and explicit synthetic-data opt-in", () => {
    for (const override of [
      { STORAGE_PROVIDER: "mock" },
      { CLOUDINARY_STAGING_CLOUD_NAME: "hgtcizux" },
      { CLOUDINARY_STAGING_ISOLATED_ACCOUNT: undefined },
      { CLOUDINARY_SMOKE_TEST: undefined },
      { CLOUDINARY_STAGING_API_KEY: undefined },
      { CLOUDINARY_STAGING_API_SECRET: undefined },
    ]) {
      assert.throws(
        () => assertCloudinaryStagingConfiguration({
          ...validCloudinaryEnvironment,
          ...override,
        }),
        /Cloudinary staging requires/,
      );
    }
  });

  it("does not expose Cloudinary credentials in guard errors", () => {
    const secret = "synthetic-cloudinary-secret";
    assert.throws(
      () => assertCloudinaryStagingConfiguration({
        ...validCloudinaryEnvironment,
        STORAGE_PROVIDER: "production",
        CLOUDINARY_STAGING_API_SECRET: secret,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /synthetic-cloudinary-secret/);
        return /Cloudinary staging requires/.test(error.message);
      },
    );
  });

  it("does not fall back to generic production Cloudinary credentials", () => {
    assert.throws(
      () => assertCloudinaryStagingConfiguration({
        ...validCloudinaryEnvironment,
        CLOUDINARY_STAGING_API_KEY: undefined,
        CLOUDINARY_STAGING_API_SECRET: undefined,
        CLOUDINARY_API_KEY: validCloudinaryEnvironment.CLOUDINARY_STAGING_API_KEY,
        CLOUDINARY_API_SECRET: validCloudinaryEnvironment.CLOUDINARY_STAGING_API_SECRET,
      }),
      /Cloudinary staging requires/,
    );
  });
});

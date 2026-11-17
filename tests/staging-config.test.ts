import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertTursoMigrationConfirmation,
  assertCloudinaryStagingConfiguration,
  assertTursoStagingConfiguration,
  resolveTursoStagingMigrationTarget,
} from "../scripts/staging-config.ts";

const validTursoEnvironment = {
  CRUSHIFY_STAGING_PROFILE: "local",
  ENVIRONMENT: "staging",
  DATABASE_PROVIDER: "turso",
  TURSO_STAGING_DATABASE_URL: "libsql://crushify-preview-crushify.aws-ap-southeast-1.turso.io",
  TURSO_STAGING_AUTH_TOKEN: "synthetic-turso-token",
  TURSO_CONFIRM_DATABASE: "crushify-preview",
  TURSO_CONFIRM_GROUP: "crushify-preview",
  TURSO_CONFIRM_REGION: "Singapore",
  TURSO_CONFIRM_HOSTNAME: "crushify-preview-crushify.aws-ap-southeast-1.turso.io",
};

const validCloudinaryEnvironment = {
  CRUSHIFY_STAGING_PROFILE: "local",
  ENVIRONMENT: "staging",
  STORAGE_PROVIDER: "cloudinary",
  CLOUDINARY_STAGING_CLOUD_NAME: "crushify-staging-free",
  CLOUDINARY_PRODUCTION_CLOUD_NAME: "crushify-production-cloud",
  CLOUDINARY_STAGING_API_KEY: "synthetic-cloudinary-key",
  CLOUDINARY_STAGING_API_SECRET: "synthetic-cloudinary-secret",
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

  it("requires the exact Preview database, group, and Singapore region", () => {
    for (const override of [
      { TURSO_CONFIRM_DATABASE: "crushify-preview-other" },
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
      { VERCEL_ENV: "preview" },
      { VERCEL_ENV: "unknown" },
      { TURSO_DATABASE_URL: "libsql://production.example.turso.io" },
      { TURSO_AUTH_TOKEN: "synthetic-production-token" },
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

  it("allows Preview only for explicitly marked local preflight", () => {
    const previewEnvironment = {
      ...validTursoEnvironment,
      VERCEL_ENV: "preview",
    };

    assert.doesNotThrow(() => resolveTursoStagingMigrationTarget({
      ...previewEnvironment,
      CRUSHIFY_LOCAL_STAGING_PREFLIGHT: "1",
    }, "--preflight"));
    assert.throws(
      () => resolveTursoStagingMigrationTarget(previewEnvironment, "--preflight"),
      /local staging profile/,
    );
    assert.throws(
      () => resolveTursoStagingMigrationTarget({
        ...previewEnvironment,
        CRUSHIFY_LOCAL_STAGING_PREFLIGHT: "true",
      }, "--preflight"),
      /local staging profile/,
    );
    assert.throws(
      () => resolveTursoStagingMigrationTarget({
        ...previewEnvironment,
        CRUSHIFY_STAGING_PROFILE: "remote",
        CRUSHIFY_LOCAL_STAGING_PREFLIGHT: "1",
      }, "--preflight"),
      /local staging profile/,
    );
    assert.throws(
      () => resolveTursoStagingMigrationTarget({
        ...previewEnvironment,
        VERCEL_ENV: "production",
        CRUSHIFY_LOCAL_STAGING_PREFLIGHT: "1",
      }, "--preflight"),
      /local staging profile/,
    );
    assert.throws(
      () => resolveTursoStagingMigrationTarget({
        ...previewEnvironment,
        CRUSHIFY_LOCAL_STAGING_PREFLIGHT: "1",
        TURSO_MIGRATE_CONFIRM: "I_CONFIRM_APPLY_STAGING_MIGRATIONS",
      }, "--migrate"),
      /local staging profile/,
    );
    assert.doesNotThrow(() =>
      resolveTursoStagingMigrationTarget(validTursoEnvironment, "--preflight"));
    assert.doesNotThrow(() => resolveTursoStagingMigrationTarget({
      ...validTursoEnvironment,
      VERCEL_ENV: "development",
    }, "--preflight"));
    assert.throws(
      () => assertCloudinaryStagingConfiguration({
        ...validCloudinaryEnvironment,
        VERCEL_ENV: "preview",
        CRUSHIFY_LOCAL_STAGING_PREFLIGHT: "1",
      }),
      /local staging profile/,
    );
  });

  it("keeps Preview preflight identity and Production credential guards", () => {
    const previewEnvironment = {
      ...validTursoEnvironment,
      VERCEL_ENV: "preview",
      CRUSHIFY_LOCAL_STAGING_PREFLIGHT: "1",
    };

    for (const override of [
      { TURSO_CONFIRM_DATABASE: "other-database" },
      { TURSO_CONFIRM_GROUP: "other-group" },
      { TURSO_CONFIRM_REGION: "Frankfurt" },
      { DATABASE_PROVIDER: "d1" },
      { TURSO_CONFIRM_HOSTNAME: "crushify-preview-other.aws-ap-southeast-1.turso.io" },
      { TURSO_STAGING_DATABASE_URL: "libsql://crushify-preview-other.aws-ap-southeast-1.turso.io" },
      { TURSO_DATABASE_URL: "libsql://production.example.turso.io" },
      { TURSO_AUTH_TOKEN: "synthetic-production-token" },
    ]) {
      assert.throws(
        () => resolveTursoStagingMigrationTarget({
          ...previewEnvironment,
          ...override,
        }, "--preflight"),
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

  it("accepts only the confirmed Preview hostname", () => {
    for (const override of [
      { TURSO_CONFIRM_HOSTNAME: undefined },
      { TURSO_CONFIRM_HOSTNAME: "crushify-preview-other.aws-ap-southeast-1.turso.io" },
      { TURSO_STAGING_DATABASE_URL: "libsql://crushify-preview-other.aws-ap-southeast-1.turso.io" },
      {
        TURSO_STAGING_DATABASE_URL: "libsql://crushify-preview-crushify.aws-us-east-1.turso.io",
        TURSO_CONFIRM_HOSTNAME: "crushify-preview-crushify.aws-us-east-1.turso.io",
      },
      {
        TURSO_STAGING_DATABASE_URL: "libsql://crushify-preview-crushify.aws-ap-southeast-1.turso.io.evil",
        TURSO_CONFIRM_HOSTNAME: "crushify-preview-crushify.aws-ap-southeast-1.turso.io.evil",
      },
      {
        TURSO_STAGING_DATABASE_URL: "libsql://crushify-preview-crushify.aws-ap-southeast-1.example",
        TURSO_CONFIRM_HOSTNAME: "crushify-preview-crushify.aws-ap-southeast-1.example",
      },
      {
        TURSO_STAGING_DATABASE_URL: "libsql://crushify-production-crushify.aws-ap-southeast-1.turso.io",
        TURSO_CONFIRM_HOSTNAME: "crushify-production-crushify.aws-ap-southeast-1.turso.io",
      },
      { TURSO_STAGING_DATABASE_URL: "libsql://crushify-preview-crushify.aws-ap-southeast-1.turso.io/path" },
      { TURSO_STAGING_DATABASE_URL: "libsql://crushify-preview-crushify.aws-ap-southeast-1.turso.io:443" },
      { TURSO_STAGING_DATABASE_URL: " libsql://crushify-preview-crushify.aws-ap-southeast-1.turso.io" },
    ]) {
      assert.throws(
        () => assertTursoStagingConfiguration({
          ...validTursoEnvironment,
          ...override,
        }),
        /confirmed staging database identity|hostname confirmation|credentials are required/,
      );
    }

    assert.deepEqual(
      assertTursoStagingConfiguration(validTursoEnvironment),
      {
        url: validTursoEnvironment.TURSO_STAGING_DATABASE_URL,
        authToken: validTursoEnvironment.TURSO_STAGING_AUTH_TOKEN,
      },
    );
  });

  it("requires staging-only credentials and an unambiguous Vercel scope", () => {
    for (const override of [
      { TURSO_STAGING_DATABASE_URL: undefined },
      { TURSO_STAGING_AUTH_TOKEN: undefined },
      { TURSO_DATABASE_URL: "libsql://production.example.turso.io" },
      { TURSO_AUTH_TOKEN: "synthetic-production-token" },
      { VERCEL_ENV: "production" },
      { VERCEL_ENV: "preview" },
    ]) {
      assert.throws(
        () => assertTursoStagingConfiguration({
          ...validTursoEnvironment,
          ...override,
        }),
        /staging profile|credentials|identity/,
      );
    }
  });

  it("validates migration preflight configuration without connecting to Turso", () => {
    assert.deepEqual(
      resolveTursoStagingMigrationTarget(validTursoEnvironment, "--preflight"),
      {
        url: validTursoEnvironment.TURSO_STAGING_DATABASE_URL,
        authToken: validTursoEnvironment.TURSO_STAGING_AUTH_TOKEN,
      },
    );
    assert.throws(
      () => resolveTursoStagingMigrationTarget({
        ...validTursoEnvironment,
        VERCEL_ENV: "production",
      }, "--preflight"),
      /cannot run in Vercel Production/,
    );
    assert.throws(
      () => resolveTursoStagingMigrationTarget({
        ...validTursoEnvironment,
        TURSO_STAGING_DATABASE_URL: undefined,
      }, "--preflight"),
      /credentials are required/,
    );
    assert.throws(
      () => resolveTursoStagingMigrationTarget({
        ...validTursoEnvironment,
        TURSO_CONFIRM_HOSTNAME: "crushify-preview-unverified.aws-ap-southeast-1.turso.io",
      }, "--preflight"),
      /confirmed staging database identity/,
    );
    assert.throws(
      () => resolveTursoStagingMigrationTarget(validTursoEnvironment, "--migrate"),
      /explicit TURSO_MIGRATE_CONFIRM confirmation/,
    );
    assert.throws(
      () => resolveTursoStagingMigrationTarget(
        validTursoEnvironment,
        "--invalid",
      ),
      /migration mode must be explicit/,
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
      /cannot run in Vercel Production|Production credentials/,
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

  it("requires a distinct dedicated Cloudinary staging identity and synthetic-data opt-in", () => {
    for (const override of [
      { STORAGE_PROVIDER: "mock" },
      { CLOUDINARY_STAGING_CLOUD_NAME: "CRUSHIFY-PRODUCTION-CLOUD" },
      { CLOUDINARY_PRODUCTION_CLOUD_NAME: undefined },
      { CLOUDINARY_SMOKE_TEST: undefined },
      { CLOUDINARY_STAGING_API_KEY: undefined },
      { CLOUDINARY_STAGING_API_SECRET: undefined },
    ]) {
      assert.throws(
        () => assertCloudinaryStagingConfiguration({
          ...validCloudinaryEnvironment,
          ...override,
        }),
        /Cloudinary staging/,
      );
    }
    assert.deepEqual(assertCloudinaryStagingConfiguration(validCloudinaryEnvironment), {
      cloudName: validCloudinaryEnvironment.CLOUDINARY_STAGING_CLOUD_NAME,
      apiKey: validCloudinaryEnvironment.CLOUDINARY_STAGING_API_KEY,
      apiSecret: validCloudinaryEnvironment.CLOUDINARY_STAGING_API_SECRET,
    });
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
        return /Cloudinary staging/.test(error.message);
      },
    );
  });

  it("does not accept a self-declared isolation confirmation", () => {
    assert.throws(
      () => assertCloudinaryStagingConfiguration({
        ...validCloudinaryEnvironment,
        CLOUDINARY_PRODUCTION_CLOUD_NAME: undefined,
        CLOUDINARY_STAGING_ISOLATED_ACCOUNT: "I_CONFIRM_SEPARATE_FREE_CLOUD",
      }),
      /Cloudinary staging/,
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
      /Cloudinary staging/,
    );
  });
});

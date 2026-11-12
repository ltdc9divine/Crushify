import {
  CloudinaryConfigurationError,
  resolveCloudinaryConfiguration,
} from "../src/storage/cloudinary-policy.ts";

type Environment = Record<string, string | undefined>;

export class StagingConfigurationError extends Error {}

const expectedDatabase = "crushify-staging";
const expectedGroup = "crushify-staging-sg";
const expectedRegion = "Singapore";
const stagingDatabaseHostname = /^crushify-staging-[a-z0-9-]+\.turso\.io$/i;

export function assertTursoMigrationConfirmation(environment: Environment): void {
  if (environment.TURSO_MIGRATE_CONFIRM !== "I_CONFIRM_APPLY_STAGING_MIGRATIONS") {
    throw new StagingConfigurationError(
      "Staging migrations require explicit TURSO_MIGRATE_CONFIRM confirmation",
    );
  }
}

function assertStagingEnvironment(environment: Environment): void {
  if (environment.CRUSHIFY_STAGING_PROFILE !== "local" ||
      environment.ENVIRONMENT !== "staging" ||
      environment.VERCEL_ENV === "production") {
    throw new StagingConfigurationError(
      "Staging operations require the local staging profile and cannot run in Vercel Production",
    );
  }
}

export function assertTursoStagingConfiguration(
  environment: Environment,
  requireSyntheticOptIn = false,
): { url: string; authToken: string } {
  assertStagingEnvironment(environment);
  if (environment.DATABASE_PROVIDER !== "turso" ||
      environment.TURSO_CONFIRM_DATABASE !== expectedDatabase ||
      environment.TURSO_CONFIRM_GROUP !== expectedGroup ||
      environment.TURSO_CONFIRM_REGION !== expectedRegion ||
      (requireSyntheticOptIn &&
        environment.TURSO_SMOKE_TEST !== "I_CONFIRM_SYNTHETIC_DATA")) {
    throw new StagingConfigurationError(
      "Turso staging operation requires the exact database, group, region, and synthetic-data confirmations",
    );
  }

  const rawUrl = environment.TURSO_STAGING_DATABASE_URL;
  const authToken = environment.TURSO_STAGING_AUTH_TOKEN;
  if (!rawUrl || !authToken?.trim()) {
    throw new StagingConfigurationError("Turso staging credentials are required");
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new StagingConfigurationError("Turso URL does not match the confirmed staging database identity");
  }
  if (url.protocol !== "libsql:" ||
      url.username || url.password || url.search || url.hash ||
      !stagingDatabaseHostname.test(url.hostname)) {
    throw new StagingConfigurationError("Turso URL does not match the confirmed staging database identity");
  }

  return { url: url.toString(), authToken };
}

export function assertCloudinaryStagingConfiguration(
  environment: Environment,
): { cloudName: string; apiKey: string; apiSecret: string } {
  assertStagingEnvironment(environment);
  if (environment.STORAGE_PROVIDER !== "cloudinary" ||
      environment.CLOUDINARY_SMOKE_TEST !== "I_CONFIRM_SYNTHETIC_DATA") {
    throw new StagingConfigurationError(
      "Cloudinary staging requires the cloudinary provider and explicit synthetic-data opt-in",
    );
  }

  try {
    return resolveCloudinaryConfiguration({
      ...environment,
      ENVIRONMENT: "staging",
    });
  } catch (error) {
    if (error instanceof CloudinaryConfigurationError) {
      throw new StagingConfigurationError(
        "Cloudinary staging is disabled until account isolation is independently verified",
      );
    }
    throw error;
  }
}

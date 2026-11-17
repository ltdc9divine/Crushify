import {
  CloudinaryConfigurationError,
  resolveCloudinaryConfiguration,
} from "../src/storage/cloudinary-policy.ts";

type Environment = Record<string, string | undefined>;

export class StagingConfigurationError extends Error {}

const expectedDatabase = "crushify-preview";
const expectedGroup = "crushify-preview";
const expectedRegion = "Singapore";
const expectedHostname = "crushify-preview-crushify.aws-ap-southeast-1.turso.io";

export function assertTursoMigrationConfirmation(environment: Environment): void {
  if (environment.TURSO_MIGRATE_CONFIRM !== "I_CONFIRM_APPLY_STAGING_MIGRATIONS") {
    throw new StagingConfigurationError(
      "Staging migrations require explicit TURSO_MIGRATE_CONFIRM confirmation",
    );
  }
}

function assertStagingEnvironment(
  environment: Environment,
  allowLocalPreviewPreflight = false,
): void {
  const isLocalPreviewPreflight = allowLocalPreviewPreflight &&
    environment.VERCEL_ENV === "preview" &&
    environment.CRUSHIFY_LOCAL_STAGING_PREFLIGHT === "1" &&
    environment.CRUSHIFY_STAGING_PROFILE === "local";
  if (environment.CRUSHIFY_STAGING_PROFILE !== "local" ||
      environment.ENVIRONMENT !== "staging" ||
      (environment.VERCEL_ENV !== undefined &&
        environment.VERCEL_ENV !== "development" &&
        !isLocalPreviewPreflight) ||
      environment.TURSO_DATABASE_URL !== undefined ||
      environment.TURSO_AUTH_TOKEN !== undefined) {
    throw new StagingConfigurationError(
      "Staging operations require an unambiguous local staging profile and cannot run in Vercel Production or with Production credentials",
    );
  }
}

function assertTursoStagingConfigurationInternal(
  environment: Environment,
  requireSyntheticOptIn: boolean,
  allowLocalPreviewPreflight: boolean,
): { url: string; authToken: string } {
  assertStagingEnvironment(environment, allowLocalPreviewPreflight);
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
  const rawConfirmedHostname = environment.TURSO_CONFIRM_HOSTNAME;
  if (!rawUrl || rawUrl.trim() !== rawUrl || !authToken?.trim()) {
    throw new StagingConfigurationError("Turso staging credentials are required");
  }
  if (!rawConfirmedHostname || rawConfirmedHostname !== rawConfirmedHostname.trim()) {
    throw new StagingConfigurationError("Exact staging hostname confirmation is required");
  }
  const confirmedHostname = rawConfirmedHostname.trim().toLowerCase();

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new StagingConfigurationError("Turso URL does not match the confirmed staging database identity");
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "libsql:" ||
      url.username || url.password || url.port || url.search || url.hash ||
      (url.pathname && url.pathname !== "/") ||
      hostname !== expectedHostname ||
      hostname !== confirmedHostname) {
    throw new StagingConfigurationError("Turso URL does not match the confirmed staging database identity");
  }

  return { url: url.toString(), authToken };
}

export function assertTursoStagingConfiguration(
  environment: Environment,
  requireSyntheticOptIn = false,
): { url: string; authToken: string } {
  return assertTursoStagingConfigurationInternal(environment, requireSyntheticOptIn, false);
}

export function resolveTursoStagingMigrationTarget(
  environment: Environment,
  mode: string,
): { url: string; authToken: string } {
  if (mode !== "--preflight" && mode !== "--migrate") {
    throw new StagingConfigurationError("Turso staging migration mode must be explicit");
  }
  if (mode === "--migrate") assertTursoMigrationConfirmation(environment);
  return assertTursoStagingConfigurationInternal(
    environment,
    false,
    mode === "--preflight",
  );
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

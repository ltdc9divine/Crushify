export type DeploymentEnvironment = "local" | "staging" | "production";

export function classifyVercelEnvironment(
  vercelEnvironment: string | undefined,
  environment: string | undefined,
): DeploymentEnvironment | null {
  if (vercelEnvironment === "development") {
    return environment === undefined || environment === "local" ? "local" : null;
  }
  if (vercelEnvironment === "preview") {
    return environment === "staging" ? "staging" : null;
  }
  if (vercelEnvironment === "production") {
    return environment === undefined || environment === "production" ? "production" : null;
  }
  return null;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function isLocalHostname(hostname: string): boolean {
  return isLoopbackHost(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".test");
}

function validHostname(hostname: string): boolean {
  if (hostname === "[::1]") return true;
  if (hostname.length > 253 || hostname.endsWith(".") || hostname.includes("..")) return false;
  return hostname.split(".").every((label) =>
    label.length > 0 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}

export function normalizeEnvironmentOrigin(
  value: string,
  environment: DeploymentEnvironment,
): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.origin !== value ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        !validHostname(parsed.hostname)) {
      return null;
    }

    if (environment === "local") {
      if (!isLocalHostname(parsed.hostname)) return null;
      if (parsed.protocol === "https:") return parsed.origin;
      if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) {
        return parsed.origin;
      }
      return null;
    }

    return parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function vercelHostOrigin(value: string | undefined): string | null {
  if (!value || value.trim() !== value || /[/:?#@]/.test(value)) return null;
  return normalizeEnvironmentOrigin(`https://${value}`, "production");
}

export function workerRequestEnvironment(
  environment: string | undefined,
  requestUrl: string,
): DeploymentEnvironment | null {
  if (environment === "production") return "production";
  if (environment === "staging") return "staging";
  if (environment !== "local") return null;

  try {
    const parsed = new URL(requestUrl);
    return isLoopbackHost(parsed.hostname) &&
        normalizeEnvironmentOrigin(parsed.origin, "local")
      ? "local"
      : null;
  } catch {
    return null;
  }
}

export function isLoopbackOrigin(value: string): boolean {
  try {
    return isLoopbackHost(new URL(value).hostname);
  } catch {
    return false;
  }
}

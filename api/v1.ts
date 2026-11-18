import type { IncomingMessage, ServerResponse } from "node:http";
import handler from "./[...path].ts";
import { apiError } from "../src/http.ts";

const DISPATCH_PARAMETER = "__crushify_path";

export function resolveVersionedApiPath(url: string): string | null {
  const parsed = new URL(url, "https://vercel.invalid");
  const paths = parsed.searchParams.getAll(DISPATCH_PARAMETER);
  if (paths.length === 0) {
    return `${parsed.pathname}${parsed.search}`;
  }
  if (paths.length !== 1) return null;

  const path = paths[0];
  if (!path || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(path)) return null;
  parsed.searchParams.delete(DISPATCH_PARAMETER);
  const query = parsed.searchParams.toString();
  return `/api/v1/${path}${query ? `?${query}` : ""}`;
}

export const config = {
  api: { bodyParser: false },
  maxDuration: 60,
};

export default function versionedApiHandler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const path = resolveVersionedApiPath(request.url ?? "/");
  if (!path) {
    const requestId = crypto.randomUUID();
    const invalid = apiError(requestId, 400, "INVALID_REQUEST", "Request path is invalid");
    response.statusCode = invalid.status;
    invalid.headers.forEach((value, name) => response.setHeader(name, value));
    return invalid.text().then((body) => {
      response.end(body);
    });
  }
  request.url = path;
  return handler(request, response);
}

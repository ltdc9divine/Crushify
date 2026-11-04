import type { ApiErrorBody } from "./types.ts";

export const MAX_JSON_BYTES = 64 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function jsonResponse(
  body: unknown,
  status: number,
  requestId: string,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Request-ID", requestId);
  headers.set("Referrer-Policy", "no-referrer");
  return Response.json(body, { status, headers });
}

export function apiError(
  requestId: string,
  status: number,
  code: string,
  message: string,
  fields?: Record<string, string>,
): Response {
  const body: ApiErrorBody & { error: ApiErrorBody["error"] & { fields?: Record<string, string> } } = {
    error: fields ? { code, message, fields } : { code, message },
    request_id: requestId,
  };
  return jsonResponse(body, status, requestId);
}

export async function readJson(
  request: Request,
  requestId: string,
): Promise<{ value?: unknown; response?: Response }> {
  const contentType = request.headers.get("content-type")?.split(";")[0].trim();
  if (contentType !== "application/json") {
    return {
      response: apiError(requestId, 415, "UNSUPPORTED_MEDIA_TYPE", "Expected application/json"),
    };
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_JSON_BYTES) {
    return {
      response: apiError(requestId, 413, "PAYLOAD_TOO_LARGE", "Request body is too large"),
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = await readBoundedBody(request, MAX_JSON_BYTES);
  } catch (error) {
    const tooLarge = error instanceof RangeError;
    return {
      response: apiError(
        requestId,
        tooLarge ? 413 : 400,
        tooLarge ? "PAYLOAD_TOO_LARGE" : "INVALID_BODY",
        tooLarge ? "Request body is too large" : "Could not read request body",
      ),
    };
  }

  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } catch {
    return {
      response: apiError(requestId, 400, "INVALID_JSON", "Request body must be valid JSON"),
    };
  }
}

export async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new RangeError("Request body exceeds limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function randomToken(bytes = 32): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", owned.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function getCookie(request: Request, name: string): string | null {
  const cookies = request.headers.get("cookie");
  if (!cookies) return null;
  for (const item of cookies.split(";")) {
    const [key, ...value] = item.trim().split("=");
    if (key === name) return value.join("=") || null;
  }
  return null;
}

export function isAllowedOrigin(request: Request, appOrigin: string): boolean {
  return request.headers.get("origin") === appOrigin;
}

export function safeId(): string {
  return crypto.randomUUID();
}

import type { IncomingMessage, ServerResponse } from "node:http";
import { apiError, MAX_IMAGE_BYTES, MAX_JSON_BYTES } from "../src/http.ts";
import {
  createVercelApiHandler,
  resolveVercelOrigin,
  VERCEL_UPLOAD_MAX_BYTES,
} from "../src/platform/vercel.ts";

const supportedMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const apiHandler = createVercelApiHandler(process.env);

export const config = {
  api: { bodyParser: false },
  maxDuration: 60,
};

class RequestBodyError extends Error {
  readonly status: 400 | 408 | 413;

  constructor(status: 400 | 408 | 413, message: string) {
    super(message);
    this.status = status;
  }
}

export async function readVercelRequestBody(
  request: IncomingMessage,
  maxBytes: number,
  timeoutMs = 30_000,
): Promise<Uint8Array> {
  const collect = async (): Promise<Uint8Array> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > maxBytes) throw new RequestBodyError(413, "Request body is too large");
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, size);
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      request.pause();
      reject(new RequestBodyError(408, "Request body timed out"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([collect(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || name === "host" || name === "cf-connecting-ip" || name === "content-length" ||
        name === "transfer-encoding" || name === "connection") continue;
    headers.set(name, Array.isArray(value) ? value.join(name === "cookie" ? "; " : ", ") : value);
  }
  return headers;
}

async function writeResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") target.setHeader(name, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) target.setHeader("Set-Cookie", cookies);
  if (response.body) {
    target.end(Buffer.from(await response.arrayBuffer()));
  } else {
    target.end();
  }
}

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const method = request.method?.toUpperCase() ?? "GET";
  const path = request.url ?? "/";
  const requestId = crypto.randomUUID();

  if (!supportedMethods.has(method)) {
    await writeResponse(apiError(requestId, 405, "METHOD_NOT_ALLOWED", "Method not allowed"), response);
    return;
  }
  if (!path.startsWith("/") || path.startsWith("//")) {
    await writeResponse(apiError(requestId, 400, "INVALID_REQUEST", "Request path is invalid"), response);
    return;
  }

  const headers = requestHeaders(request);
  let body: Uint8Array | undefined;
  const bodyMethod = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
  if (bodyMethod && (request.headers["content-length"] !== undefined ||
      request.headers["transfer-encoding"] !== undefined)) {
    const binaryUpload = method === "PUT" && /^\/api\/v1\/assets\/[0-9a-f-]{36}\/content(?:\?|$)/i.test(path);
    const maxBytes = binaryUpload
      ? Math.min(MAX_IMAGE_BYTES, VERCEL_UPLOAD_MAX_BYTES)
      : MAX_JSON_BYTES;
    const declaredLength = Number(request.headers["content-length"] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await writeResponse(apiError(requestId, 413, "PAYLOAD_TOO_LARGE", "Request body is too large"), response);
      return;
    }
    try {
      body = await readVercelRequestBody(request, maxBytes);
    } catch (error) {
      const bodyError = error instanceof RequestBodyError
        ? error
        : new RequestBodyError(400, "Could not read request body");
      const code = bodyError.status === 413 ? "PAYLOAD_TOO_LARGE" :
        bodyError.status === 408 ? "REQUEST_TIMEOUT" : "INVALID_BODY";
      if (bodyError.status === 408) {
        request.pause();
        response.shouldKeepAlive = false;
        response.setHeader("Connection", "close");
        response.once("finish", () => request.destroy());
      }
      try {
        await writeResponse(apiError(requestId, bodyError.status, code, bodyError.message), response);
      } catch {
        request.destroy();
        response.destroy();
      }
      return;
    }
  } else if (!bodyMethod && (
    Number(request.headers["content-length"] ?? 0) > 0 ||
    request.headers["transfer-encoding"] !== undefined
  )) {
    await writeResponse(apiError(requestId, 400, "INVALID_REQUEST", "This method cannot include a request body"), response);
    return;
  }

  const localRequestOrigin = process.env.VERCEL_ENV === "development" &&
      typeof request.headers.host === "string"
    ? `http://${request.headers.host}`
    : undefined;
  const requestOrigin = resolveVercelOrigin(process.env, localRequestOrigin) ?? "https://vercel.invalid";
  const url = new URL(path, requestOrigin);
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (body && body.byteLength > 0) {
    const ownedBody = new Uint8Array(body.byteLength);
    ownedBody.set(body);
    init.body = ownedBody.buffer;
  }
  if (init.body) init.duplex = "half";

  try {
    await writeResponse(await apiHandler(new Request(url, init)), response);
  } catch {
    console.error("Vercel request adapter failed", { request_id: requestId });
    if (!response.headersSent) {
      await writeResponse(apiError(requestId, 500, "INTERNAL_ERROR", "Request could not be completed"), response);
    } else {
      response.destroy();
    }
  }
}

import { apiError, getCookie, isAllowedOrigin, jsonResponse, nowIso, randomToken, readJson, safeId, sha256 } from "./http.ts";
import { logSafeError, logSafeInfo } from "./logging.ts";
import { normalizeEnvironmentOrigin } from "./platform/environment.ts";
import type { Env, Session } from "./types.ts";

const SESSION_COOKIE = "crushify_session";
const CSRF_COOKIE = "crushify_csrf";
const SESSION_SECONDS = 60 * 60 * 24 * 14;
const LOGIN_SECONDS = 60 * 15;

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailService {
  send(message: EmailMessage): Promise<void>;
}

class LocalTestingEmailService implements EmailService {
  private readonly sink?: (message: EmailMessage) => Promise<void>;
  private readonly sinkUrl?: string;

  constructor(
    sink?: (message: EmailMessage) => Promise<void>,
    sinkUrl?: string,
  ) {
    this.sink = sink;
    this.sinkUrl = sinkUrl;
  }

  async send(message: EmailMessage): Promise<void> {
    if (this.sink) {
      await this.sink(message);
      return;
    }
    if (this.sinkUrl) {
      const response = await fetch(this.sinkUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
      });
      if (!response.ok) throw new Error(`Local email sink returned ${response.status}`);
      return;
    }
    logSafeInfo("email.local_sink_discarded", "email", { environment: "local" });
  }
}

class PreviewDiscardEmailService implements EmailService {
  async send(_message: EmailMessage): Promise<void> {
    logSafeInfo("email.preview_sink_discarded", "email", { environment: "staging" });
  }
}

class BoundEmailService implements EmailService {
  private readonly binding: Fetcher;
  private readonly authorizationToken: string;

  constructor(binding: Fetcher, authorizationToken: string) {
    this.binding = binding;
    this.authorizationToken = authorizationToken;
  }

  async send(message: EmailMessage): Promise<void> {
    const response = await this.binding.fetch("https://mailer.internal/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.authorizationToken}`,
      },
      body: JSON.stringify(message),
    });
    if (!response.ok) throw new Error(`Mail service returned ${response.status}`);
  }
}

class ResendEmailService implements EmailService {
  private readonly apiKey: string;
  private readonly fromEmail: string;

  constructor(apiKey: string, fromEmail: string) {
    this.apiKey = apiKey;
    this.fromEmail = fromEmail;
  }

  async send(message: EmailMessage): Promise<void> {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        from: this.fromEmail,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
    });
    if (!response.ok) throw new Error(`Resend returned ${response.status}`);
  }
}

export function createEmailService(env: Env, _origin: string): EmailService | null {
  if (env.ENVIRONMENT === "staging") {
    return env.PREVIEW_EMAIL_SINK === "discard"
      ? new PreviewDiscardEmailService()
      : null;
  }
  const isLocalTest = env.LOCAL_TEST_MODE === "true" &&
    env.ENVIRONMENT === "local";
  if (isLocalTest) {
    const sinkUrl = env.LOCAL_TEST_MAIL_SINK_URL;
    if (sinkUrl) {
      let parsed: URL;
      try {
        parsed = new URL(sinkUrl);
      } catch {
        return null;
      }
      if (parsed.protocol !== "http:" ||
          !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
          !parsed.port || parsed.pathname !== "/__crushify_test_email_sink" ||
          parsed.username || parsed.password || parsed.search || parsed.hash) {
        return null;
      }
    }
    return new LocalTestingEmailService(env.LOCAL_TEST_EMAIL_SINK, sinkUrl);
  }
  if (env.ENVIRONMENT !== "production") return null;
  if (env.MAIL_PROVIDER === "resend" && env.MAIL_API_KEY && env.MAIL_FROM_EMAIL) {
    return new ResendEmailService(env.MAIL_API_KEY, env.MAIL_FROM_EMAIL);
  }
  if (env.MAILER && env.MAILER_AUTH_TOKEN) {
    return new BoundEmailService(env.MAILER, env.MAILER_AUTH_TOKEN);
  }
  return null;
}

function isLocalTestMode(env: Env): boolean {
  return env.LOCAL_TEST_MODE === "true" && env.ENVIRONMENT === "local";
}

function getAppOrigin(request: Request, env: Env): string | null {
  const runtime = env.ENVIRONMENT;
  if (runtime !== "local" && runtime !== "staging" && runtime !== "production") return null;
  const configured = env.APP_ORIGIN;
  if (configured) {
    return normalizeEnvironmentOrigin(configured, runtime);
  }
  if (runtime !== "local" || !isLocalTestMode(env)) return null;
  try {
    return normalizeEnvironmentOrigin(new URL(request.url).origin, "local");
  } catch {
    return null;
  }
}

function cookieOptions(env: Env, maxAge: number): string {
  const secure = isLocalTestMode(env) ? "" : "; Secure";
  return `Path=/api/v1; HttpOnly${secure}; SameSite=Lax; Max-Age=${maxAge}`;
}

function csrfCookieOptions(env: Env, maxAge: number): string {
  const secure = isLocalTestMode(env) ? "" : "; Secure";
  return `Path=/api/v1${secure}; SameSite=Lax; Max-Age=${maxAge}`;
}

async function applyRateLimit(
  env: Env,
  key: string,
  now: number,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const keyHash = await sha256(key);
  await env.DB.prepare(
    `INSERT INTO auth_rate_limits (key_hash, window_started_at, request_count)
     VALUES (?, ?, 1)
     ON CONFLICT(key_hash) DO UPDATE SET
       request_count = CASE
         WHEN excluded.window_started_at - auth_rate_limits.window_started_at >= ? THEN 1
         ELSE auth_rate_limits.request_count + 1
       END,
       window_started_at = CASE
         WHEN excluded.window_started_at - auth_rate_limits.window_started_at >= ?
         THEN excluded.window_started_at
         ELSE auth_rate_limits.window_started_at
       END`,
  ).bind(keyHash, now, windowSeconds, windowSeconds).run();
  const row = await env.DB.prepare(
    "SELECT request_count FROM auth_rate_limits WHERE key_hash = ?",
  ).bind(keyHash).first<{ request_count: number }>();
  return (row?.request_count ?? limit + 1) <= limit;
}

export async function getSession(request: Request, env: Env): Promise<Session | null> {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const now = nowIso();
  const row = await env.DB.prepare(
    `SELECT s.id, s.customer_id, s.csrf_token_hash
     FROM customer_sessions s
     JOIN customers c ON c.id = s.customer_id
     WHERE s.token_hash = ? AND s.revoked_at IS NULL
       AND s.expires_at > ? AND c.status = 'ACTIVE'`,
  ).bind(tokenHash, now).first<{
    id: string;
    customer_id: string;
    csrf_token_hash: string;
  }>();
  if (!row) return null;
  await env.DB.prepare("UPDATE customer_sessions SET last_used_at = ? WHERE id = ?")
    .bind(now, row.id).run();
  return { id: row.id, customerId: row.customer_id, csrfTokenHash: row.csrf_token_hash };
}

export async function requireSession(
  request: Request,
  env: Env,
  requestId: string,
): Promise<{ session?: Session; response?: Response }> {
  const session = await getSession(request, env);
  if (!session) {
    return { response: apiError(requestId, 401, "UNAUTHENTICATED", "Sign-in required") };
  }
  return { session };
}

export async function requireCsrf(
  request: Request,
  env: Env,
  session: Session,
  requestId: string,
): Promise<Response | null> {
  const origin = getAppOrigin(request, env);
  const cookie = getCookie(request, CSRF_COOKIE);
  const header = request.headers.get("x-csrf-token");
  if (!origin || !isAllowedOrigin(request, origin) || !cookie || !header ||
      cookie !== header || await sha256(cookie) !== session.csrfTokenHash) {
    return apiError(requestId, 403, "CSRF_REJECTED", "Request verification failed");
  }
  return null;
}

export async function handleSessionRoutes(
  request: Request,
  env: Env,
  path: string,
  requestId: string,
): Promise<Response | null> {
  if (path === "/api/v1/customers/session" && request.method === "POST") {
    const parsed = await readJson(request, requestId);
    if (parsed.response) return parsed.response;
    if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value) ||
        Object.keys(parsed.value).some((key) => key !== "email" && key !== "return_to") ||
        typeof (parsed.value as { email?: unknown }).email !== "string" ||
        (Object.hasOwn(parsed.value, "return_to") &&
          typeof (parsed.value as { return_to?: unknown }).return_to !== "string")) {
      return apiError(requestId, 400, "VALIDATION_ERROR", "A valid email is required");
    }

    const body = parsed.value as { email: string; return_to?: string };
    const returnTo = body.return_to ?? "/templates/our-universe/";
    if (!/^\/templates\/(our-universe|love-letter|our-memories|say-yes|distance-means-nothing)\/(?:\?design=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?$/i.test(returnTo)) {
      return apiError(requestId, 400, "VALIDATION_ERROR", "A valid template return path is required");
    }
    const email = body.email.trim();
    const emailNormalized = email.toLocaleLowerCase("en-US");
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return apiError(requestId, 400, "VALIDATION_ERROR", "A valid email is required");
    }
    const now = Math.floor(Date.now() / 1000);
    const ip = request.headers.get("cf-connecting-ip") ??
      request.headers.get("x-vercel-forwarded-for") ?? "local";
    const ipAllowed = await applyRateLimit(env, `login-ip:${ip}`, now, 10, 600);
    const emailAllowed = await applyRateLimit(env, `login-email:${emailNormalized}`, now, 3, 900);
    if (!ipAllowed || !emailAllowed) {
      return jsonResponse({ message: "If the address can be used, a sign-in link has been sent." }, 202, requestId);
    }

    const origin = getAppOrigin(request, env);
    const mailer = origin ? createEmailService(env, origin) : null;
    if (!origin || !mailer) {
      return apiError(requestId, 503, "EMAIL_UNAVAILABLE", "Email sign-in is not configured");
    }

    const nowText = new Date(now).toISOString();
    const customerId = safeId();
    await env.DB.prepare(
      `INSERT INTO customers (id, email, email_normalized, status, created_at, updated_at)
       VALUES (?, ?, ?, 'ACTIVE', ?, ?)
       ON CONFLICT(email_normalized) DO NOTHING`,
    ).bind(customerId, email, emailNormalized, nowText, nowText).run();
    const customer = await env.DB.prepare(
      "SELECT id, status FROM customers WHERE email_normalized = ?",
    ).bind(emailNormalized).first<{ id: string; status: string }>();
    if (!customer || customer.status !== "ACTIVE") {
      return jsonResponse({ message: "If the address can be used, a sign-in link has been sent." }, 202, requestId);
    }

    const token = randomToken();
    const tokenHash = await sha256(token);
    const expiresAt = new Date((now + LOGIN_SECONDS) * 1000).toISOString();
    await env.DB.prepare(
      `INSERT INTO login_tokens (id, customer_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(safeId(), customer.id, tokenHash, expiresAt, nowText).run();
    const link = new URL(returnTo, origin);
    link.hash = new URLSearchParams({ magic_token: token }).toString();
    try {
      await mailer.send({
        to: email,
        subject: "Đăng nhập Crushify",
        text: `Mở liên kết này để đăng nhập. Liên kết hết hạn sau 15 phút: ${link.toString()}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:32px auto;padding:32px;border:1px solid #f3d9e8;border-radius:20px;color:#33202c"><div style="color:#e94a9c;font-weight:700;letter-spacing:.18em">CRUSHIFY</div><h1 style="font-size:26px">Đăng nhập vào Crushify</h1><p>Nhấn nút bên dưới để tiếp tục tạo món quà số của bạn. Liên kết chỉ dùng một lần và sẽ hết hạn sau 15 phút.</p><p style="margin:28px 0"><a href="${link.toString()}" style="display:inline-block;padding:13px 22px;border-radius:999px;background:#e94a9c;color:white;text-decoration:none;font-weight:700">Đăng nhập an toàn</a></p><p style="font-size:13px;color:#786873">Nếu bạn không yêu cầu liên kết này, hãy bỏ qua email.</p></div>`,
      });
    } catch (error) {
      await env.DB.prepare("DELETE FROM login_tokens WHERE token_hash = ?").bind(tokenHash).run();
      logSafeError("auth.magic_link_delivery_failed", "email", error, {
        request_id: requestId,
        environment: env.ENVIRONMENT,
      });
      return apiError(requestId, 502, "EMAIL_DELIVERY_FAILED", "Could not deliver sign-in email");
    }
    return jsonResponse({ message: "If the address can be used, a sign-in link has been sent." }, 202, requestId);
  }

  if (path === "/api/v1/customers/session/verify" && request.method === "POST") {
    const parsed = await readJson(request, requestId);
    if (parsed.response) return parsed.response;
    if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value) ||
        Object.keys(parsed.value).length !== 1 || typeof (parsed.value as { token?: unknown }).token !== "string") {
      return apiError(requestId, 400, "VALIDATION_ERROR", "A sign-in token is required");
    }
    const ip = request.headers.get("cf-connecting-ip") ??
      request.headers.get("x-vercel-forwarded-for") ?? "local";
    if (!await applyRateLimit(env, `verify-ip:${ip}`, Math.floor(Date.now() / 1000), 20, 600)) {
      return apiError(requestId, 429, "RATE_LIMITED", "Too many verification attempts");
    }
    const token = (parsed.value as { token: string }).token;
    if (token.length > 100) return apiError(requestId, 400, "INVALID_TOKEN", "Sign-in token is invalid or expired");
    const tokenHash = await sha256(token);
    const now = nowIso();
    const consumed = await env.DB.prepare(
      `UPDATE login_tokens SET consumed_at = ?
       WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
       RETURNING customer_id`,
    ).bind(now, tokenHash, now).first<{ customer_id: string }>();
    if (!consumed) return apiError(requestId, 401, "INVALID_TOKEN", "Sign-in token is invalid or expired");

    const customer = await env.DB.prepare(
      "SELECT status FROM customers WHERE id = ?",
    ).bind(consumed.customer_id).first<{ status: string }>();
    if (!customer || customer.status !== "ACTIVE") {
      return apiError(requestId, 403, "FORBIDDEN", "Account is unavailable");
    }
    const rawSession = randomToken();
    const csrfToken = randomToken();
    const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO customer_sessions
         (id, customer_id, token_hash, csrf_token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(safeId(), consumed.customer_id, await sha256(rawSession), await sha256(csrfToken), expiresAt, now),
      env.DB.prepare(
        "UPDATE customers SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?",
      ).bind(now, now, consumed.customer_id),
    ]);

    const headers = new Headers();
    headers.append("Set-Cookie", `${SESSION_COOKIE}=${rawSession}; ${cookieOptions(env, SESSION_SECONDS)}`);
    headers.append("Set-Cookie", `${CSRF_COOKIE}=${csrfToken}; ${csrfCookieOptions(env, SESSION_SECONDS)}`);
    return jsonResponse(
      { authenticated: true, expires_at: expiresAt },
      200,
      requestId,
      headers,
    );
  }

  if (path === "/api/v1/customers/session" && request.method === "DELETE") {
    const required = await requireSession(request, env, requestId);
    if (required.response) return required.response;
    const csrfError = await requireCsrf(request, env, required.session!, requestId);
    if (csrfError) return csrfError;
    const now = nowIso();
    await env.DB.prepare("UPDATE customer_sessions SET revoked_at = ? WHERE id = ?")
      .bind(now, required.session!.id).run();
    const headers = new Headers();
    headers.append("Set-Cookie", `${SESSION_COOKIE}=; ${cookieOptions(env, 0)}`);
    headers.append("Set-Cookie", `${CSRF_COOKIE}=; ${csrfCookieOptions(env, 0)}`);
    return jsonResponse(
      { authenticated: false },
      200,
      requestId,
      headers,
    );
  }

  if (path === "/api/v1/customers/me" && request.method === "GET") {
    const required = await requireSession(request, env, requestId);
    if (required.response) return required.response;
    const customer = await env.DB.prepare(
      "SELECT email FROM customers WHERE id = ? AND status = 'ACTIVE'",
    ).bind(required.session!.customerId).first<{ email: string }>();
    if (!customer) return apiError(requestId, 401, "UNAUTHENTICATED", "Sign-in required");
    return jsonResponse(
      { authenticated: true, email: customer.email, csrf_token: getCookie(request, CSRF_COOKIE) },
      200,
      requestId,
    );
  }

  return null;
}

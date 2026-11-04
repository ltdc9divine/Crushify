export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  MEDIA?: R2Bucket;
  ENVIRONMENT?: "local" | "staging" | "production";
  MAIL_PROVIDER?: "resend";
  MAIL_API_KEY?: string;
  MAIL_FROM_EMAIL?: string;
  MAILER?: Fetcher;
  MAILER_AUTH_TOKEN?: string;
  APP_ORIGIN?: string;
  LOCAL_TEST_MODE?: string;
}

export interface Session {
  id: string;
  customerId: string;
  csrfTokenHash: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
  request_id: string;
}

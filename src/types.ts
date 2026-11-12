import type { Database } from "./database.ts";
import type { Storage } from "./storage.ts";

export interface Env {
  ASSETS?: Fetcher;
  DB: Database;
  STORAGE?: Storage;
  MEDIA?: R2Bucket;
  DATABASE_PROVIDER?: "d1" | "turso";
  STORAGE_PROVIDER?: "r2" | "cloudinary";
  CLOUDINARY_CLOUD_NAME?: string;
  CLOUDINARY_API_KEY?: string;
  CLOUDINARY_API_SECRET?: string;
  CLOUDINARY_STAGING_CLOUD_NAME?: string;
  CLOUDINARY_STAGING_API_KEY?: string;
  CLOUDINARY_STAGING_API_SECRET?: string;
  CLOUDINARY_PRODUCTION_CLOUD_NAME?: string;
  ENVIRONMENT?: "local" | "staging" | "production";
  MAIL_PROVIDER?: "resend";
  MAIL_API_KEY?: string;
  MAIL_FROM_EMAIL?: string;
  PREVIEW_EMAIL_SINK?: "discard";
  LOCAL_TEST_EMAIL_SINK?: (message: import("./auth.ts").EmailMessage) => Promise<void>;
  LOCAL_TEST_MAIL_SINK_URL?: string;
  MAILER?: Fetcher;
  MAILER_AUTH_TOKEN?: string;
  CRON_SECRET?: string;
  APP_ORIGIN?: string;
  LOCAL_TEST_MODE?: string;
  LOCAL_TEST_CATALOG_OVERRIDE?: string;
  LOCAL_TEST_PRICING_POLICY?: string;
  PAYMENT_MODE?: "mock" | "sepay-test";
  SEPAY_WEBHOOK_SECRET?: string;
  SEPAY_BANK_CODE?: string;
  SEPAY_BANK_ACCOUNT?: string;
  SEPAY_ACCOUNT_NAME?: string;
  UPLOAD_MAX_BYTES?: number;
  DATA_RETENTION_DAYS?: string;
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

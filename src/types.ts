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
  ENVIRONMENT?: "local" | "staging" | "production";
  MAIL_PROVIDER?: "resend";
  MAIL_API_KEY?: string;
  MAIL_FROM_EMAIL?: string;
  MAILER?: Fetcher;
  MAILER_AUTH_TOKEN?: string;
  APP_ORIGIN?: string;
  LOCAL_TEST_MODE?: string;
  UPLOAD_MAX_BYTES?: number;
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

import { safeId, sha256 } from "../http.ts";
import type {
  NormalizedPaymentTransaction,
  ParsedProviderWebhook,
  PaymentProvider,
  ProviderPaymentStatus,
} from "./provider.ts";

export const SEPAY_WEBHOOK_MAX_BYTES = 64 * 1024;
export const SEPAY_TIMESTAMP_TOLERANCE_SECONDS = 300;

export interface SePayWebhookPayload {
  id?: number | string;
  accountNumber?: string;
  code?: string | null;
  transferType?: string;
  transferAmount?: number;
}

export type ParsedWebhook = ParsedProviderWebhook<SePayWebhookPayload>;

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index++) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function decodeHex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export async function verifySePaySignature(
  headers: Headers,
  rawBody: Uint8Array,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const timestamp = headers.get("x-sepay-timestamp") ?? "";
  const signature = headers.get("x-sepay-signature") ?? "";
  if (!/^\d{1,12}$/.test(timestamp) || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds) ||
      Math.abs(nowSeconds - timestampSeconds) > SEPAY_TIMESTAMP_TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const signedBody = new Uint8Array(prefix.byteLength + rawBody.byteLength);
  signedBody.set(prefix);
  signedBody.set(rawBody, prefix.byteLength);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, signedBody));
  const received = decodeHex(signature.slice("sha256=".length));
  return constantTimeEqual(expected, received);
}

export async function parseWebhookBody(rawBody: Uint8Array): Promise<ParsedWebhook> {
  const rawText = new TextDecoder().decode(rawBody);
  let value: unknown;
  try {
    value = JSON.parse(rawText) as unknown;
  } catch {
    return {
      eventId: `invalid-${await sha256(rawBody)}`,
      transactionId: null,
      payload: null,
      reviewReason: "Payload is not valid JSON",
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      eventId: `invalid-${await sha256(rawBody)}`,
      transactionId: null,
      payload: null,
      reviewReason: "Payload must be a JSON object",
    };
  }
  const payload = value as SePayWebhookPayload;
  const transactionId = typeof payload.id === "number" && Number.isSafeInteger(payload.id) && payload.id > 0
    ? String(payload.id)
    : typeof payload.id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(payload.id)
      ? payload.id
      : null;
  if (!transactionId) {
    return {
      eventId: `invalid-${await sha256(rawBody)}`,
      transactionId: null,
      payload,
      reviewReason: "Transaction ID is missing or invalid",
    };
  }
  return {
    eventId: transactionId,
    transactionId,
    payload,
    reviewReason: null,
  };
}

function createReference(prefix: "CRF" | "CRP"): string {
  const suffix = crypto.getRandomValues(new Uint8Array(8));
  return `${prefix}${[...suffix].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

export function createOrderReference(): string {
  return createReference("CRF");
}

export function createPaymentReference(): string {
  return createReference("CRP");
}

export function createOrderId(): string {
  return safeId();
}

export function createSePayQrUrl(
  bankCode: string | undefined,
  bankAccount: string | undefined,
  amount: number,
  paymentReference: string,
): string | null {
  if (!bankCode || !/^[A-Z0-9]{2,20}$/i.test(bankCode) ||
      !bankAccount || !/^\d{5,20}$/.test(bankAccount)) return null;
  const url = new URL("https://vietqr.app/img");
  url.searchParams.set("acc", bankAccount);
  url.searchParams.set("bank", bankCode.toUpperCase());
  url.searchParams.set("amount", String(amount));
  url.searchParams.set("des", paymentReference);
  return url.toString();
}

export const sepayPaymentProvider: PaymentProvider<SePayWebhookPayload> = {
  id: "SEPAY",
  createInstructions(input) {
    if (input.mode !== "sepay-test") return null;
    const qrUrl = createSePayQrUrl(input.bankCode, input.bankAccount, input.amountMinor, input.reference);
    if (!qrUrl || !input.bankCode || !input.bankAccount) return null;
    return {
      bankCode: input.bankCode.toUpperCase(),
      bankAccount: input.bankAccount,
      accountName: input.accountName?.trim() || null,
      amountMinor: input.amountMinor,
      reference: input.reference,
      qrUrl,
    };
  },
  verifyWebhook: verifySePaySignature,
  parseWebhook: parseWebhookBody,
  normalizeTransaction(payload): NormalizedPaymentTransaction {
    return {
      transactionId: typeof payload.id === "number" || typeof payload.id === "string"
        ? String(payload.id)
        : null,
      paymentReference: typeof payload.code === "string" ? payload.code : null,
      receivingAccount: typeof payload.accountNumber === "string" ? payload.accountNumber : null,
      direction: payload.transferType === "in" || payload.transferType === "out"
        ? payload.transferType
        : null,
      amountMinor: Number.isSafeInteger(payload.transferAmount) ? payload.transferAmount! : null,
    };
  },
  mapStatus(transaction): ProviderPaymentStatus {
    return transaction.direction === "in" ? "SUCCEEDED" : "MANUAL_REVIEW";
  },
};

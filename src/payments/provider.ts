export interface ParsedProviderWebhook<TPayload> {
  eventId: string;
  transactionId: string | null;
  payload: TPayload | null;
  reviewReason: string | null;
}

export interface NormalizedPaymentTransaction {
  transactionId: string | null;
  paymentReference: string | null;
  receivingAccount: string | null;
  direction: "in" | "out" | null;
  amountMinor: number | null;
}

export type ProviderPaymentStatus = "SUCCEEDED" | "MANUAL_REVIEW";

export interface PaymentInstructionsInput {
  mode: "mock" | "sepay-test";
  amountMinor: number;
  reference: string;
  bankCode?: string;
  bankAccount?: string;
  accountName?: string;
}

export interface PaymentInstructions {
  bankCode: string;
  bankAccount: string;
  accountName: string | null;
  amountMinor: number;
  reference: string;
  qrUrl: string;
}

export interface PaymentProvider<TPayload> {
  readonly id: string;
  createInstructions(input: PaymentInstructionsInput): PaymentInstructions | null;
  verifyWebhook(headers: Headers, rawBody: Uint8Array, secret: string): Promise<boolean>;
  parseWebhook(rawBody: Uint8Array): Promise<ParsedProviderWebhook<TPayload>>;
  normalizeTransaction(payload: TPayload): NormalizedPaymentTransaction;
  mapStatus(transaction: NormalizedPaymentTransaction): ProviderPaymentStatus;
}

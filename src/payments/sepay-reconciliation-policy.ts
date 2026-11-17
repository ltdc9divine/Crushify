import type { SePayApiV2Transaction } from "./sepay-api-v2.ts";

export interface ReconciliationPaymentCandidate {
  paymentId: string;
  paymentReference: string;
  amountMinor: number;
  currency: string;
  orderTotalMinor: number;
  orderCurrency: string;
  orderType: string;
  paymentStatus: string;
  orderStatus: string;
  paymentReviewRequired: boolean;
  orderReviewRequired: boolean;
  expiresAt: string | null;
  orderCreatedAt: string;
}

export interface ReconciliationReferenceContract {
  verified: boolean;
  field: "code" | "reference_number" | null;
}

export interface ReconciliationPolicyContext {
  expectedBankAccountId: string;
  referenceContract: ReconciliationReferenceContract;
  verifiedCurrency: string | null;
  observedPaymentId?: string | null;
  now?: Date;
}

export type ReconciliationDecision =
  | { status: "CANDIDATE"; reasonCode: "EXACT_MATCH"; paymentId: string }
  | { status: "UNMATCHED"; reasonCode: string }
  | { status: "AMBIGUOUS"; reasonCode: "MULTIPLE_EXACT_MATCHES" }
  | { status: "MANUAL_REVIEW"; reasonCode: string };

function decision(status: "UNMATCHED" | "MANUAL_REVIEW", reasonCode: string): ReconciliationDecision {
  return { status, reasonCode };
}

export function evaluateSePayApiV2Observation(
  transaction: SePayApiV2Transaction,
  payments: ReconciliationPaymentCandidate[],
  context: ReconciliationPolicyContext,
): ReconciliationDecision {
  if (transaction.transferType !== "in" || transaction.amountOut !== 0) {
    return decision("MANUAL_REVIEW", "WRONG_TRANSFER_DIRECTION");
  }
  if (transaction.bankAccountId.toLowerCase() !== context.expectedBankAccountId.toLowerCase()) {
    return decision("MANUAL_REVIEW", "BANK_ACCOUNT_MISMATCH");
  }
  if (!context.referenceContract.verified || !context.referenceContract.field) {
    return decision("UNMATCHED", "REFERENCE_MAPPING_UNVERIFIED");
  }
  const reference = context.referenceContract.field === "code"
    ? transaction.code
    : transaction.referenceNumber;
  if (!reference?.trim()) return decision("UNMATCHED", "REFERENCE_MISSING");

  const exactMatches = payments.filter((payment) => payment.paymentReference === reference);
  if (exactMatches.length === 0) return decision("UNMATCHED", "NO_EXACT_REFERENCE_MATCH");
  if (exactMatches.length > 1) {
    return { status: "AMBIGUOUS", reasonCode: "MULTIPLE_EXACT_MATCHES" };
  }

  const payment = exactMatches[0]!;
  if (context.observedPaymentId &&
      context.observedPaymentId !== payment.paymentId) {
    return decision("MANUAL_REVIEW", "TRANSACTION_OWNERSHIP_CONFLICT");
  }
  if (payment.paymentReviewRequired || payment.orderReviewRequired) {
    return decision("MANUAL_REVIEW", "PAYMENT_REQUIRES_MANUAL_REVIEW");
  }
  if (payment.orderType !== "SELF_SERVICE") {
    return decision("MANUAL_REVIEW", "ORDER_TYPE_NOT_ELIGIBLE");
  }
  if (payment.orderStatus !== "AWAITING_PAYMENT" || payment.paymentStatus !== "PENDING") {
    return decision("MANUAL_REVIEW", "PAYMENT_NOT_ELIGIBLE");
  }
  if (payment.amountMinor !== payment.orderTotalMinor) {
    return decision("MANUAL_REVIEW", "ORDER_PAYMENT_AMOUNT_MISMATCH");
  }
  if (payment.currency !== payment.orderCurrency) {
    return decision("MANUAL_REVIEW", "ORDER_PAYMENT_CURRENCY_MISMATCH");
  }
  const now = context.now ?? new Date();
  const expiresAt = payment.expiresAt === null ? Number.NaN : Date.parse(payment.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    return decision("MANUAL_REVIEW", "ORDER_EXPIRED");
  }
  const transactionAt = Date.parse(transaction.transactionDate);
  const orderCreatedAt = Date.parse(payment.orderCreatedAt);
  if (!Number.isFinite(transactionAt) || !Number.isFinite(orderCreatedAt) ||
      transactionAt < orderCreatedAt) {
    return decision("MANUAL_REVIEW", "HISTORICAL_TRANSACTION");
  }
  if (transaction.amountIn !== payment.amountMinor) {
    return decision("MANUAL_REVIEW", "AMOUNT_MISMATCH");
  }
  if (!context.verifiedCurrency) {
    return decision("MANUAL_REVIEW", "CURRENCY_UNVERIFIED");
  }
  if (context.verifiedCurrency !== payment.currency) {
    return decision("MANUAL_REVIEW", "CURRENCY_MISMATCH");
  }

  return { status: "CANDIDATE", reasonCode: "EXACT_MATCH", paymentId: payment.paymentId };
}

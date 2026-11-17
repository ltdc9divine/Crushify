import type { Env } from "../types.ts";

export type PaymentProviderId = "MOCK" | "SEPAY" | "MANUAL_BANK_TRANSFER";
export type PaymentMode = "mock" | "sepay-test" | "manual-bank-transfer";

export interface PaymentEnvironmentPolicy {
  provider: PaymentProviderId | null;
  mode: PaymentMode | null;
  orderCreationEnabled: boolean;
  sepayWebhookEnabled: boolean;
  fulfillmentEnabled: boolean;
}

const disabledPolicy: PaymentEnvironmentPolicy = {
  provider: null,
  mode: null,
  orderCreationEnabled: false,
  sepayWebhookEnabled: false,
  fulfillmentEnabled: false,
};

export function resolvePaymentEnvironmentPolicy(
  env: Pick<Env, "ENVIRONMENT" | "LOCAL_TEST_MODE" | "PAYMENT_MODE" | "PREVIEW_CUSTOMER_FLOW_ENABLED">,
): PaymentEnvironmentPolicy {
  if (env.ENVIRONMENT === "production") {
    return {
      provider: "SEPAY",
      mode: null,
      orderCreationEnabled: false,
      sepayWebhookEnabled: false,
      fulfillmentEnabled: true,
    };
  }
  if (env.ENVIRONMENT === "staging") {
    if (env.PREVIEW_CUSTOMER_FLOW_ENABLED === "true" && env.PAYMENT_MODE === "sepay-test") {
      return {
        provider: "SEPAY",
        mode: "sepay-test",
        orderCreationEnabled: true,
        sepayWebhookEnabled: true,
        fulfillmentEnabled: true,
      };
    }
    if (env.PREVIEW_CUSTOMER_FLOW_ENABLED === "true" &&
        env.PAYMENT_MODE === "manual-bank-transfer") {
      return {
        provider: "MANUAL_BANK_TRANSFER",
        mode: "manual-bank-transfer",
        orderCreationEnabled: true,
        sepayWebhookEnabled: false,
        fulfillmentEnabled: true,
      };
    }
    return {
      provider: "MOCK",
      mode: "mock",
      orderCreationEnabled: false,
      sepayWebhookEnabled: false,
      fulfillmentEnabled: false,
    };
  }
  if (env.ENVIRONMENT !== "local") {
    return disabledPolicy;
  }
  if (env.LOCAL_TEST_MODE !== "true") {
    return { ...disabledPolicy, fulfillmentEnabled: true };
  }
  if (env.PAYMENT_MODE === "mock") {
    return {
      provider: "SEPAY",
      mode: "mock",
      orderCreationEnabled: true,
      sepayWebhookEnabled: true,
      fulfillmentEnabled: true,
    };
  }
  if (env.PAYMENT_MODE === "sepay-test") {
    return {
      provider: "SEPAY",
      mode: "sepay-test",
      orderCreationEnabled: true,
      sepayWebhookEnabled: true,
      fulfillmentEnabled: true,
    };
  }
  if (env.PAYMENT_MODE === "manual-bank-transfer") {
    return {
      provider: "MANUAL_BANK_TRANSFER",
      mode: "manual-bank-transfer",
      orderCreationEnabled: true,
      sepayWebhookEnabled: false,
      fulfillmentEnabled: true,
    };
  }
  return { ...disabledPolicy, fulfillmentEnabled: true };
}

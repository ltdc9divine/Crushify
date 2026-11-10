import { TEMPLATE_RENDERERS, type TemplateId } from "./template-registry.ts";

export const STANDARD_TEMPLATE_BASE_PRICE_MINOR = 59_000;
export const STANDARD_HOSTING_MONTHLY_ADDITION_MINOR = 10_000;
export const STANDARD_HOSTING_INCLUDED_MONTHS = 1;
export const STANDARD_LIFETIME_PRICE_MINOR = 199_000;
export const STANDARD_PRICING_VERSION = "standard-v1";
export const STANDARD_CATALOG_ENABLED = false;

export interface StandardProduct {
  id: TemplateId;
  title: string;
  basePriceMinor: number;
  currency: "VND";
  available: boolean;
}

export interface StorageDuration {
  id: string;
  title: string;
  durationMonths: number | null;
  lifetime: boolean;
  amountMinor: number | null;
  currency: "VND";
  enabled: boolean;
}

export interface StandardPriceSnapshot {
  template_id: TemplateId;
  storage_plan_id: string;
  duration_type: "monthly" | "lifetime";
  template_base_price_minor: number;
  hosting_months: number | null;
  included_hosting_months: number | null;
  additional_hosting_months: number | null;
  additional_monthly_price_minor: number;
  hosting_charge_minor: number | null;
  lifetime_price_minor: number | null;
  total_minor: number;
  currency: "VND";
  pricing_version: string;
  calculated_at: string;
}

export type StandardHostingTerm =
  | { type: "monthly"; months: number }
  | { type: "lifetime" };

export interface PublicCatalogOptions {
  catalogEnabled?: boolean;
}

const standardProducts: StandardProduct[] = [
  { id: "our-universe", title: "Our Universe", basePriceMinor: STANDARD_TEMPLATE_BASE_PRICE_MINOR, currency: "VND", available: true },
  { id: "love-letter", title: "Love Letter", basePriceMinor: STANDARD_TEMPLATE_BASE_PRICE_MINOR, currency: "VND", available: true },
  { id: "our-memories", title: "Our Memories", basePriceMinor: STANDARD_TEMPLATE_BASE_PRICE_MINOR, currency: "VND", available: true },
  { id: "say-yes", title: "Say Yes", basePriceMinor: STANDARD_TEMPLATE_BASE_PRICE_MINOR, currency: "VND", available: true },
  { id: "distance-means-nothing", title: "Distance Means Nothing", basePriceMinor: STANDARD_TEMPLATE_BASE_PRICE_MINOR, currency: "VND", available: true },
];
export const STANDARD_PRODUCTS: readonly StandardProduct[] =
  Object.freeze(standardProducts.map((product) => Object.freeze(product)));

const storageDurations: StorageDuration[] = [
  { id: "1-month", title: "1 tháng", durationMonths: 1, lifetime: false, amountMinor: null, currency: "VND", enabled: false },
  { id: "3-months", title: "3 tháng", durationMonths: 3, lifetime: false, amountMinor: null, currency: "VND", enabled: false },
  { id: "6-months", title: "6 tháng", durationMonths: 6, lifetime: false, amountMinor: null, currency: "VND", enabled: false },
  { id: "12-months", title: "12 tháng", durationMonths: 12, lifetime: false, amountMinor: null, currency: "VND", enabled: false },
  { id: "lifetime", title: "Trọn đời", durationMonths: null, lifetime: true, amountMinor: null, currency: "VND", enabled: false },
];
export const STORAGE_DURATIONS: readonly StorageDuration[] =
  Object.freeze(storageDurations.map((duration) => Object.freeze(duration)));

export class CatalogPriceUnavailableError extends Error {
  constructor(message = "Hosting duration pricing has not been approved") {
    super(message);
    this.name = "CatalogPriceUnavailableError";
  }
}

export function standardProduct(id: string): StandardProduct | null {
  if (!Object.hasOwn(TEMPLATE_RENDERERS, id)) return null;
  return STANDARD_PRODUCTS.find((product) => product.id === id) ?? null;
}

export function storageDuration(id: string): StorageDuration | null {
  return STORAGE_DURATIONS.find((plan) => plan.id === id) ?? null;
}

export function deriveHostingAmountMinor(duration: Pick<StorageDuration, "durationMonths" | "lifetime" | "amountMinor">): number {
  if (duration.lifetime) {
    return Math.max(0, STANDARD_LIFETIME_PRICE_MINOR - STANDARD_TEMPLATE_BASE_PRICE_MINOR);
  }
  if (!Number.isInteger(duration.durationMonths) || duration.durationMonths === null || duration.durationMonths < 1) {
    throw new CatalogPriceUnavailableError("Hosting duration is invalid");
  }
  const extraMonths = Math.max(0, duration.durationMonths - STANDARD_HOSTING_INCLUDED_MONTHS);
  return extraMonths * STANDARD_HOSTING_MONTHLY_ADDITION_MINOR;
}

export function resolveStandardPlanAmountMinor(duration: StorageDuration): number {
  if (!duration.enabled) {
    throw new CatalogPriceUnavailableError();
  }
  if (duration.amountMinor !== null) {
    return duration.amountMinor;
  }
  return deriveHostingAmountMinor(duration);
}

function validateHostingTerm(term: StandardHostingTerm): void {
  if (term.type === "monthly") {
    if (!Number.isSafeInteger(term.months) || term.months < 1) {
      throw new CatalogPriceUnavailableError("Hosting duration must be a positive whole number of months");
    }
    return;
  }
  if (term.type !== "lifetime") {
    throw new CatalogPriceUnavailableError("Hosting duration type is invalid");
  }
}

export function standardPriceSnapshotForTerm(
  templateId: string,
  term: StandardHostingTerm,
  calculatedAt = new Date().toISOString(),
): StandardPriceSnapshot {
  const product = standardProduct(templateId);
  if (!product || !product.available) {
    throw new CatalogPriceUnavailableError("This standard template is unavailable");
  }
  validateHostingTerm(term);
  if (!Number.isFinite(Date.parse(calculatedAt))) {
    throw new CatalogPriceUnavailableError("Pricing timestamp is invalid");
  }

  const hostingMonths = term.type === "monthly" ? term.months : null;
  const monthly = hostingMonths !== null;
  const hostingChargeMinor = hostingMonths !== null
    ? Math.max(0, hostingMonths - STANDARD_HOSTING_INCLUDED_MONTHS) *
      STANDARD_HOSTING_MONTHLY_ADDITION_MINOR
    : null;
  const totalMinor = monthly
    ? product.basePriceMinor + (hostingChargeMinor ?? 0)
    : STANDARD_LIFETIME_PRICE_MINOR;
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 1 ||
      (hostingChargeMinor !== null && !Number.isSafeInteger(hostingChargeMinor))) {
    throw new CatalogPriceUnavailableError("Configured order total is invalid");
  }

  const plan = hostingMonths !== null
    ? STORAGE_DURATIONS.find((item) => item.durationMonths === hostingMonths)
    : storageDuration("lifetime");
  const planId = plan?.id ?? `custom-${hostingMonths}-months`;
  return Object.freeze({
    template_id: product.id,
    storage_plan_id: planId,
    duration_type: term.type,
    template_base_price_minor: product.basePriceMinor,
    hosting_months: hostingMonths,
    included_hosting_months: monthly ? STANDARD_HOSTING_INCLUDED_MONTHS : null,
    additional_hosting_months: monthly
      ? Math.max(0, hostingMonths! - STANDARD_HOSTING_INCLUDED_MONTHS)
      : null,
    additional_monthly_price_minor: STANDARD_HOSTING_MONTHLY_ADDITION_MINOR,
    hosting_charge_minor: hostingChargeMinor,
    lifetime_price_minor: monthly ? null : STANDARD_LIFETIME_PRICE_MINOR,
    total_minor: totalMinor,
    currency: "VND",
    pricing_version: STANDARD_PRICING_VERSION,
    calculated_at: calculatedAt,
  });
}

export function standardStoragePlanForTerm(term: StandardHostingTerm): StorageDuration {
  validateHostingTerm(term);
  if (term.type === "lifetime") {
    return storageDuration("lifetime")!;
  }
  const preset = STORAGE_DURATIONS.find((plan) => plan.durationMonths === term.months);
  return preset ?? {
    id: `custom-${term.months}-months`,
    title: `${term.months} tháng`,
    durationMonths: term.months,
    lifetime: false,
    amountMinor: null,
    currency: "VND",
    enabled: false,
  };
}

export function calculateStandardOrderTotal(templateId: string, durationId: string): number {
  const product = standardProduct(templateId);
  if (!product || !product.available) {
    throw new CatalogPriceUnavailableError("This standard template is unavailable");
  }
  const duration = storageDuration(durationId);
  if (!duration || !duration.enabled) {
    throw new CatalogPriceUnavailableError();
  }
  return standardPriceSnapshotForTerm(
    templateId,
    duration.lifetime
      ? { type: "lifetime" }
      : { type: "monthly", months: duration.durationMonths! },
  ).total_minor;
}

export function standardPriceSnapshot(templateId: string, durationId: string): StandardPriceSnapshot {
  const product = standardProduct(templateId);
  const duration = storageDuration(durationId);
  if (!product || !product.available || !duration) {
    throw new CatalogPriceUnavailableError();
  }
  return standardPriceSnapshotForTerm(
    templateId,
    duration.lifetime
      ? { type: "lifetime" }
      : { type: "monthly", months: duration.durationMonths! },
  );
}

export function publicProductCatalog(options: PublicCatalogOptions = {}) {
  const catalogEnabled = options.catalogEnabled ?? STANDARD_CATALOG_ENABLED;
  return {
    currency: "VND" as const,
    pricing_policy: {
      version: STANDARD_PRICING_VERSION,
      catalog_enabled: catalogEnabled,
      template_base_price_minor: STANDARD_TEMPLATE_BASE_PRICE_MINOR,
      included_hosting_months: STANDARD_HOSTING_INCLUDED_MONTHS,
      additional_month_price_minor: STANDARD_HOSTING_MONTHLY_ADDITION_MINOR,
      lifetime_price_minor: STANDARD_LIFETIME_PRICE_MINOR,
      currency: "VND" as const,
    },
    products: STANDARD_PRODUCTS.map((product) => ({
      id: product.id,
      title: product.title,
      schema_version: TEMPLATE_RENDERERS[product.id].schemaVersion,
      base_price_minor: product.basePriceMinor,
      currency: product.currency,
      available: product.available,
    })),
    storage_durations: STORAGE_DURATIONS.map((plan) => {
      const enabled = catalogEnabled;
      const amountMinor = enabled
        ? (plan.amountMinor ?? deriveHostingAmountMinor(plan))
        : plan.amountMinor;
      return {
        id: plan.id,
        title: plan.title,
        duration_months: plan.durationMonths,
        lifetime: plan.lifetime,
        amount_minor: amountMinor,
        currency: plan.currency,
        enabled,
        price_configured: enabled,
      };
    }),
  };
}

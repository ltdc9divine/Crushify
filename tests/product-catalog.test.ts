import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TEMPLATE_RENDERERS } from "../src/template-registry.ts";
import {
  calculateStandardOrderTotal,
  CatalogPriceUnavailableError,
  deriveHostingAmountMinor,
  publicProductCatalog,
  standardRenewalAmountMinor,
  standardProduct,
  standardPriceSnapshotForTerm,
  standardStoragePlanForTerm,
  storageDuration,
  STANDARD_CATALOG_ENABLED,
  STANDARD_LIFETIME_PRICE_MINOR,
  STANDARD_PRODUCTS,
  STORAGE_DURATIONS,
} from "../src/product-catalog.ts";

describe("central standard product catalog", () => {
  it("lists each registered standard template at the approved integer VND base price", () => {
    assert.deepEqual(STANDARD_PRODUCTS.map((product) => product.id).sort(), [
      "distance-means-nothing",
      "love-letter",
      "our-memories",
      "our-universe",
      "say-yes",
    ]);
    assert.deepEqual(
      STANDARD_PRODUCTS.map((product) => product.id).sort(),
      Object.keys(TEMPLATE_RENDERERS).sort(),
    );
    for (const product of STANDARD_PRODUCTS) {
      assert.equal(product.basePriceMinor, 59_000);
      assert.equal(product.currency, "VND");
      assert.equal(product.available, true);
    }
  });

  it("rejects unknown products and duration IDs", () => {
    assert.equal(standardProduct("not-a-template"), null);
    assert.equal(storageDuration("not-a-duration"), null);
    assert.throws(
      () => calculateStandardOrderTotal("not-a-template", "1-month"),
      CatalogPriceUnavailableError,
    );
  });

  it("enables all standard hosting durations without hard-coding their computed prices", () => {
    assert.deepEqual(STORAGE_DURATIONS.map((plan) => plan.id), [
      "1-month", "3-months", "6-months", "12-months", "lifetime",
    ]);
    for (const plan of STORAGE_DURATIONS) {
      assert.equal(plan.amountMinor, null);
      assert.equal(plan.enabled, true);
    }
    assert.equal(storageDuration("lifetime")?.enabled, true);
    assert.deepEqual(
      STORAGE_DURATIONS.map((plan) => calculateStandardOrderTotal("our-universe", plan.id)),
      [59_000, 79_000, 109_000, 169_000, 199_000],
    );
  });

  it("publishes all standard products and first-purchase totals", () => {
    const catalog = publicProductCatalog();
    assert.equal(catalog.currency, "VND");
    assert.equal(catalog.pricing_policy.catalog_enabled, true);
    assert.equal(catalog.pricing_policy.template_base_price_minor, 59_000);
    assert.equal(catalog.pricing_policy.additional_month_price_minor, 10_000);
    assert.equal(catalog.pricing_policy.lifetime_price_minor, 199_000);
    assert.equal(catalog.products.length, 5);
    assert.ok(catalog.products.every((product) =>
      product.available && product.base_price_minor === 59_000 && product.currency === "VND"));
    assert.deepEqual(
      catalog.storage_durations.map((plan) => [
        plan.id,
        plan.amount_minor,
        plan.hosting_charge_minor,
        plan.price_configured,
      ]),
      [
        ["1-month", 59_000, 0, true],
        ["3-months", 79_000, 20_000, true],
        ["6-months", 109_000, 50_000, true],
        ["12-months", 169_000, 110_000, true],
        ["lifetime", 199_000, null, true],
      ],
    );
  });

  it("derives the approved monthly and lifetime pricing rules from the catalog policy", () => {
    assert.equal(deriveHostingAmountMinor({ durationMonths: 1, lifetime: false, amountMinor: null }), 0);
    assert.equal(deriveHostingAmountMinor({ durationMonths: 2, lifetime: false, amountMinor: null }), 10_000);
    assert.equal(deriveHostingAmountMinor({ durationMonths: 3, lifetime: false, amountMinor: null }), 20_000);
    assert.equal(deriveHostingAmountMinor({ durationMonths: 6, lifetime: false, amountMinor: null }), 50_000);
    assert.equal(deriveHostingAmountMinor({ durationMonths: 12, lifetime: false, amountMinor: null }), 110_000);
    assert.equal(deriveHostingAmountMinor({ durationMonths: null, lifetime: true, amountMinor: null }), 140_000);
    for (const [months, total] of [
      [1, 59_000],
      [2, 69_000],
      [3, 79_000],
      [4, 89_000],
      [5, 99_000],
      [6, 109_000],
      [7, 119_000],
      [12, 169_000],
    ]) {
      assert.equal(
        standardPriceSnapshotForTerm("our-universe", { type: "monthly", months }).total_minor,
        total,
      );
    }
    assert.equal(
      standardPriceSnapshotForTerm("our-universe", { type: "monthly", months: 24 }).total_minor,
      289_000,
    );
    assert.equal(
      standardPriceSnapshotForTerm("say-yes", { type: "lifetime" }).total_minor,
      199_000,
    );
    assert.equal(standardRenewalAmountMinor(storageDuration("1-month")!), 10_000);
    assert.equal(standardRenewalAmountMinor(storageDuration("3-months")!), 30_000);
    assert.equal(standardRenewalAmountMinor(storageDuration("6-months")!), 60_000);
    assert.equal(standardRenewalAmountMinor(storageDuration("12-months")!), 120_000);
    assert.equal(standardRenewalAmountMinor(storageDuration("lifetime")!), null);
    for (const months of [2, 4, 5, 7]) {
      assert.equal(
        standardRenewalAmountMinor(standardStoragePlanForTerm({ type: "monthly", months })),
        months * 10_000,
      );
    }
  });

  it("keeps catalog pricing and checkout availability separate", () => {
    assert.equal(STANDARD_CATALOG_ENABLED, true);
    const disabledCatalog = publicProductCatalog({ catalogEnabled: false });
    assert.equal(disabledCatalog.pricing_policy.catalog_enabled, false);
    assert.ok(disabledCatalog.products.every((product) => product.available));
    assert.ok(disabledCatalog.storage_durations.every((plan) =>
      !plan.enabled && !plan.price_configured && plan.amount_minor === null));
    assert.throws(() => {
      (STANDARD_PRODUCTS[0] as { basePriceMinor: number }).basePriceMinor = 1;
    }, TypeError);
  });

  it("keeps lifetime pricing distinct from the base template price", () => {
    assert.equal(STANDARD_LIFETIME_PRICE_MINOR, 199_000);
    assert.equal(deriveHostingAmountMinor({ durationMonths: null, lifetime: true, amountMinor: null }), 140_000);
    const snapshot = standardPriceSnapshotForTerm("love-letter", { type: "lifetime" });
    assert.equal(snapshot.template_base_price_minor, 59_000);
    assert.equal(snapshot.hosting_months, null);
    assert.equal(snapshot.hosting_charge_minor, null);
    assert.equal(snapshot.lifetime_price_minor, 199_000);
    assert.equal(snapshot.total_minor, 199_000);
    assert.equal(snapshot.duration_type, "lifetime");
    assert.ok(snapshot.pricing_version);
    assert.ok(Number.isFinite(Date.parse(snapshot.calculated_at)));
  });

  it("rejects fractional, zero, unsafe, and unknown-term durations", () => {
    for (const months of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      assert.throws(
        () => standardPriceSnapshotForTerm("our-universe", { type: "monthly", months }),
        CatalogPriceUnavailableError,
      );
    }
    assert.throws(
      () => standardPriceSnapshotForTerm("premium-template", { type: "lifetime" }),
      CatalogPriceUnavailableError,
    );
    assert.throws(
      () => standardPriceSnapshotForTerm("custom-design", { type: "monthly", months: 1 }),
      CatalogPriceUnavailableError,
    );
  });
});

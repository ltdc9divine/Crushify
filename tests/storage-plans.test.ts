import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addCalendarMonths, entitlementExpiry } from "../src/storage-plans.ts";

describe("storage plan calendar expiry", () => {
  it("adds calendar months and clamps month-end dates", () => {
    assert.equal(
      addCalendarMonths(new Date("2024-01-31T12:30:00.000Z"), 1).toISOString(),
      "2024-02-29T12:30:00.000Z",
    );
    assert.equal(
      addCalendarMonths(new Date("2025-01-31T12:30:00.000Z"), 1).toISOString(),
      "2025-02-28T12:30:00.000Z",
    );
    assert.equal(
      addCalendarMonths(new Date("2025-11-30T00:00:00.000Z"), 3).toISOString(),
      "2026-02-28T00:00:00.000Z",
    );
  });

  it("keeps lifetime expiry null and rejects invalid durations", () => {
    assert.equal(entitlementExpiry(
      { id: "lifetime", durationMonths: null, lifetime: true },
      new Date("2026-01-01T00:00:00.000Z"),
    ), null);
    assert.throws(() => addCalendarMonths(new Date(), 0), RangeError);
    assert.throws(() => entitlementExpiry(
      { id: "1-month", durationMonths: null, lifetime: false },
      new Date(),
    ), RangeError);
    assert.throws(
      () => addCalendarMonths(new Date("2026-01-01T00:00:00.000Z"), 1_000_000_000),
      RangeError,
    );
  });
});

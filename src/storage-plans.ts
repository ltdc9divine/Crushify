export interface StoragePlan {
  id: string;
  durationMonths: number | null;
  lifetime: boolean;
}

export function addCalendarMonths(value: Date, months: number): Date {
  if (!Number.isSafeInteger(months) || months < 1) {
    throw new RangeError("Calendar month duration must be a positive integer");
  }
  if (!Number.isFinite(value.getTime())) throw new RangeError("Invalid activation date");

  const result = new Date(value.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const finalDay = new Date(Date.UTC(
    result.getUTCFullYear(),
    result.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  result.setUTCDate(Math.min(day, finalDay));
  return result;
}

export function entitlementExpiry(plan: StoragePlan, startsAt: Date): Date | null {
  if (plan.lifetime) {
    if (plan.durationMonths !== null) throw new RangeError("Lifetime storage cannot have a month duration");
    return null;
  }
  if (plan.durationMonths === null) throw new RangeError("A monthly plan requires its duration");
  return addCalendarMonths(startsAt, plan.durationMonths);
}

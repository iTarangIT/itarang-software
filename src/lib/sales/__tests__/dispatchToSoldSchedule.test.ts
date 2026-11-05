// ID 220 — Step 5 shows the real run that marks a dispatched sale delivered.
import { describe, expect, it } from "vitest";

import { deliveredSmsTimely, nextAutoDeliveredAt } from "@/lib/sales/dispatchToSoldSchedule";

// IST = UTC+5:30; 09:30 IST = 04:00 UTC.
describe("nextAutoDeliveredAt", () => {
  it("an afternoon dispatch moves two mornings later", () => {
    // Dispatched Mon 3 Nov 15:00 IST (09:30 UTC) → eligible after Tue 15:00 IST → Wed 09:30 IST.
    expect(nextAutoDeliveredAt(new Date("2026-11-03T09:30:00Z"), 1).toISOString()).toBe("2026-11-05T04:00:00.000Z");
  });

  it("an early-morning dispatch moves the next morning", () => {
    // Dispatched Mon 3 Nov 08:00 IST (02:30 UTC) → eligible after Tue 08:00 IST → Tue 09:30 IST.
    expect(nextAutoDeliveredAt(new Date("2026-11-03T02:30:00Z"), 1).toISOString()).toBe("2026-11-04T04:00:00.000Z");
  });

  it("a dispatch exactly at 09:30 IST goes at the next day's run", () => {
    // Eligible from Tue 09:30 IST; the tick lands just after 09:30, so Tue.
    expect(nextAutoDeliveredAt(new Date("2026-11-03T04:00:00Z"), 1).toISOString()).toBe("2026-11-04T04:00:00.000Z");
  });

  it("crosses the IST date line correctly", () => {
    // Dispatched Mon 3 Nov 23:45 IST (18:15 UTC) → eligible after Tue 23:45 IST → Wed 09:30 IST.
    expect(nextAutoDeliveredAt(new Date("2026-11-03T18:15:00Z"), 1).toISOString()).toBe("2026-11-05T04:00:00.000Z");
  });

  it("honours a longer delay", () => {
    expect(nextAutoDeliveredAt(new Date("2026-11-03T02:30:00Z"), 3).toISOString()).toBe("2026-11-06T04:00:00.000Z");
  });
});

describe("deliveredSmsTimely", () => {
  const now = new Date("2026-11-06T04:00:00Z");
  it("texts the customer for a sale dispatched in the last 3 days", () => {
    expect(deliveredSmsTimely(new Date("2026-11-04T09:30:00Z"), now)).toBe(true);
    expect(deliveredSmsTimely(new Date("2026-11-03T04:00:00Z"), now)).toBe(true);
  });
  it("not for an old backlog sale, or one with no dispatch date", () => {
    expect(deliveredSmsTimely(new Date("2026-10-10T09:30:00Z"), now)).toBe(false);
    expect(deliveredSmsTimely(null, now)).toBe(false);
  });
  it("the window can be set", () => {
    expect(deliveredSmsTimely(new Date("2026-10-10T09:30:00Z"), now, 30)).toBe(true);
  });
});

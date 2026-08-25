import { describe, expect, it } from "vitest";

import {
  activeBatteryCard,
  activeBatteryRows,
  warrantyMonthsOf,
  type ActiveBattery,
} from "../active-battery-rows";
import { MAX_ROWS, PAGE_SIZE } from "../stock-rows";

function battery(i: number, extra: Partial<ActiveBattery> = {}): ActiveBattery {
  return {
    warrantyId: `ASSET-${i}`,
    serial: `DEMO-FEED05-${String(i).padStart(3, "0")}`,
    model: "TKLiEV-64140",
    category: "battery",
    customerName: "Nazim",
    customerPhone: "+918766569287",
    deployedAt: new Date("2026-08-25T14:01:00Z"),
    warrantyStart: new Date("2026-08-25T14:01:00Z"),
    warrantyEnd: new Date("2029-08-25T14:01:00Z"),
    warrantyMonths: 36,
    paymentType: "finance",
    paymentStatus: "pending",
    leadId: "LEAD-20260825-587c98a8",
    ...extra,
  };
}

describe("warrantyMonthsOf", () => {
  it("prefers the persisted E-266 figure", () => {
    expect(warrantyMonthsOf(battery(1))).toBe(36);
  });
  it("falls back to whole months between the dates on pre-E-266 rows", () => {
    expect(warrantyMonthsOf(battery(1, { warrantyMonths: null }))).toBe(36);
    expect(
      warrantyMonthsOf(
        battery(1, { warrantyMonths: null, warrantyEnd: new Date("2028-08-25T00:00:00Z") }),
      ),
    ).toBe(24);
  });
  it("is null for the broken zero-month rows rather than 0", () => {
    expect(
      warrantyMonthsOf(
        battery(1, { warrantyMonths: null, warrantyEnd: new Date("2026-08-25T14:01:00Z") }),
      ),
    ).toBeNull();
    expect(warrantyMonthsOf(battery(1, { warrantyMonths: 0, warrantyEnd: null }))).toBeNull();
  });
});

describe("activeBatteryRows", () => {
  const many = Array.from({ length: 23 }, (_, i) => battery(i + 1));

  it("never exceeds the Meta row cap and reserves a row for Show more", () => {
    const rows = activeBatteryRows(many, 0);
    expect(rows.length).toBe(MAX_ROWS);
    expect(rows[rows.length - 1].id).toBe("ab_more");
    expect(rows.slice(0, -1).every((r) => r.id.startsWith("ab:"))).toBe(true);
  });

  it("pages by PAGE_SIZE and drops Show more on the last page", () => {
    const last = activeBatteryRows(many, 2);
    expect(last.length).toBe(23 - 2 * PAGE_SIZE);
    expect(last.some((r) => r.id === "ab_more")).toBe(false);
  });

  it("keeps titles ≤24 and descriptions ≤72 characters", () => {
    const rows = activeBatteryRows(
      [battery(1, { model: "A very long model name that overflows", customerName: "X".repeat(80) })],
      0,
    );
    expect(rows[0].title.length).toBeLessThanOrEqual(24);
    expect((rows[0].description ?? "").length).toBeLessThanOrEqual(72);
  });
});

describe("activeBatteryCard", () => {
  it("shows owner, phone, months and end date", () => {
    const card = activeBatteryCard(battery(8));
    expect(card).toContain("DEMO-FEED05-008");
    expect(card).toContain("Nazim");
    expect(card).toContain("+918766569287");
    expect(card).toContain("*36 months*");
    expect(card).toContain("valid until");
    expect(card).toContain("LEAD-20260825-587c98a8");
    expect(card).toContain("Finance");
  });
  it("labels an upfront payment as Cash", () => {
    expect(activeBatteryCard(battery(1, { paymentType: "upfront", paymentStatus: "paid" }))).toContain(
      "Cash · paid",
    );
  });
});

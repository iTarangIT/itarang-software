/**
 * The shared formatter is imported by every buyback screen, the quotation PDF
 * and the WhatsApp bodies. These tests pin the two bugs the prototype shipped:
 * `[object Object]` from string-templating a line, and duplicate SKU+condition
 * lines colliding when the label was used as a key.
 */

import { describe, expect, it } from "vitest";

import { formatBatteryLine, inr, lineTotal, perUnit, perUnitShort } from "../format";

const line = (over: Partial<Parameters<typeof formatBatteryLine>[0]> = {}) => ({
  id: "line-1",
  quantity: 3,
  condition: "WORKING" as const,
  voltage: 60,
  ah: 120,
  ...over,
});

describe("formatBatteryLine", () => {
  it("renders the canonical label", () => {
    const f = formatBatteryLine(line());
    expect(f.specLabel).toBe("60V 120Ah");
    expect(f.condition).toBe("Working");
    expect(f.countLabel).toBe("×3");
    expect(f.full).toBe("60V 120Ah · Working ×3");
  });

  it("renders Dead lines", () => {
    const f = formatBatteryLine(line({ condition: "DEAD", voltage: 58, ah: 110, quantity: 2 }));
    expect(f.full).toBe("58V 110Ah · Dead ×2");
    expect(f.conditionKey).toBe("DEAD");
  });

  it("trims trailing zeros on decimal specs but keeps real fractions", () => {
    // numeric(6,2) hands us "60.00" / "51.20" as strings from Drizzle.
    expect(formatBatteryLine(line({ voltage: "60.00", ah: "120.00" })).specLabel).toBe("60V 120Ah");
    expect(formatBatteryLine(line({ voltage: "51.20", ah: "105.00" })).specLabel).toBe(
      "51.2V 105Ah",
    );
  });

  it("never emits [object Object] — the parts are structured, not templated", () => {
    const f = formatBatteryLine(line());
    for (const value of Object.values(f)) {
      expect(String(value)).not.toContain("[object Object]");
    }
    // Guard the specific prototype bug: passing a condition object through.
    const rogue = formatBatteryLine(
      line({ condition: { label: "Working" } as never }),
    );
    expect(rogue.full).not.toContain("[object Object]");
  });

  it("does NOT produce a unique key — identical SKU+condition lines share a label", () => {
    // This is why callers must key on line.id. Pinning it so nobody is tempted
    // to reintroduce the prototype's label-as-map-key bug.
    const a = formatBatteryLine(line({ id: "line-a" }));
    const b = formatBatteryLine(line({ id: "line-b" }));
    expect(a.full).toBe(b.full);
  });
});

describe("inr", () => {
  it("groups in the Indian system", () => {
    expect(inr(5200)).toBe("₹5,200");
    expect(inr(53200)).toBe("₹53,200");
    expect(inr(150000)).toBe("₹1,50,000");
    expect(inr(12345678)).toBe("₹1,23,45,678");
  });

  it("distinguishes a missing price from zero", () => {
    expect(inr(null)).toBe("—");
    expect(inr(undefined)).toBe("—");
    expect(inr(NaN)).toBe("—");
    expect(inr("")).toBe("—");
    expect(inr(0)).toBe("₹0");
  });

  it("accepts the strings Drizzle returns for numeric columns", () => {
    expect(inr("5200.00")).toBe("₹5,200");
  });

  it("handles negatives", () => {
    expect(inr(-5200)).toBe("-₹5,200");
  });
});

describe("per-unit helpers", () => {
  it("renders both forms", () => {
    expect(perUnit(5200)).toBe("₹5,200/unit");
    expect(perUnitShort(5200)).toBe("₹5,200/u");
  });

  it("does not suffix an unknown price", () => {
    expect(perUnit(null)).toBe("—");
    expect(perUnitShort(null)).toBe("—");
  });
});

describe("lineTotal", () => {
  it("multiplies qty by price", () => {
    expect(lineTotal(3, 5200)).toBe(15600);
    expect(lineTotal(3, "5200.00")).toBe(15600);
  });

  it("is null when the price is unknown — never 0", () => {
    expect(lineTotal(3, null)).toBeNull();
    expect(lineTotal(3, undefined)).toBeNull();
  });
});

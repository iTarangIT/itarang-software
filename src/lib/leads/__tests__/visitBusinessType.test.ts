import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
import { planVisitBusinessType, VISIT_BUSINESS_TYPE_REQUIRED } from "../visitBusinessType";
import { BUSINESS_TYPES, normalizeBusinessType } from "../businessType";

// 24 Nov (CRM items 3 + 4).
describe("planVisitBusinessType — a visit needs the lead's type of business", () => {
    it("refuses when neither the visit nor the lead has a type", () => {
        expect(planVisitBusinessType(undefined, null)).toEqual({ ok: false, message: VISIT_BUSINESS_TYPE_REQUIRED });
        expect(planVisitBusinessType(null, "")).toEqual({ ok: false, message: VISIT_BUSINESS_TYPE_REQUIRED });
        // A stored value that is not a type (old junk) does not count.
        expect(planVisitBusinessType(undefined, "finance")).toMatchObject({ ok: false });
    });

    it("the lead's own type is enough — nothing to write", () => {
        expect(planVisitBusinessType(undefined, "scrap")).toEqual({ ok: true, write: null });
    });

    it("a type given with the visit is written, unless it is the same", () => {
        expect(planVisitBusinessType("two_wheeler", null)).toEqual({ ok: true, write: "two_wheeler" });
        expect(planVisitBusinessType("solar", "scrap")).toEqual({ ok: true, write: "solar" });
        expect(planVisitBusinessType("solar", "solar")).toEqual({ ok: true, write: null });
    });

    it("an invalid given type falls back to the lead's own", () => {
        expect(planVisitBusinessType("bicycle", "buyback")).toEqual({ ok: true, write: null });
        expect(planVisitBusinessType("bicycle", null)).toMatchObject({ ok: false });
    });
});

describe("business types from the 24 Nov meeting", () => {
    it("has two-wheeler, three-wheeler, lithium battery, solar, buyback and scrap (old values kept)", () => {
        for (const v of ["two_wheeler", "three_wheeler", "lithium_battery", "solar", "buyback", "scrap", "battery_sale", "other"]) {
            expect(BUSINESS_TYPES).toContain(v);
        }
    });

    it("reads the usual spellings from sheets and chat", () => {
        expect(normalizeBusinessType("2W")).toBe("two_wheeler");
        expect(normalizeBusinessType("2-Wheeler")).toBe("two_wheeler");
        expect(normalizeBusinessType("Three Wheeler")).toBe("three_wheeler");
        expect(normalizeBusinessType("E-Rickshaw")).toBe("three_wheeler");
        expect(normalizeBusinessType("Lithium")).toBe("lithium_battery");
        expect(normalizeBusinessType("Li-ion")).toBe("lithium_battery");
        expect(normalizeBusinessType("Solar Panels")).toBe("solar");
    });
});

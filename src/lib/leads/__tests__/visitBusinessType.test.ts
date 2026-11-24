import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
import { planVisitBusinessType, VISIT_BUSINESS_TYPE_REQUIRED, VISIT_SEGMENT_REQUIRED } from "../visitBusinessType";
import { BUSINESS_TYPES, normalizeBusinessType } from "../businessType";
import { LEAD_SEGMENTS, normalizeSegment, parseSegments, storedSegments } from "../segments";

// 24 Nov tree:
//   Type of business  ONE   battery_sale | buyback | scrap | other
//   Segment           MANY  3W batteries | 2W batteries | Solar | Inverter | BESS | ESS
const none = { business_type: null, segments: [] };

describe("the two fields", () => {
    it("Type of business is the four deal types only", () => {
        expect([...BUSINESS_TYPES]).toEqual(["battery_sale", "buyback", "scrap", "other"]);
    });

    it("Segment is the six product lines", () => {
        expect([...LEAD_SEGMENTS]).toEqual(["3W batteries", "2W batteries", "Solar", "Inverter", "BESS", "ESS"]);
    });

    it("a product typed where a TYPE is asked reads as Battery Sale", () => {
        for (const v of ["two_wheeler", "Three-Wheeler", "Lithium Battery", "solar", "2W", "E-Rickshaw"]) {
            expect(normalizeBusinessType(v)).toBe("battery_sale");
        }
    });

    it("segment spellings from sheets and chat", () => {
        expect(normalizeSegment("3W")).toBe("3W batteries");
        expect(normalizeSegment("e-rickshaw")).toBe("3W batteries");
        expect(normalizeSegment("2W Batteries")).toBe("2W batteries");
        expect(normalizeSegment("inverter battery")).toBe("Inverter");
        expect(normalizeSegment("bess")).toBe("BESS");
        expect(normalizeSegment("Auto-Parts")).toBeNull();
        expect(parseSegments("ESS, 3W, solar, 3W batteries, junk")).toEqual(["3W batteries", "Solar", "ESS"]);
    });

    it("stored values: known ones normalised, the two old ones kept, junk dropped", () => {
        expect(storedSegments(["3W", "Battery", "Auto-Parts", "junk", "Solar"])).toEqual(["3W batteries", "Battery", "Auto-Parts", "Solar"]);
        expect(storedSegments(null)).toEqual([]);
    });
});

describe("planVisitBusinessType — what a visit needs", () => {
    it("no type anywhere → refused", () => {
        expect(planVisitBusinessType({}, none)).toEqual({ ok: false, missing: "type", message: VISIT_BUSINESS_TYPE_REQUIRED });
    });

    it("battery sale with no segment anywhere → refused", () => {
        expect(planVisitBusinessType({ business_type: "battery_sale" }, none)).toEqual({
            ok: false,
            missing: "segment",
            message: VISIT_SEGMENT_REQUIRED,
        });
        expect(planVisitBusinessType({}, { business_type: "battery_sale", segments: [] })).toMatchObject({ missing: "segment" });
    });

    it("buyback / scrap / other need no segment", () => {
        for (const t of ["buyback", "scrap", "other"]) {
            expect(planVisitBusinessType({ business_type: t }, none)).toMatchObject({ ok: true, writeType: t, writeSegments: null });
        }
    });

    it("the lead's own type + segments are enough — nothing to write", () => {
        expect(planVisitBusinessType({}, { business_type: "battery_sale", segments: ["Solar"] })).toMatchObject({
            ok: true,
            writeType: null,
            writeSegments: null,
        });
    });

    it("given values are written only when they differ", () => {
        expect(
            planVisitBusinessType({ business_type: "battery_sale", segments: ["3W", "ESS"] }, none),
        ).toMatchObject({ ok: true, writeType: "battery_sale", writeSegments: ["3W batteries", "ESS"] });
        expect(
            planVisitBusinessType({ segments: ["ESS", "3W batteries"] }, { business_type: "battery_sale", segments: ["3W batteries", "ESS"] }),
        ).toMatchObject({ ok: true, writeType: null, writeSegments: null });
    });

    it("an old-only segment (Battery) still counts for a battery sale already on the lead", () => {
        expect(planVisitBusinessType({}, { business_type: "battery_sale", segments: ["Battery"] })).toMatchObject({ ok: true });
    });

    it("a retired type stored on the lead (three_wheeler) is not a type — asked again", () => {
        expect(planVisitBusinessType({}, { business_type: "three_wheeler", segments: [] })).toMatchObject({ ok: false, missing: "type" });
    });
});

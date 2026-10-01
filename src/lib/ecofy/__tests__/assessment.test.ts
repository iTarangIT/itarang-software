import { describe, expect, it } from "vitest";
import { calculatorAssessmentRefusal, ecofyActionSchema, toAssessmentCreate, type EcofyActionInput } from "../actionSchemas";
import { assetDetailSections, formatAssetValue } from "../assetView";

const calc = { segment: "RESI", productInterest: "SOLAR_STORAGE", method: "MONTHLY_UNITS", monthlyUnits: 300, backupHours: 4, phase: "SINGLE" };

function parse(body: Record<string, unknown>) {
    return ecofyActionSchema.safeParse({ action: "save_assessment", ...body });
}

describe("save_assessment (OpenAPI AssessmentCreate)", () => {
    it("keeps MANUAL / EPC working and requires their source note", () => {
        expect(parse({ method: "MANUAL", batteryKwh: 5, sourceNote: "EPC survey" }).success).toBe(true);
        expect(parse({ method: "EPC", sourceNote: "EPC site visit" }).success).toBe(true);
        expect(parse({ method: "MANUAL", batteryKwh: 5 }).success).toBe(false);
    });

    it("CALCULATOR needs CalcInput and is refused for C&I (FR-07.11)", () => {
        expect(parse({ method: "CALCULATOR", calculator: calc }).success).toBe(true);
        expect(parse({ method: "CALCULATOR" }).success).toBe(false);
        expect(parse({ method: "CALCULATOR", calculator: { ...calc, segment: "CI" } }).success).toBe(false);
        expect(parse({ method: "CALCULATOR", calculator: { ...calc, phase: "TWO" } }).success).toBe(false);
        expect(parse({ method: "CALCULATOR", calculator: { ...calc, backupHours: 25 } }).success).toBe(false);
    });

    it("needs an override reason when the selected system differs from the recommendation (FR-07.8, UAT-15)", () => {
        const base = { method: "CALCULATOR", calculator: calc, recommendedSystemCode: "SYS-A" };
        expect(parse({ ...base, selectedSystemCode: "SYS-A" }).success).toBe(true);
        expect(parse({ ...base, selectedSystemCode: "SYS-B" }).success).toBe(false);
        expect(parse({ ...base, selectedSystemCode: "SYS-B", overrideReason: "no" }).success).toBe(false);
        expect(parse({ ...base, selectedSystemCode: "SYS-B", overrideReason: "Customer wants headroom" }).success).toBe(true);
        // No recommendation at all: any pick differs from it.
        expect(parse({ method: "CALCULATOR", calculator: calc, recommendedSystemCode: null, selectedSystemCode: "SYS-B" }).success).toBe(false);
    });

    it("builds the AssessmentCreate body Ecofy takes (no CRM-only fields)", () => {
        const c = ecofyActionSchema.parse({
            action: "save_assessment",
            method: "CALCULATOR",
            calculator: calc,
            recommendedSystemCode: "SYS-A",
            selectedSystemCode: "SYS-B",
            overrideReason: "Customer wants headroom",
        }) as Extract<EcofyActionInput, { action: "save_assessment" }>;
        expect(toAssessmentCreate(c)).toEqual({
            method: "CALCULATOR",
            calculator: calc,
            selectedSystemCode: "SYS-B",
            overrideReason: "Customer wants headroom",
        });

        const same = ecofyActionSchema.parse({
            action: "save_assessment",
            method: "CALCULATOR",
            calculator: calc,
            recommendedSystemCode: "SYS-A",
            selectedSystemCode: "SYS-A",
            overrideReason: "ignored",
        }) as Extract<EcofyActionInput, { action: "save_assessment" }>;
        expect(toAssessmentCreate(same)).toEqual({ method: "CALCULATOR", calculator: calc, selectedSystemCode: "SYS-A", overrideReason: undefined });

        const m = ecofyActionSchema.parse({ action: "save_assessment", method: "MANUAL", batteryKwh: 5, sourceNote: "survey" }) as Extract<
            EcofyActionInput,
            { action: "save_assessment" }
        >;
        expect(toAssessmentCreate(m)).toEqual({
            method: "MANUAL",
            manual: { batteryKwh: 5, inverterKva: undefined, solarKwp: undefined, sourceNote: "survey" },
        });
    });

    it("refuses calculator inputs for another segment or a C&I lead", () => {
        const input = ecofyActionSchema.parse({ action: "save_assessment", method: "CALCULATOR", calculator: calc });
        expect(calculatorAssessmentRefusal("RESI", input)).toBeNull();
        expect(calculatorAssessmentRefusal("ESS", input)).toMatch(/ESS/);
        expect(calculatorAssessmentRefusal("CI", input)).toMatch(/C&I/);
        const manual = ecofyActionSchema.parse({ action: "save_assessment", method: "MANUAL", sourceNote: "survey" });
        expect(calculatorAssessmentRefusal("CI", manual)).toBeNull();
    });
});

describe("asset detail view", () => {
    it("turns an opaque asset object into sections without internal ids", () => {
        const s = assetDetailSections({
            id: "a-1",
            caseId: "c-1",
            caseNo: "ECO-1",
            status: "ACTIVE",
            commissionedOn: "2026-09-01",
            systemSnapshot: { system: "5 kWh", fileNo: "F-1" },
            emiStatus: { asOf: "2026-09-30", state: "DPD_1_30" },
            events: [{ id: 1, type: "BUYBACK", onDate: "2026-09-20" }],
        });
        expect(s[0].title).toBe("Asset");
        expect(s[0].rows?.map((r) => r[0])).toEqual(["Case", "Lifecycle", "Commissioned on"]);
        expect(s.find((x) => x.title.startsWith("Latest EMI"))?.rows).toContainEqual(["State", "DPD 1 30"]);
        const ev = s.find((x) => x.title.startsWith("Buyback"));
        expect(ev?.table?.columns).toEqual(["Type", "On date"]);
        expect(ev?.table?.rows).toEqual([["BUYBACK", "2026-09-20"]]);
    });

    it("formats values", () => {
        expect(formatAssetValue(null)).toBe("—");
        expect(formatAssetValue(true)).toBe("yes");
        expect(formatAssetValue(150000)).toBe("1,50,000");
    });
});

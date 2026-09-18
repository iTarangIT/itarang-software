// Tests for the E-296 "Type of Business" vocabulary. The parser is what the
// xlsx importer runs on free-typed spreadsheet cells, so it must accept both the
// stored values and the labels the UI shows, and must refuse to guess.

import { describe, expect, it } from "vitest";
import {
    BUSINESS_TYPES,
    BUSINESS_TYPE_LABELS,
    BusinessTypeSchema,
    businessTypeLabel,
    isBusinessTypeFilter,
    normalizeBusinessType,
} from "@/lib/leads/businessType";

describe("normalizeBusinessType", () => {
    it("accepts every stored value as-is", () => {
        for (const v of BUSINESS_TYPES) expect(normalizeBusinessType(v)).toBe(v);
    });

    it("accepts every label, in any case", () => {
        for (const v of BUSINESS_TYPES) {
            expect(normalizeBusinessType(BUSINESS_TYPE_LABELS[v])).toBe(v);
            expect(normalizeBusinessType(BUSINESS_TYPE_LABELS[v].toUpperCase())).toBe(v);
        }
    });

    it("tolerates spacing and punctuation variants", () => {
        expect(normalizeBusinessType("  battery-sale ")).toBe("battery_sale");
        expect(normalizeBusinessType("Buy Back")).toBe("buyback");
        expect(normalizeBusinessType("Battery Sales")).toBe("battery_sale");
        expect(normalizeBusinessType("Others")).toBe("other");
    });

    it("returns null for blank and unknown input", () => {
        expect(normalizeBusinessType("")).toBeNull();
        expect(normalizeBusinessType("   ")).toBeNull();
        expect(normalizeBusinessType(null)).toBeNull();
        expect(normalizeBusinessType(undefined)).toBeNull();
        expect(normalizeBusinessType("rental")).toBeNull();
        expect(normalizeBusinessType("unset")).toBeNull();
    });
});

describe("BusinessTypeSchema", () => {
    it("accepts the vocabulary and rejects the filter sentinel", () => {
        expect(BusinessTypeSchema.safeParse("scrap").success).toBe(true);
        expect(BusinessTypeSchema.safeParse("unset").success).toBe(false);
        expect(BusinessTypeSchema.safeParse("Battery Sale").success).toBe(false);
    });
});

describe("filter + label helpers", () => {
    it("treats 'unset' as a valid filter only", () => {
        expect(isBusinessTypeFilter("unset")).toBe(true);
        expect(isBusinessTypeFilter("finance")).toBe(true);
        expect(isBusinessTypeFilter("Finance")).toBe(false);
        expect(isBusinessTypeFilter(null)).toBe(false);
    });

    it("labels NULL and unknown values as Not set", () => {
        expect(businessTypeLabel(null)).toBe("Not set");
        expect(businessTypeLabel("garbage")).toBe("Not set");
        expect(businessTypeLabel("buyback")).toBe("Buyback");
    });
});

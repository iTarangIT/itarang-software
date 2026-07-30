import { describe, it, expect } from "vitest";
import { EXPENSE_BUCKET_VALUES } from "@/lib/expenses";
import {
    bucketFromRules,
    CATEGORY_BUCKET_RULES,
    KEYWORD_BUCKET_RULES,
    VENDOR_BUCKET_RULES,
} from "./bucketRules";
import { resolveBucket } from "./resolveBucket";

// E-218. The bucket a row lands in drives the CEO's month-on-month comparison,
// so the property that actually matters is STABILITY: the same invoice must
// resolve to the same bucket every time, regardless of what a model says on a
// given day. These tests pin the precedence that guarantees that.

describe("bucketFromRules — vendor rules", () => {
    it("matches a vendor fragment anywhere in the name, case-insensitively", () => {
        expect(bucketFromRules({ vendor: "Trontek Electronics Limited" })?.bucket).toBe("rm");
        expect(bucketFromRules({ vendor: "TRONTEK" })?.bucket).toBe("rm");
        expect(bucketFromRules({ vendor: "  trontek  " })?.bucket).toBe("rm");
    });

    it("classifies the vendors actually seen in the live folder", () => {
        expect(bucketFromRules({ vendor: "Ecostar Innovation Pvt Ltd" })?.bucket).toBe("rm");
        expect(bucketFromRules({ vendor: "AmpFusion Battery" })?.bucket).toBe("rm");
        expect(bucketFromRules({ vendor: "Ayansh Engineering" })?.bucket).toBe("rm");
        expect(bucketFromRules({ vendor: "KRISHAI Technologies Private Limited" })?.bucket).toBe("tech");
    });

    it("reports which rule fired", () => {
        expect(bucketFromRules({ vendor: "Anthropic PBC" })?.rule).toBe("vendor:anthropic");
    });

    it("returns null when nothing is known about the row", () => {
        expect(bucketFromRules({})).toBeNull();
        expect(bucketFromRules({ vendor: "Some Unknown Supplier" })).toBeNull();
    });
});

describe("bucketFromRules — category rules", () => {
    it("maps the manual-submission categories", () => {
        expect(bucketFromRules({ category: "Software/SaaS" })?.bucket).toBe("tech");
        expect(bucketFromRules({ category: "Travel" })?.bucket).toBe("misc");
        expect(bucketFromRules({ category: "Vehicle/Fuel" })?.bucket).toBe("misc");
    });

    it('ignores the "Invoice" placeholder every AI row carries', () => {
        // Every AI/Drive insert hardcodes category:"Invoice". Treating that as a
        // real category would bucket the entire AI ledger on a value that means
        // nothing, and the keyword rules below would never get a chance to run.
        expect(bucketFromRules({ category: "Invoice" })).toBeNull();
        expect(
            bucketFromRules({ category: "Invoice", description: "AWS cloud hosting" })?.bucket,
        ).toBe("tech");
    });
});

describe("bucketFromRules — keyword rules", () => {
    it("reads description and project tag", () => {
        expect(bucketFromRules({ description: "Wiring harness for 40 units" })?.bucket).toBe("rm");
        expect(bucketFromRules({ project_tag: "EV Charger Purchase" })?.bucket).toBe("rm");
        expect(bucketFromRules({ project_tag: "Tax Payment" })?.bucket).toBe("misc");
        expect(bucketFromRules({ description: "Annual subscription renewal" })?.bucket).toBe("tech");
    });

    it("prefers raw material over tech when both could match", () => {
        // In this business "battery management software" is far more often a
        // component purchase than a SaaS bill, so `rm` is checked first.
        expect(
            bucketFromRules({ description: "Battery management software module" })?.bucket,
        ).toBe("rm");
    });
});

describe("bucketFromRules — precedence between rule families", () => {
    it("prefers vendor over category and keywords", () => {
        const match = bucketFromRules({
            vendor: "Trontek Electronics Limited",
            category: "Software/SaaS",
            description: "annual subscription",
        });
        expect(match?.bucket).toBe("rm");
        expect(match?.rule).toBe("vendor:trontek");
    });

    it("prefers category over keywords", () => {
        const match = bucketFromRules({
            category: "Travel",
            description: "cloud hosting renewal",
        });
        expect(match?.bucket).toBe("misc");
        expect(match?.rule).toBe("category:travel");
    });
});

describe("resolveBucket", () => {
    it("lets a rule override the model", () => {
        // The stability guarantee: a named vendor cannot change bucket because a
        // model answered differently on a later run.
        const r = resolveBucket({
            vendor: "Trontek Electronics Limited",
            aiBucket: "tech",
            aiConfidence: 0.99,
        });
        expect(r.bucket).toBe("rm");
        expect(r.source).toBe("rule");
    });

    it("uses the model when no rule matches", () => {
        const r = resolveBucket({
            vendor: "Unknown Supplier",
            aiBucket: "tech",
            aiConfidence: 0.9,
        });
        expect(r.bucket).toBe("tech");
        expect(r.source).toBe("ai");
    });

    it("falls back to others below the confidence floor", () => {
        const r = resolveBucket({
            vendor: "Unknown Supplier",
            aiBucket: "tech",
            aiConfidence: 0.3,
        });
        expect(r.bucket).toBe("others");
        expect(r.source).toBe("default");
        expect(r.detail).toContain("30%");
    });

    it("accepts a model answer that carries no confidence", () => {
        const r = resolveBucket({ vendor: "Unknown Supplier", aiBucket: "misc" });
        expect(r.bucket).toBe("misc");
        expect(r.source).toBe("ai");
    });

    it("rejects a bucket value outside the taxonomy", () => {
        const r = resolveBucket({ vendor: "Unknown Supplier", aiBucket: "capex", aiConfidence: 1 });
        expect(r.bucket).toBe("others");
        expect(r.source).toBe("default");
    });

    it("always returns a real bucket so the tiles sum to the total", () => {
        // Nothing known at all — still bucketed, never null. A row missing from
        // the four tiles would make them fail to add up to the header figure.
        const r = resolveBucket({});
        expect(EXPENSE_BUCKET_VALUES).toContain(r.bucket);
        expect(r.source).toBe("default");
    });
});

describe("rule tables", () => {
    it("only ever names buckets that exist in the taxonomy", () => {
        for (const [, bucket] of VENDOR_BUCKET_RULES) {
            expect(EXPENSE_BUCKET_VALUES).toContain(bucket);
        }
        for (const bucket of Object.values(CATEGORY_BUCKET_RULES)) {
            expect(EXPENSE_BUCKET_VALUES).toContain(bucket);
        }
        for (const [bucket] of KEYWORD_BUCKET_RULES) {
            expect(EXPENSE_BUCKET_VALUES).toContain(bucket);
        }
    });

    it("holds vendor fragments already normalised, or they can never match", () => {
        for (const [fragment] of VENDOR_BUCKET_RULES) {
            expect(fragment).toBe(fragment.toLowerCase().replace(/\s+/g, " ").trim());
        }
    });

    it("holds category keys already normalised", () => {
        for (const key of Object.keys(CATEGORY_BUCKET_RULES)) {
            expect(key).toBe(key.toLowerCase());
        }
    });
});

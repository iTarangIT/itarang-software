// ID 124 — Correct GSTIN for a Won lead (lead + onboarding application together).
import { describe, expect, it } from "vitest";
import { LeadGstinCorrectionError, canCorrectLeadGstin, planGstinCorrection } from "../correctLeadGstinRules";

const GOOD = "07AAACB1234C1ZH";
const OTHER = "06AAACB1234C1ZJ";
const plan = (over: Partial<Parameters<typeof planGstinCorrection>[0]> = {}) =>
    planGstinCorrection({ leadStatus: "Won", currentGstin: OTHER, newGstin: GOOD, reason: "typo at Mark Won", ...over });
const refusal = (fn: () => unknown) => {
    try {
        fn();
    } catch (err) {
        expect(err).toBeInstanceOf(LeadGstinCorrectionError);
        return err as LeadGstinCorrectionError;
    }
    throw new Error("expected a refusal");
};

describe("planGstinCorrection", () => {
    it("normalises the new GSTIN and keeps the old one for the log", () => {
        expect(plan({ newGstin: " 07aaacb1234c1zh " })).toEqual({ from: OTHER, to: GOOD, reason: "typo at Mark Won" });
        expect(plan({ currentGstin: null }).from).toBeNull();
    });

    it("is for Won leads only; a Converted dealer is corrected on the account", () => {
        expect(refusal(() => plan({ leadStatus: "Converted" })).message).toMatch(/account/);
        expect(refusal(() => plan({ leadStatus: "Converted" })).status).toBe(409);
        for (const s of ["Under_Discussion", "Lost", null]) {
            expect(refusal(() => plan({ leadStatus: s })).status, String(s)).toBe(409);
        }
    });

    it("refuses a bad, own or unchanged GSTIN, and a missing reason", () => {
        expect(refusal(() => plan({ newGstin: "07AAACB1234C1Z" })).status).toBe(400);
        expect(refusal(() => plan({ newGstin: "07AALFI7813E1ZC" })).message).toMatch(/iTarang's own/);
        expect(refusal(() => plan({ currentGstin: GOOD.toLowerCase() })).message).toMatch(/already/);
        expect(refusal(() => plan({ reason: "  " })).status).toBe(400);
    });
});

describe("canCorrectLeadGstin", () => {
    it("the owner, the Sales Head or admin", () => {
        expect(canCorrectLeadGstin({ role: "inside_sales_rep", userId: "u1", ownerId: "u1" })).toBe(true);
        expect(canCorrectLeadGstin({ role: "sales_head", userId: "u9", ownerId: "u1" })).toBe(true);
        expect(canCorrectLeadGstin({ role: "admin", userId: "u9", ownerId: null })).toBe(true);
        expect(canCorrectLeadGstin({ role: "inside_sales_rep", userId: "u2", ownerId: "u1" })).toBe(false);
        expect(canCorrectLeadGstin({ role: "ceo", userId: "u9", ownerId: "u1" })).toBe(false);
    });
});

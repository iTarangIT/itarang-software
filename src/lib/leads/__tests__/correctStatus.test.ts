import { describe, expect, it } from "vitest";
import { CorrectionInputError, planCorrection } from "../correctStatus";

const GSTIN = "07AAACB1234C1Z5";

describe("admin Correct status — what a closing correction must carry (ID 57 / 80)", () => {
    it("Lost needs a lost reason", () => {
        expect(() => planCorrection({ to: "Lost" })).toThrow(CorrectionInputError);
        expect(() => planCorrection({ to: "Lost", lostReason: null })).toThrow(CorrectionInputError);
        expect(planCorrection({ to: "Lost", lostReason: "price_high" })).toEqual({
            toLostReason: "price_high",
            needsOnboarding: false,
        });
    });

    it("'Lost to competition' names the competitor; other reasons ignore one", () => {
        expect(() => planCorrection({ to: "Lost", lostReason: "lost_to_competition" })).toThrow(CorrectionInputError);
        expect(() =>
            planCorrection({ to: "Lost", lostReason: "lost_to_competition", competitorName: "  " }),
        ).toThrow(CorrectionInputError);
        expect(planCorrection({ to: "Lost", lostReason: "lost_to_competition", competitorName: " Okaya " })).toEqual({
            toLostReason: "lost_to_competition",
            competitorName: "Okaya",
            needsOnboarding: false,
        });
        expect(planCorrection({ to: "Lost", lostReason: "price_high", competitorName: "Okaya" })).toEqual({
            toLostReason: "price_high",
            needsOnboarding: false,
        });
    });

    it("Won and Converted need a valid GSTIN — typed, or already on the lead", () => {
        for (const to of ["Won", "Converted"] as const) {
            expect(() => planCorrection({ to }), to).toThrow(CorrectionInputError);
            expect(() => planCorrection({ to, existingGstin: "not-a-gstin" }), to).toThrow(CorrectionInputError);
            expect(planCorrection({ to, existingGstin: GSTIN }), to).toEqual({ needsOnboarding: true });
            expect(planCorrection({ to, gstin: " 07aaacb1234c1z5 " }), to).toEqual({
                gstin: GSTIN,
                needsOnboarding: true,
            });
        }
    });

    it("a typed GSTIN that is malformed is refused even when the lead already has one", () => {
        expect(() => planCorrection({ to: "Won", gstin: "07AAACB1234", existingGstin: GSTIN })).toThrow(
            CorrectionInputError,
        );
    });

    it("every other status needs nothing extra, and carries no lost reason or GSTIN", () => {
        for (const to of ["New_Unassigned", "Under_Discussion", "Commercials_Finalised", "Transferred_to_ASM"] as const) {
            expect(planCorrection({ to, lostReason: "price_high", gstin: GSTIN }), to).toEqual({
                needsOnboarding: false,
            });
        }
    });

    it("the refusal carries HTTP 400 for withErrorHandler", () => {
        try {
            planCorrection({ to: "Lost" });
            throw new Error("expected a refusal");
        } catch (err) {
            expect(err).toBeInstanceOf(CorrectionInputError);
            expect((err as CorrectionInputError).status).toBe(400);
        }
    });
});

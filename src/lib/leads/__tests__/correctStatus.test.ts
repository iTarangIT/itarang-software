import { describe, expect, it } from "vitest";
import { LEAD_STATUS } from "@/lib/lifecycle/transitions";
import { CorrectionInputError, correctionAllowedTo, planCorrection } from "../correctStatus";

describe("admin Correct status — what a closing correction must carry (ID 57 / 80)", () => {
    it("Lost needs a lost reason", () => {
        expect(() => planCorrection({ to: "Lost" })).toThrow(CorrectionInputError);
        expect(() => planCorrection({ to: "Lost", lostReason: null })).toThrow(CorrectionInputError);
        expect(planCorrection({ to: "Lost", lostReason: "price_high" })).toEqual({ toLostReason: "price_high" });
    });

    it("'Lost to competition' names the competitor; other reasons ignore one", () => {
        expect(() => planCorrection({ to: "Lost", lostReason: "lost_to_competition" })).toThrow(CorrectionInputError);
        expect(() =>
            planCorrection({ to: "Lost", lostReason: "lost_to_competition", competitorName: "  " }),
        ).toThrow(CorrectionInputError);
        expect(planCorrection({ to: "Lost", lostReason: "lost_to_competition", competitorName: " Okaya " })).toEqual({
            toLostReason: "lost_to_competition",
            competitorName: "Okaya",
        });
        expect(planCorrection({ to: "Lost", lostReason: "price_high", competitorName: "Okaya" })).toEqual({
            toLostReason: "price_high",
        });
    });

    it("every other open status needs nothing extra, and carries no lost reason", () => {
        for (const to of ["New_Unassigned", "Under_Discussion", "Commercials_Finalised", "Transferred_to_ASM"] as const) {
            expect(planCorrection({ to, lostReason: "price_high" }), to).toEqual({});
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

describe("Correct status cannot bypass onboarding (ID 133)", () => {
    it("Converted is refused — it comes only from approval of the dealer's onboarding", () => {
        expect(() => planCorrection({ to: "Converted" })).toThrow(CorrectionInputError);
        expect(() => planCorrection({ to: "Converted" })).toThrow(/onboarding is approved/);
    });

    it("Won is refused — it comes only from Mark Won", () => {
        expect(() => planCorrection({ to: "Won" })).toThrow(CorrectionInputError);
        expect(() => planCorrection({ to: "Won" })).toThrow(/Mark Won/);
    });

    it("the editor offers every status except those two", () => {
        expect(LEAD_STATUS.filter((s) => !correctionAllowedTo(s))).toEqual(["Won", "Converted"]);
    });
});

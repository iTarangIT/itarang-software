import { describe, expect, it } from "vitest";

import { LostReasonChangeError, planLostReasonChange } from "../changeLostReasonRules";

const base = { leadStatus: "Lost", currentReason: "price_high", currentCompetitor: null, note: "wrong reason picked" };

describe("Change Lost reason (ID 136)", () => {
    it("changes the reason of a Lost lead", () => {
        expect(planLostReasonChange({ ...base, to: "not_interested" })).toEqual({
            from: "price_high",
            to: "not_interested",
            competitorName: null,
            note: "wrong reason picked",
        });
    });

    it("refuses a lead that is not Lost, with 409", () => {
        try {
            planLostReasonChange({ ...base, leadStatus: "Won", to: "not_interested" });
            expect.unreachable();
        } catch (e) {
            expect(e).toBeInstanceOf(LostReasonChangeError);
            expect((e as LostReasonChangeError).status).toBe(409);
        }
    });

    it("needs a note and, for competition, the competitor", () => {
        expect(() => planLostReasonChange({ ...base, to: "not_interested", note: "abc" })).toThrow(LostReasonChangeError);
        expect(() => planLostReasonChange({ ...base, to: "lost_to_competition" })).toThrow(/competitor/);
        expect(planLostReasonChange({ ...base, to: "lost_to_competition", competitorName: " Okaya " }).competitorName).toBe("Okaya");
    });

    it("refuses the same reason, but a new competitor name is a change", () => {
        expect(() => planLostReasonChange({ ...base, to: "price_high" })).toThrow(/already/);
        const comp = { ...base, currentReason: "lost_to_competition", currentCompetitor: "Okaya" };
        expect(() => planLostReasonChange({ ...comp, to: "lost_to_competition", competitorName: "Okaya" })).toThrow(/already/);
        expect(planLostReasonChange({ ...comp, to: "lost_to_competition", competitorName: "Exide" }).competitorName).toBe("Exide");
    });

    it("leaves onboarding drop-out to the drop-out review", () => {
        expect(() => planLostReasonChange({ ...base, to: "onboarding_dropout" })).toThrow(LostReasonChangeError);
    });
});

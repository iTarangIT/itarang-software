import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
const { statusAfterVisit } = await import("../visitStatus");

describe("statusAfterVisit (ID 77)", () => {
    it("a visit ends Awaiting field visit at Under discussion at least", () => {
        expect(statusAfterVisit({ current: "Transferred_to_ASM", preTransfer: "Assigned_Not_Contacted", requested: null })).toBe("Under_Discussion");
    });
    it("restores the stage the lead had before the transfer when it is further along", () => {
        expect(statusAfterVisit({ current: "Transferred_to_ASM", preTransfer: "Commercials_Finalised", requested: "Under_Discussion" })).toBe("Commercials_Finalised");
    });
    it("an ASM cannot pick a commercials stage (ID 75/80)", () => {
        expect(statusAfterVisit({ current: "Transferred_to_ASM", preTransfer: "Under_Discussion", requested: "Commercials_Explained" })).toBe("Under_Discussion");
    });
    it("elsewhere, only a forward choice moves the lead", () => {
        expect(statusAfterVisit({ current: "Commercials_Explained", preTransfer: null, requested: "Under_Discussion" })).toBeNull();
        expect(statusAfterVisit({ current: "Assigned_Not_Contacted", preTransfer: null, requested: "Under_Discussion" })).toBe("Under_Discussion");
        expect(statusAfterVisit({ current: "Under_Discussion", preTransfer: null, requested: null })).toBeNull();
    });
});

import { describe, expect, it } from "vitest";
import { decideLeadMatch, ownerAndCredit, similarNames, type MatchLead } from "../leadMatchRules";

const lead = (id: string, over: Partial<MatchLead> = {}): MatchLead => ({
    id,
    lead_status: "Under_Discussion",
    current_owner_id: "u1",
    held_by_app: null,
    held_by_approved: false,
    created_at: "2026-10-01",
    ...over,
});
const empty = { gstin: [], phone: [], email: [], namePlace: [] };

describe("ID 214: the match ladder", () => {
    it("takes the GSTIN match first, automatically", () => {
        const d = decideLeadMatch({ ...empty, gstin: [lead("G")], phone: [lead("P")] }, "app1");
        expect(d).toMatchObject({ kind: "link", method: "gstin", lead: { id: "G" } });
    });

    it("takes a phone match only when exactly one lead has it", () => {
        expect(decideLeadMatch({ ...empty, phone: [lead("P")] }, "app1")).toMatchObject({ kind: "link", method: "phone" });
        const two = decideLeadMatch({ ...empty, phone: [lead("P1"), lead("P2")] }, "app1");
        expect(two.kind).toBe("possible");
    });

    it("falls to email, then to a similar name for Admin to choose", () => {
        expect(decideLeadMatch({ ...empty, email: [lead("E")] }, "app1")).toMatchObject({ kind: "link", method: "email" });
        expect(decideLeadMatch({ ...empty, namePlace: [lead("N")] }, "app1")).toMatchObject({ kind: "possible" });
    });

    it("creates a Direct onboarding lead when nothing matches", () => {
        expect(decideLeadMatch(empty, "app1")).toEqual({ kind: "create" });
    });

    it("treats a matched lead already Converted as another shop: a new lead", () => {
        const d = decideLeadMatch({ ...empty, gstin: [lead("G", { lead_status: "Converted", held_by_app: "old", held_by_approved: true })] }, "app1");
        expect(d).toMatchObject({ kind: "new_shop", of: { id: "G" } });
    });

    it("keeps the lead this application already holds", () => {
        const d = decideLeadMatch({ ...empty, phone: [lead("P1"), lead("P2", { held_by_app: "app1" })] }, "app1");
        expect(d).toMatchObject({ kind: "link", lead: { id: "P2" } });
    });

    it("asks Admin when another open application holds the lead", () => {
        const d = decideLeadMatch({ ...empty, phone: [lead("P", { held_by_app: "draft" })] }, "app1");
        expect(d.kind).toBe("possible");
    });
});

describe("ID 214: owner and credit", () => {
    it("an existing owner keeps the lead and the credit", () => {
        expect(ownerAndCredit({ leadOwnerId: "o", salespersonId: "s", salesHeadId: "h" })).toEqual({ ownerId: "o", creditUserId: "o" });
    });
    it("no owner: the salesperson on the form owns it, with credit", () => {
        expect(ownerAndCredit({ leadOwnerId: null, salespersonId: "s", salesHeadId: "h" })).toEqual({ ownerId: "s", creditUserId: "s" });
    });
    it("self-onboarded: the Sales Head owns it, no credit", () => {
        expect(ownerAndCredit({ leadOwnerId: null, salespersonId: null, salesHeadId: "h" })).toEqual({ ownerId: "h", creditUserId: null });
    });
});

describe("ID 214: similar names", () => {
    it("ignores business words and punctuation", () => {
        expect(similarNames("M/s Sharda Enterprises", "Sharda Traders")).toBe(true);
        expect(similarNames("Sharda Batteries", "Sharda")).toBe(true);
        expect(similarNames("Om", "Om Sai")).toBe(false);
        expect(similarNames("Ganesh Auto", "Shiv Auto")).toBe(false);
    });
});

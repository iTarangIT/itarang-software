import { describe, expect, it } from "vitest";
import { checkStatusMove, isForward } from "@/lib/lifecycle/statusRules";
import { TRANSITION_MAP } from "@/lib/lifecycle/transitions";

describe("checkStatusMove", () => {
    it("progress moves forward only", () => {
        expect(checkStatusMove({ from: "Under_Discussion", to: "Commercials_Explained", event: "progress" }).ok).toBe(true);
        expect(checkStatusMove({ from: "Commercials_Finalised", to: "Under_Discussion", event: "progress" }).ok).toBe(false);
        expect(checkStatusMove({ from: null, to: "Under_Discussion", event: "progress" }).ok).toBe(true);
        expect(checkStatusMove({ from: "Transferred_to_ASM", to: "Under_Discussion", event: "progress" }).ok).toBe(false);
    });

    it("progress never closes, transfers or touches a closed lead", () => {
        expect(checkStatusMove({ from: "Under_Discussion", to: "Converted", event: "progress" }).ok).toBe(false);
        expect(checkStatusMove({ from: "Under_Discussion", to: "Lost", event: "progress" }).ok).toBe(false);
        expect(checkStatusMove({ from: "Under_Discussion", to: "Transferred_to_ASM", event: "progress" }).ok).toBe(false);
        expect(checkStatusMove({ from: "Lost", to: "Under_Discussion", event: "progress" }).ok).toBe(false);
    });

    it("transfer only from an open stage", () => {
        expect(checkStatusMove({ from: "Commercials_Finalised", to: "Transferred_to_ASM", event: "transfer" }).ok).toBe(true);
        expect(checkStatusMove({ from: "Converted", to: "Transferred_to_ASM", event: "transfer" }).ok).toBe(false);
    });

    it("Won, Converted and Lost only through their events, from open stages (ID 74)", () => {
        expect(checkStatusMove({ from: "Commercials_Finalised", to: "Won", event: "mark_won" }).ok).toBe(true);
        expect(checkStatusMove({ from: "Won", to: "Converted", event: "onboarding_approved" }).ok).toBe(true);
        expect(checkStatusMove({ from: "Under_Discussion", to: "Converted", event: "progress" }).ok).toBe(false);
        expect(checkStatusMove({ from: "Under_Discussion", to: "Won", event: "progress" }).ok).toBe(false);
        expect(checkStatusMove({ from: "Lost", to: "Converted", event: "onboarding_approved" }).ok).toBe(false);
        expect(checkStatusMove({ from: "Commercials_Finalised", to: "Lost", event: "mark_lost" }).ok).toBe(true);
        expect(checkStatusMove({ from: "Won", to: "Transferred_to_ASM", event: "transfer" }).ok).toBe(false);
        expect(checkStatusMove({ from: "Converted", to: "Lost", event: "mark_lost" }).ok).toBe(false);
        expect(checkStatusMove({ from: "Converted", to: "Lost", event: "dropout_lost" }).ok).toBe(true);
    });

    it("reactivation reopens closed leads at the start only", () => {
        expect(checkStatusMove({ from: "Lost", to: "Assigned_Not_Contacted", event: "reactivation" }).ok).toBe(true);
        expect(checkStatusMove({ from: "Lost", to: "Commercials_Finalised", event: "reactivation" }).ok).toBe(false);
        expect(checkStatusMove({ from: "Under_Discussion", to: "New_Unassigned", event: "reactivation" }).ok).toBe(false);
    });

    it("a Won lead whose onboarding fell through re-engages from the start (ID 84)", () => {
        expect(checkStatusMove({ from: "Won", to: "Assigned_Not_Contacted", event: "reactivation" }).ok).toBe(true);
        expect(checkStatusMove({ from: "Won", to: "New_Unassigned", event: "reactivation" }).ok).toBe(true);
        expect(checkStatusMove({ from: "Won", to: "Under_Discussion", event: "reactivation" }).ok).toBe(false);
    });

    it("correction needs a reason and allows any move except to Won or Converted", () => {
        expect(checkStatusMove({ from: "Commercials_Finalised", to: "Under_Discussion", event: "correction" }).ok).toBe(false);
        expect(
            checkStatusMove({ from: "Commercials_Finalised", to: "Under_Discussion", event: "correction", reason: "wrong tap" }).ok,
        ).toBe(true);
        expect(checkStatusMove({ from: "Won", to: "Lost", event: "correction", reason: "wrong tap" }).ok).toBe(true);
        expect(checkStatusMove({ from: "Converted", to: "Won", event: "correction", reason: "wrong tap" }).ok).toBe(false);
    });

    it("no correction reaches Converted or Won, from any status (ID 133)", () => {
        for (const from of ["New_Unassigned", "Under_Discussion", "Commercials_Finalised", "Won", "Lost", null] as const) {
            for (const to of ["Converted", "Won"] as const) {
                if (from === to) continue;
                const verdict = checkStatusMove({ from, to, event: "correction", reason: "admin says so" });
                expect(verdict.ok, `${from} → ${to}`).toBe(false);
            }
        }
    });

    it("only a visit ends Awaiting field visit, restoring a later stage (ID 77)", () => {
        expect(checkStatusMove({ from: "Transferred_to_ASM", to: "Under_Discussion", event: "progress" }).ok).toBe(false);
        expect(checkStatusMove({ from: "Transferred_to_ASM", to: "Under_Discussion", event: "visit" }).ok).toBe(true);
        expect(checkStatusMove({ from: "Transferred_to_ASM", to: "Commercials_Finalised", event: "visit" }).ok).toBe(true);
        expect(checkStatusMove({ from: "Transferred_to_ASM", to: "Won", event: "visit" }).ok).toBe(false);
    });

    it("a withdrawn quote sends a commercials-stage lead back to Under discussion (ID 78)", () => {
        for (const from of ["Commercials_Explained", "Awaiting_Customer_Decision"] as const) {
            expect(checkStatusMove({ from, to: "Under_Discussion", event: "quote_withdrawn" }).ok, from).toBe(true);
        }
        expect(checkStatusMove({ from: "Under_Discussion", to: "Assigned_Not_Contacted", event: "quote_withdrawn" }).ok).toBe(false);
    });

    it("but never out of Commercials finalised — after the dealer's yes only Mark Won / Mark Lost leave it", () => {
        const verdict = checkStatusMove({ from: "Commercials_Finalised", to: "Under_Discussion", event: "quote_withdrawn" });
        expect(verdict.ok).toBe(false);
        expect(checkStatusMove({ from: "Commercials_Finalised", to: "Won", event: "mark_won" }).ok).toBe(true);
        expect(checkStatusMove({ from: "Commercials_Finalised", to: "Lost", event: "mark_lost" }).ok).toBe(true);
    });

    it("a same-status move is a no-op, not a refusal (ID 115.6)", () => {
        expect(checkStatusMove({ from: "Under_Discussion", to: "Under_Discussion", event: "progress" })).toEqual({ ok: true, noop: true });
        expect(checkStatusMove({ from: "Lost", to: "Lost", event: "mark_lost" })).toEqual({ ok: true, noop: true });
        expect(checkStatusMove({ from: "Converted", to: "Converted", event: "onboarding_approved" })).toEqual({ ok: true, noop: true });
        // A real move carries no noop flag.
        expect(checkStatusMove({ from: "Assigned_Not_Contacted", to: "Under_Discussion", event: "progress" })).toEqual({ ok: true });
    });

    it("Won → Lost only with the admin override (ID 115.4)", () => {
        const refused = checkStatusMove({ from: "Won", to: "Lost", event: "mark_lost" });
        expect(refused.ok).toBe(false);
        expect(refused.ok === false && refused.reason).toMatch(/admin/);
        expect(checkStatusMove({ from: "Won", to: "Lost", event: "mark_lost", adminOverride: false }).ok).toBe(false);
        expect(checkStatusMove({ from: "Won", to: "Lost", event: "mark_lost", adminOverride: true }).ok).toBe(true);
        // The override never reopens a closed lead.
        expect(checkStatusMove({ from: "Converted", to: "Lost", event: "mark_lost", adminOverride: true }).ok).toBe(false);
    });

    it("the rep's status menu offers neither the current status nor Lost on a Won lead", () => {
        expect(TRANSITION_MAP.Under_Discussion).not.toContain("Under_Discussion");
        expect(TRANSITION_MAP.Under_Discussion).toContain("Lost");
        expect(TRANSITION_MAP.Won).not.toContain("Lost");
        expect(TRANSITION_MAP.Won).not.toContain("Won");
    });

    it("a dealer approval ends Awaiting field visit at once (ID 77 option A)", () => {
        expect(checkStatusMove({ from: "Transferred_to_ASM", to: "Commercials_Finalised", event: "quote_approved" }).ok).toBe(true);
        expect(checkStatusMove({ from: "Awaiting_Customer_Decision", to: "Commercials_Finalised", event: "quote_approved" }).ok).toBe(true);
        expect(checkStatusMove({ from: "Transferred_to_ASM", to: "Under_Discussion", event: "quote_approved" }).ok).toBe(false);
        expect(checkStatusMove({ from: "Won", to: "Commercials_Finalised", event: "quote_approved" }).ok).toBe(false);
        expect(checkStatusMove({ from: "Lost", to: "Commercials_Finalised", event: "quote_approved" }).ok).toBe(false);
        // A plain progress move still cannot leave Awaiting field visit.
        expect(checkStatusMove({ from: "Transferred_to_ASM", to: "Commercials_Finalised", event: "progress" }).ok).toBe(false);
    });

    it("isForward treats legacy statuses as the start", () => {
        expect(isForward("some_legacy", "Assigned_Not_Contacted")).toBe(true);
        expect(isForward("Converted", "Under_Discussion")).toBe(false);
    });
});

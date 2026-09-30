import { describe, expect, it } from "vitest";
import { checkStatusMove, isForward } from "@/lib/lifecycle/statusRules";

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
        expect(checkStatusMove({ from: "Won", to: "Lost", event: "mark_lost" }).ok).toBe(true);
        expect(checkStatusMove({ from: "Won", to: "Transferred_to_ASM", event: "transfer" }).ok).toBe(false);
        expect(checkStatusMove({ from: "Converted", to: "Lost", event: "mark_lost" }).ok).toBe(false);
        expect(checkStatusMove({ from: "Converted", to: "Lost", event: "dropout_lost" }).ok).toBe(true);
    });

    it("reactivation reopens closed leads at the start only", () => {
        expect(checkStatusMove({ from: "Lost", to: "Assigned_Not_Contacted", event: "reactivation" }).ok).toBe(true);
        expect(checkStatusMove({ from: "Lost", to: "Commercials_Finalised", event: "reactivation" }).ok).toBe(false);
        expect(checkStatusMove({ from: "Under_Discussion", to: "New_Unassigned", event: "reactivation" }).ok).toBe(false);
    });

    it("correction needs a reason and allows any move", () => {
        expect(checkStatusMove({ from: "Commercials_Finalised", to: "Under_Discussion", event: "correction" }).ok).toBe(false);
        expect(
            checkStatusMove({ from: "Commercials_Finalised", to: "Under_Discussion", event: "correction", reason: "wrong tap" }).ok,
        ).toBe(true);
    });

    it("only a visit ends Awaiting field visit, restoring a later stage (ID 77)", () => {
        expect(checkStatusMove({ from: "Transferred_to_ASM", to: "Under_Discussion", event: "progress" }).ok).toBe(false);
        expect(checkStatusMove({ from: "Transferred_to_ASM", to: "Under_Discussion", event: "visit" }).ok).toBe(true);
        expect(checkStatusMove({ from: "Transferred_to_ASM", to: "Commercials_Finalised", event: "visit" }).ok).toBe(true);
        expect(checkStatusMove({ from: "Transferred_to_ASM", to: "Won", event: "visit" }).ok).toBe(false);
    });

    it("a withdrawn quote sends a commercials-stage lead back to Under discussion (ID 78)", () => {
        expect(checkStatusMove({ from: "Commercials_Finalised", to: "Under_Discussion", event: "quote_withdrawn" }).ok).toBe(true);
        expect(checkStatusMove({ from: "Under_Discussion", to: "Assigned_Not_Contacted", event: "quote_withdrawn" }).ok).toBe(false);
    });

    it("refuses a no-op", () => {
        expect(checkStatusMove({ from: "Under_Discussion", to: "Under_Discussion", event: "progress" }).ok).toBe(false);
    });

    it("isForward treats legacy statuses as the start", () => {
        expect(isForward("some_legacy", "Assigned_Not_Contacted")).toBe(true);
        expect(isForward("Converted", "Under_Discussion")).toBe(false);
    });
});

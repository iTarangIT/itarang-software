// Tests for the E-300 idle-clock rule (review R-04, metric M18, Req #6 point 7):
// only a call, visit or real status change counts as working a lead. The cases
// that matter most are the ones that must NOT count — each is a way a lead
// could be made to look fresh without anyone working it.

import { describe, expect, it } from "vitest";
import { isWorkedTouchpoint } from "@/lib/lifecycle/touchpointTypes";

describe("isWorkedTouchpoint", () => {
    it("counts a logged call of any outcome, with or without a status change", () => {
        expect(isWorkedTouchpoint("inside_sales_call", false)).toBe(true);
        expect(isWorkedTouchpoint("inside_sales_call", true)).toBe(true);
    });

    it("counts a logged visit", () => {
        expect(isWorkedTouchpoint("visit", false)).toBe(true);
    });

    it("counts a status_change_note only when it carries a status change", () => {
        expect(isWorkedTouchpoint("status_change_note", true)).toBe(true);
        // Bulk-upload call notes, reactivation notes, NeoDove delete flags.
        expect(isWorkedTouchpoint("status_change_note", false)).toBe(false);
    });

    // Tracker ID 80: an admin's Correct status repairs the record — nobody
    // spoke to the dealer, so the idle clock must not move.
    it("does not count an admin correction, though it is a status_change_note with a status change", () => {
        expect(isWorkedTouchpoint("status_change_note", true, "correction")).toBe(false);
        // Mark Won / Mark Lost are the same touchpoint type and still count.
        expect(isWorkedTouchpoint("status_change_note", true, "mark_won")).toBe(true);
        expect(isWorkedTouchpoint("status_change_note", true, "mark_lost")).toBe(true);
        expect(isWorkedTouchpoint("status_change_note", true, null)).toBe(true);
        // A call is work whatever rides on it.
        expect(isWorkedTouchpoint("inside_sales_call", true, "correction")).toBe(true);
    });

    it("does not count hand-offs, even though they move lead_status", () => {
        expect(isWorkedTouchpoint("lead_claimed", true)).toBe(false);
        expect(isWorkedTouchpoint("lead_assigned", true)).toBe(false);
        expect(isWorkedTouchpoint("asm_transfer", true)).toBe(false);
        expect(isWorkedTouchpoint("ownership_transfer", false)).toBe(false);
    });

    it("does not count the AI dialer, dial requests, comments or messages", () => {
        expect(isWorkedTouchpoint("ai_call", false)).toBe(false);
        expect(isWorkedTouchpoint("neodove_dial_request", false)).toBe(false);
        expect(isWorkedTouchpoint("escalation_ceo_comment", false)).toBe(false);
        expect(isWorkedTouchpoint("whatsapp", false)).toBe(false);
        expect(isWorkedTouchpoint("quote_sent", false)).toBe(false);
        expect(isWorkedTouchpoint("reactivated_via_admin", true)).toBe(false);
    });
});

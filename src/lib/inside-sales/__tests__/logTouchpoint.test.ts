import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
const { planTouchpoint, UnknownDispositionError, TouchpointBodySchema } = await import("../logTouchpoint");

const lead = { leadId: "DL-1", fromStatus: "Under_Discussion" as const, actorId: "isr-1" };
const body = (b: Record<string, unknown>) => TouchpointBodySchema.parse({ touchpoint_type: "inside_sales_call", ...b });

// The rules below were the touchpoint route's; they must survive the extraction unchanged.
describe("planTouchpoint (extracted from POST /api/inside-sales/lead/[id]/touchpoint)", () => {
    it("a connected disposition → call_status connected, auto-engaged, sheet casing and bucket", () => {
        const p = planTouchpoint(body({ disposition: { connect_status: "connected", label: "price high" } }), lead);
        expect(p).toMatchObject({
            dealerLeadId: "DL-1",
            performedBy: "isr-1",
            callStatus: "connected",
            isEngaged: true,
            disposition: { label: "Price High", bucket: "Warm", connectStatus: "connected" },
            dispositionSource: "inside_sales",
        });
    });

    it("a not-connected reason maps to the five-value call_status and is not engaged", () => {
        const p = planTouchpoint(body({ disposition: { connect_status: "not_connected", label: "Switch off" } }), lead);
        expect(p.callStatus).toBe("not_reachable");
        expect(p.isEngaged).toBe(false);
        expect(p.disposition?.bucket).toBeNull();
    });

    it("the rep's bucket settles the Warm/Hot tie for Commercials Explained", () => {
        const p = planTouchpoint(body({ disposition: { connect_status: "connected", label: "Commercials Explained", bucket: "Hot" } }), lead);
        expect(p.disposition?.bucket).toBe("Hot");
    });

    it("a disposition outside the sheet, or under the wrong connect status, is refused", () => {
        expect(() => planTouchpoint(body({ disposition: { connect_status: "connected", label: "Very interested" } }), lead)).toThrow(UnknownDispositionError);
        expect(() => planTouchpoint(body({ disposition: { connect_status: "connected", label: "Did not pick" } }), lead)).toThrow(UnknownDispositionError);
    });

    it("status change: from the lead's current status; Converted/Lost close as is_phone", () => {
        expect(planTouchpoint(body({ status_change: { to: "Lost", reason_notes: "x" } }), lead).statusChange).toEqual({
            from: "Under_Discussion", to: "Lost", reasonNotes: "x", closingRole: "is_phone",
        });
        expect(planTouchpoint(body({ status_change: { to: "Commercials_Explained" } }), lead).statusChange?.closingRole).toBeUndefined();
    });

    it("explicit is_engaged and call_status win when no disposition says otherwise", () => {
        const p = planTouchpoint(body({ is_engaged: false, call_status: "connected" }), lead);
        expect(p).toMatchObject({ isEngaged: false, callStatus: "connected" });
    });

    it("next action and time carry through", () => {
        const p = planTouchpoint(body({ next_action: "follow_up", next_action_at: "2026-09-26T05:30:00.000Z" }), lead);
        expect(p.nextAction).toBe("follow_up");
        expect(p.nextActionAt?.toISOString()).toBe("2026-09-26T05:30:00.000Z");
    });
});

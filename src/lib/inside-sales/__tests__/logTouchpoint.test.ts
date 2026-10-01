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

    it("no manual status (ID 80/114): commercials requests are dropped; the outcome rule sets first contact", () => {
        expect(planTouchpoint(body({ status_change: { to: "Commercials_Explained", reason_notes: "x" } }), lead).statusChange).toBeUndefined();
        const fresh = { ...lead, fromStatus: "Assigned_Not_Contacted" as const };
        expect(
            planTouchpoint(body({ disposition: { connect_status: "connected", label: "Commercials Explained", bucket: "Hot" } }), fresh).statusChange,
        ).toEqual({ from: "Assigned_Not_Contacted", to: "Under_Discussion", reasonNotes: null, event: "progress" });
        expect(planTouchpoint(body({ status_change: { to: "Under_Discussion" } }), fresh).statusChange?.to).toBe("Under_Discussion");
    });

    it("Converted / Lost / Transferred_to_ASM cannot be set from a touchpoint (ID 57)", () => {
        for (const to of ["Converted", "Lost", "Transferred_to_ASM"]) {
            expect(() => body({ status_change: { to } })).toThrow();
        }
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

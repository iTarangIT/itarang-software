// ID 51 smaller gaps: withdrawal roles, update_appointment offline fallback,
// Financing-queue deep link into the lead's Financing tab.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/db/schema", () => ({ ecofyLeadActivities: {}, ecofyLeads: {} }));

import { checkEcofyAction, ecofyLeadHref } from "../access";
import { ecofyActionSchema } from "../actionSchemas";
import { ECOFY_LEAD_TABS, initialEcofyTab, withEcofyTab } from "../leadTabs";
import { isEcofyUnavailable, localKindFor } from "../localActivities";
import { EcofyCallError } from "../service";

const worker = { id: "u-isr", role: "inside_sales_rep" };
const manager = { id: "u-sh", role: "sales_head" };

describe("Withdrawal (M14) — OpenAPI x-roles", () => {
    it("the assigned ISR / ASM may request (ITARANG_CALLER) but not decide (ITARANG_ADMIN only)", () => {
        const lead = { assigned_to_user_id: worker.id, stage: "S5" };
        expect(checkEcofyAction(worker, lead, "request_withdrawal").ok).toBe(true);
        for (const a of ["withdrawal_confirm", "withdrawal_reject", "withdrawal_epc_informed"] as const) {
            expect(checkEcofyAction(worker, lead, a)).toMatchObject({ ok: false, status: 403 });
            expect(checkEcofyAction(manager, lead, a).ok).toBe(true);
        }
    });
    it("a worker cannot request on someone else's lead; nobody requests after disbursement (S8)", () => {
        expect(checkEcofyAction(worker, { assigned_to_user_id: "other", stage: "S4" }, "request_withdrawal")).toMatchObject({ status: 404 });
        expect(checkEcofyAction(manager, { assigned_to_user_id: null, stage: "S8" }, "request_withdrawal")).toMatchObject({ status: 409 });
    });
    it("the Withdrawal tab is part of the lead page", () => {
        expect(ECOFY_LEAD_TABS).toContain("Withdrawal");
    });
});

describe("Offline fallback (E-308) covers update_appointment", () => {
    it("keeps meeting outcomes under kind 'appointment' (the E-308 CHECK allows activity | appointment)", () => {
        const input = ecofyActionSchema.parse({ action: "update_appointment", appointmentId: "a-1", op: "NO_SHOW", outcomeReason: "not home" });
        expect(localKindFor(input)).toBe("appointment");
        const resched = ecofyActionSchema.parse({ action: "update_appointment", appointmentId: "a-1", op: "RESCHEDULE", scheduledAt: "2026-10-06T10:00:00.000Z" });
        expect(localKindFor(resched)).toBe("appointment");
    });
    it("still keeps calls and bookings, and never stage moves", () => {
        expect(localKindFor(ecofyActionSchema.parse({ action: "log_activity", type: "REMARK", note: "x" }))).toBe("activity");
        expect(localKindFor(ecofyActionSchema.parse({ action: "book_appointment", meetingType: "PHONE", scheduledAt: "2026-10-06T10:00:00.000Z" }))).toBe("appointment");
        expect(localKindFor(ecofyActionSchema.parse({ action: "advance", version: 3 }))).toBeNull();
        expect(localKindFor(ecofyActionSchema.parse({ action: "request_withdrawal", reason: "changed mind" }))).toBeNull();
    });
    it("queues only when Ecofy is unavailable, not on a gate / validation answer", () => {
        expect(isEcofyUnavailable(new EcofyCallError("down", 503))).toBe(true);
        expect(isEcofyUnavailable(new EcofyCallError("refused", 403))).toBe(true);
        expect(isEcofyUnavailable(new EcofyCallError("gate", 409, "GATE_NOT_MET"))).toBe(false);
        expect(isEcofyUnavailable(new EcofyCallError("bad", 422))).toBe(false);
    });
});

describe("Financing queue → lead Financing tab", () => {
    it("builds the deep link and opens the tab", () => {
        const href = withEcofyTab(ecofyLeadHref("sales_head", "L1"), "Financing");
        expect(href).toBe("/sales-head/ecofy/leads/L1?tab=Financing");
        expect(withEcofyTab("/x?y=1", "Financing")).toBe("/x?y=1&tab=Financing");
        expect(initialEcofyTab("Financing")).toBe("Financing");
        expect(initialEcofyTab("Nope")).toBe("Timeline");
        expect(initialEcofyTab(null)).toBe("Timeline");
    });
});

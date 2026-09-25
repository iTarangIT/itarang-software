import { describe, expect, it } from "vitest";
import {
    ECOFY_OUTBOUND_ACTOR,
    ECOFY_OUTBOUND_ASSIGNEE,
    canViewEcofyLead,
    checkEcofyAction,
    ecofyLeadHref,
    ecofyViewerKind,
} from "../access";
import { ecofyActionSchema } from "../actionSchemas";

describe("Ecofy outbound identity (D1: Ecofy never learns who handles a lead)", () => {
    it("uses fixed organisation labels, never a person", () => {
        expect(ECOFY_OUTBOUND_ACTOR).toBe("iTarang CRM");
        expect(ECOFY_OUTBOUND_ASSIGNEE).toBe("iTarang team");
        // Ecofy's inbound schema requires assigneeName to be 1..200 chars.
        expect(ECOFY_OUTBOUND_ASSIGNEE.length).toBeGreaterThan(0);
        expect(ECOFY_OUTBOUND_ASSIGNEE.length).toBeLessThanOrEqual(200);
    });
});

const SH = { id: "sh-1", role: "sales_head" };
const ASM = { id: "asm-1", role: "asm" };
const ISR = { id: "isr-1", role: "inside_sales_rep" };
const mine = (stage: string) => ({ assigned_to_user_id: "asm-1", stage });

describe("Ecofy access (E-307)", () => {
    it("maps roles to manager / worker / none", () => {
        expect(ecofyViewerKind("sales_head")).toBe("manager");
        expect(ecofyViewerKind("ceo")).toBe("manager");
        expect(ecofyViewerKind("ASM")).toBe("worker");
        expect(ecofyViewerKind("inside_sales_rep")).toBe("worker");
        expect(ecofyViewerKind("dealer")).toBeNull();
        expect(ecofyViewerKind(undefined)).toBeNull();
    });

    it("workers only see their own leads; the Sales Head sees all", () => {
        expect(canViewEcofyLead(ASM, mine("S2"))).toBe(true);
        expect(canViewEcofyLead(ISR, mine("S2"))).toBe(false);
        expect(canViewEcofyLead(SH, { assigned_to_user_id: null, stage: "S1" })).toBe(true);
        expect(canViewEcofyLead({ id: "x", role: "dealer" }, mine("S2"))).toBe(false);
    });

    it("someone else's lead is a 404, not a 403", () => {
        const r = checkEcofyAction(ISR, mine("S2"), "log_activity");
        expect(r).toMatchObject({ ok: false, status: 404 });
    });

    it("keeps admin acts with the Sales Head", () => {
        for (const a of ["return", "reopen", "financing_decision", "withdrawal_confirm", "delete_document", "assign"] as const) {
            expect(checkEcofyAction(ASM, mine("S2"), a)).toMatchObject({ ok: false, status: 403 });
        }
        expect(checkEcofyAction(SH, mine("S2"), "return").ok).toBe(true);
    });

    it("lets the assigned worker do caller work", () => {
        expect(checkEcofyAction(ASM, mine("S2"), "log_activity").ok).toBe(true);
        expect(checkEcofyAction(ASM, mine("S2"), "advance").ok).toBe(true);
        expect(checkEcofyAction(ASM, mine("S3"), "confirm_assessment").ok).toBe(true);
        expect(checkEcofyAction(ASM, mine("S5"), "verify_otp").ok).toBe(true);
        expect(checkEcofyAction(ASM, mine("S4"), "close").ok).toBe(true);
    });

    it("applies Ecofy's stage rules", () => {
        expect(checkEcofyAction(SH, mine("S3"), "advance")).toMatchObject({ ok: false, status: 409 });
        expect(checkEcofyAction(SH, mine("S5"), "close")).toMatchObject({ ok: false, status: 409 });
        expect(checkEcofyAction(SH, mine("S3"), "return")).toMatchObject({ ok: false, status: 409 });
        expect(checkEcofyAction(SH, mine("CLOSED"), "reopen").ok).toBe(true);
        expect(checkEcofyAction(SH, mine("CLOSED"), "log_activity").ok).toBe(false);
    });

    it("links each role to its own route", () => {
        expect(ecofyLeadHref("asm", "L1")).toBe("/asm/ecofy-leads/L1");
        expect(ecofyLeadHref("inside_sales_rep", "L1")).toBe("/inside-sales/ecofy-leads/L1");
        expect(ecofyLeadHref("sales_head", "L1")).toBe("/sales-head/ecofy/leads/L1");
    });
});

describe("Ecofy action schema (E-307)", () => {
    it("accepts a valid call and requires its outcome", () => {
        expect(ecofyActionSchema.safeParse({ action: "log_activity", type: "CALL", callOutcome: "BUSY" }).success).toBe(true);
        expect(ecofyActionSchema.safeParse({ action: "log_activity", type: "CALL" }).success).toBe(false);
    });

    it("requires a date for a follow-up and a partner for an EPC visit", () => {
        expect(ecofyActionSchema.safeParse({ action: "log_activity", type: "FOLLOW_UP" }).success).toBe(false);
        expect(
            ecofyActionSchema.safeParse({ action: "book_appointment", meetingType: "EPC_VISIT", scheduledAt: "2026-09-25T10:00:00.000Z" }).success,
        ).toBe(false);
        expect(
            ecofyActionSchema.safeParse({ action: "book_appointment", meetingType: "PHONE", scheduledAt: "2026-09-25T10:00:00.000Z" }).success,
        ).toBe(true);
    });

    it("rejects unknown actions and bad OTPs", () => {
        expect(ecofyActionSchema.safeParse({ action: "push" }).success).toBe(false);
        expect(ecofyActionSchema.safeParse({ action: "verify_otp", challengeId: "c1", code: "12345" }).success).toBe(false);
        expect(ecofyActionSchema.safeParse({ action: "verify_otp", challengeId: "c1", code: "123456" }).success).toBe(true);
    });

    it("needs the case version for If-Match actions", () => {
        expect(ecofyActionSchema.safeParse({ action: "advance" }).success).toBe(false);
        expect(ecofyActionSchema.safeParse({ action: "advance", version: 3 }).success).toBe(true);
        expect(ecofyActionSchema.safeParse({ action: "close", version: 3, closureReason: "UNREACHABLE" }).success).toBe(true);
        expect(ecofyActionSchema.safeParse({ action: "close", version: 3, closureReason: "BORED" }).success).toBe(false);
    });
});

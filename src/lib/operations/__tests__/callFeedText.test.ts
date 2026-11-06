import { describe, expect, it } from "vitest";
import { callFeedAlertAudience, callFeedAlertEmail, isTestMailbox, istWhen, workingGapText } from "../callFeedText";

describe("ID 229: call feed text", () => {
    it("prints working time as hours and minutes", () => {
        expect(workingGapText(125)).toBe("2 h 5 m");
        expect(workingGapText(40)).toBe("40 m");
        expect(workingGapText(null)).toBe("—");
    });
    it("prints IST time, or never", () => {
        expect(istWhen(null)).toBe("never");
        expect(istWhen("2026-11-05T09:02:00Z")).toMatch(/5 Nov/);
    });
});

describe("call-feed alarm audience and email (6 Nov)", () => {
    it("live: bell to ops, admin, CEO, Sales Head; email to CEO and Sales Head", () => {
        expect(callFeedAlertAudience("calls.feed_gap", "https://crm.itarang.com")).toEqual({
            bellRoles: ["operations", "admin", "ceo", "sales_head"],
            emailRoles: ["ceo", "sales_head"],
        });
    });
    it("sandbox, or any other metric: ops bell only, no email", () => {
        expect(callFeedAlertAudience("calls.feed_gap", "https://sandbox.itarang.com")).toEqual({ bellRoles: ["operations"], emailRoles: [] });
        expect(callFeedAlertAudience("db.latency", "https://crm.itarang.com")).toEqual({ bellRoles: ["operations"], emailRoles: [] });
        expect(callFeedAlertAudience("calls.feed_gap", undefined).emailRoles).toEqual([]);
    });
    it("skips e2e test mailboxes", () => {
        expect(isTestMailbox("e2e-sh@itarang.com")).toBe(true);
        expect(isTestMailbox("anirudh@itarang.com")).toBe(false);
    });
    it("plain-words email", () => {
        const w = callFeedAlertEmail("warn", "neodove", "x");
        expect(w.subject).toBe("[iTarang CRM] Warning: no NeoDove calls for over 2 working hours");
        expect(w.text).toContain("crm.itarang.com (not the sandbox)");
        expect(callFeedAlertEmail("crit", "ai_dialer", "x").subject).toContain("Urgent: no AI dialer results for over 4");
        expect(callFeedAlertEmail("resolved", "neodove", "x").subject).toBe("[iTarang CRM] NeoDove calls are reaching the CRM again");
    });
});

import { describe, expect, it } from "vitest";
import { isOpenDraftStatus, pushedLeadNoticeBody } from "../pushedLeads";

describe("ID 33 — pushed leads in the WhatsApp console", () => {
    it("keeps the old draft rule for WhatsApp-created leads", () => {
        expect(isOpenDraftStatus(null, false)).toBe(true);
        expect(isOpenDraftStatus("pending", false)).toBe(true);
        expect(isOpenDraftStatus("draft", false)).toBe(true);
        expect(isOpenDraftStatus("not_started", false)).toBe(false);
        expect(isOpenDraftStatus("not_required", false)).toBe(false);
    });

    it("treats a pushed web lead's Step-1 state as a draft", () => {
        expect(isOpenDraftStatus("not_started", true)).toBe(true);
        expect(isOpenDraftStatus("not_required", true)).toBe(true);
    });

    it("never offers a lead that has moved on, pushed or not", () => {
        for (const s of ["pending_itarang_verification", "loan_sanctioned", "dispatched", "sold"]) {
            expect(isOpenDraftStatus(s, true)).toBe(false);
            expect(isOpenDraftStatus(s, false)).toBe(false);
        }
    });

    it("words the notice for the dealer and points at Save Drafts", () => {
        const body = pushedLeadNoticeBody({ greetName: "Rushikesh", customerName: "Ravi Kumar", referenceId: "REF-1" });
        expect(body).toContain("Hi Rushikesh");
        expect(body).toContain("*Ravi Kumar*");
        expect(body).toContain("REF-1");
        expect(body).toContain("*Save Drafts*");
    });
});

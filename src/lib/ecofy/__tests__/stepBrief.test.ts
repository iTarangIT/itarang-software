import { describe, expect, it } from "vitest";
import { eligibilitySentFromTimeline, factsNeededFor, isEcofyFinancier, stepBrief, type StepBriefInput } from "../stepBrief";

const base: StepBriefInput = {
    stage: "S2",
    subStatus: null,
    owner: "ECOFY",
    financierName: "Ecofy",
    viewerKind: "worker",
    viewerIsAssignee: true,
    assigneeName: "Rahul",
    assigneeRole: "asm",
    facts: {},
};
const asm = (over: Partial<StepBriefInput>) => stepBrief({ ...base, ...over });
const head = (over: Partial<StepBriefInput>) => stepBrief({ ...base, viewerKind: "manager", viewerIsAssignee: false, ...over });

describe("stepBrief — who acts, per stage", () => {
    it("S0 is Ecofy's for everyone", () => {
        for (const b of [asm({ stage: "S0" }), head({ stage: "S0" })]) {
            expect(b.party).toBe("ecofy");
            expect(b.partyLabel).toBe("Pending from Ecofy");
            expect(b.tone).toBe("waiting");
            expect(b.primary).toBe("none");
        }
    });

    it("S1 is the Sales Head's: manager acts, worker waits", () => {
        const h = head({ stage: "S1", assigneeName: null, assigneeRole: null });
        expect(h).toMatchObject({ party: "you", partyLabel: "Your action", tone: "action", primary: "assign" });
        const w = asm({ stage: "S1", viewerIsAssignee: false, assigneeName: null, assigneeRole: null });
        expect(w).toMatchObject({ party: "sales_head", partyLabel: "Pending from Sales Head", tone: "waiting", primary: "assign" });
    });

    it("S2 walks book → complete → advance on the meeting facts", () => {
        expect(asm({ facts: {} }).primary).toBe("book_meeting");
        expect(asm({ facts: { scheduledMeeting: true } }).primary).toBe("complete_meeting");
        const done = asm({ facts: { scheduledMeeting: true, completedMeeting: true } });
        expect(done.primary).toBe("advance");
        expect(done.gate).toMatch(/Gate met/);
        expect(done.next).toMatch(/Assessment \(S3\)/);
    });

    it("owner steps read differently for assignee, manager and a stranger", () => {
        expect(asm({}).partyLabel).toBe("Your action");
        expect(head({})).toMatchObject({ party: "owner", partyLabel: "With Rahul (ASM) · you can also act", tone: "action" });
        expect(head({ assigneeName: null, assigneeRole: null })).toMatchObject({ party: "you", partyLabel: "Your action · no owner yet", tone: "action" });
        expect(asm({ viewerIsAssignee: false })).toMatchObject({ party: "owner", partyLabel: "With Rahul (ASM)", tone: "waiting" });
    });

    it("S3 asks for an assessment, then its confirmation", () => {
        expect(asm({ stage: "S3", facts: { latestAssessment: null } }).primary).toBe("new_assessment");
        expect(asm({ stage: "S3", facts: { latestAssessment: { confirmed: false } } }).primary).toBe("confirm_assessment");
        // a confirmed latest while still at S3 (race) falls back to a new assessment
        expect(asm({ stage: "S3", facts: { latestAssessment: { confirmed: true } } }).primary).toBe("new_assessment");
    });

    it("S4 ELIGIBILITY_PENDING: not sent → send; sent → waits on the lender", () => {
        expect(asm({ stage: "S4", subStatus: "ELIGIBILITY_PENDING", facts: { eligibilitySent: false } })).toMatchObject({ primary: "send_eligibility", party: "you" });
        const ecofy = asm({ stage: "S4", subStatus: "ELIGIBILITY_PENDING", facts: { eligibilitySent: true } });
        expect(ecofy).toMatchObject({ primary: "await_eligibility", party: "ecofy", tone: "waiting" });
        const other = asm({ stage: "S4", subStatus: "ELIGIBILITY_PENDING", financierName: "Bajaj", facts: { eligibilitySent: true } });
        expect(other).toMatchObject({ primary: "await_eligibility", party: "sales_head", partyLabel: "Pending from Sales Head" });
        expect(head({ stage: "S4", subStatus: "ELIGIBILITY_PENDING", financierName: "Bajaj", facts: { eligibilitySent: true } }).party).toBe("you");
    });

    it("S4 NOT_ELIGIBLE routes (Sales Head), QUOTE_PENDING uploads, OFFER_READY composes then sends", () => {
        expect(asm({ stage: "S4", subStatus: "NOT_ELIGIBLE" })).toMatchObject({ primary: "route_financier", party: "sales_head", tone: "waiting" });
        expect(head({ stage: "S4", subStatus: "NOT_ELIGIBLE" })).toMatchObject({ primary: "route_financier", party: "you" });
        expect(asm({ stage: "S4", subStatus: "QUOTE_PENDING" }).primary).toBe("upload_quote");
        expect(asm({ stage: "S4", subStatus: "OFFER_READY", facts: { activeQuote: false } }).primary).toBe("upload_quote");
        expect(asm({ stage: "S4", subStatus: "OFFER_READY", facts: { activeQuote: true, liveOffer: null } }).primary).toBe("compose_offer");
        expect(asm({ stage: "S4", subStatus: "OFFER_READY", facts: { activeQuote: true, liveOffer: { status: "DRAFT" } } }).primary).toBe("send_otp");
    });

    it("S5 is the owner entering the customer's OTP", () => {
        expect(asm({ stage: "S5", subStatus: "OTP_SENT" })).toMatchObject({ primary: "verify_otp", party: "you", tone: "action" });
    });

    it("S6 AWAITING_DECISION waits on Ecofy; the manager gets the form only when a decision is open", () => {
        expect(asm({ stage: "S6", subStatus: "AWAITING_DECISION", facts: { openDecision: true } })).toMatchObject({ primary: "await_decision", party: "ecofy" });
        expect(head({ stage: "S6", subStatus: "AWAITING_DECISION", facts: { openDecision: true } })).toMatchObject({ primary: "financing_decision", party: "ecofy", tone: "waiting" });
        expect(head({ stage: "S6", subStatus: "AWAITING_DECISION", facts: { openDecision: false } }).primary).toBe("await_decision");
        expect(head({ stage: "S6", subStatus: "AWAITING_DECISION", financierName: "Bajaj", facts: { openDecision: true } })).toMatchObject({ primary: "financing_decision", party: "you", tone: "action" });
    });

    it("S6 REACCEPTANCE_PENDING is the owner's once the OTP is live, Ecofy's before", () => {
        expect(asm({ stage: "S6", subStatus: "REACCEPTANCE_PENDING", facts: { reacceptanceLive: true } })).toMatchObject({ primary: "verify_reacceptance", party: "you" });
        expect(asm({ stage: "S6", subStatus: "REACCEPTANCE_PENDING", facts: { reacceptanceLive: false } })).toMatchObject({ primary: "verify_reacceptance", party: "ecofy" });
        expect(asm({ stage: "S6", subStatus: "REJECTED_ROUTING" })).toMatchObject({ primary: "route_financier", party: "sales_head" });
    });

    it("S7: create → progress with proof gate → disbursement", () => {
        expect(asm({ stage: "S7", subStatus: "INSTALLING", facts: { installation: null } }).primary).toBe("create_installation");
        const progress = asm({ stage: "S7", subStatus: "INSTALLING", facts: { installation: { status: "IN_PROGRESS" }, photos: 0, letters: 1 } });
        expect(progress).toMatchObject({ primary: "installation_progress", party: "epc", tone: "action" });
        expect(progress.gate).toBe("Before INSTALLED, upload an installation photo.");
        const both = asm({ stage: "S7", subStatus: "INSTALLING", facts: { installation: { status: "IN_PROGRESS" }, photos: 0, letters: 0 } });
        expect(both.gate).toBe("Before INSTALLED, upload an installation photo and the customer acceptance letter.");
        const ok = asm({ stage: "S7", subStatus: "INSTALLING", facts: { installation: { status: "IN_PROGRESS" }, photos: 2, letters: 1 } });
        expect(ok.gate).toMatch(/^Proof uploaded/);
        expect(asm({ stage: "S7", subStatus: "INSTALLED", viewerIsAssignee: false, facts: { installation: { status: "IN_PROGRESS" } } }).tone).toBe("waiting");
        const disb = head({ stage: "S7", subStatus: "INSTALLED", facts: { installation: { status: "INSTALLED" }, downPaymentRecorded: false } });
        expect(disb).toMatchObject({ primary: "disbursement", party: "ecofy", gate: "Down payment not recorded yet." });
        expect(head({ stage: "S7", subStatus: "INSTALLED", financierName: "Bajaj", facts: { installation: { status: "COMMISSIONED" } } })).toMatchObject({ primary: "disbursement", party: "you" });
    });

    it("S8 and CLOSED are done; only a manager may reopen", () => {
        expect(asm({ stage: "S8" })).toMatchObject({ tone: "done", primary: "none", partyLabel: "Done — with Ecofy" });
        expect(asm({ stage: "CLOSED" })).toMatchObject({ tone: "done", primary: "none", partyLabel: "Closed" });
        expect(head({ stage: "CLOSED" })).toMatchObject({ tone: "done", primary: "reopen" });
    });

    it("unknown stage degrades to waiting for Ecofy", () => {
        expect(asm({ stage: null })).toMatchObject({ party: "ecofy", primary: "none" });
    });
});

describe("stepBrief helpers", () => {
    it("isEcofyFinancier: null or any 'Ecofy…' name is Ecofy", () => {
        expect(isEcofyFinancier(null)).toBe(true);
        expect(isEcofyFinancier("Ecofy")).toBe(true);
        expect(isEcofyFinancier("Ecofy Green Finance")).toBe(true);
        expect(isEcofyFinancier("Bajaj")).toBe(false);
    });

    it("factsNeededFor lists only the reads a stage's card uses", () => {
        expect(factsNeededFor("S1")).toEqual([]);
        expect(factsNeededFor("S4")).toEqual(["assessments", "quotes", "offers", "timeline"]);
        expect(factsNeededFor("S7")).toEqual(["installation", "documents", "payment-status"]);
    });

    it("eligibilitySentFromTimeline: a request after the last decision means 'sent'", () => {
        expect(eligibilitySentFromTimeline(null)).toBe(false);
        expect(eligibilitySentFromTimeline([{ at: "2026-09-01T10:00:00Z", kind: "stage" }])).toBe(false);
        expect(eligibilitySentFromTimeline([{ at: "2026-09-01T10:00:00Z", kind: "eligibility.requested" }])).toBe(true);
        expect(
            eligibilitySentFromTimeline([
                { at: "2026-09-01T10:00:00Z", kind: "eligibility.requested" },
                { at: "2026-09-01T11:00:00Z", kind: "eligibility.decided" },
            ]),
        ).toBe(false);
        expect(
            eligibilitySentFromTimeline([
                { at: "2026-09-01T11:00:00Z", kind: "eligibility.decided" },
                { at: "2026-09-02T09:00:00Z", kind: "eligibility.requested" },
                { at: "2026-09-01T10:00:00Z", kind: "eligibility.requested" },
            ]),
        ).toBe(true);
    });
});

import { describe, expect, it } from "vitest";
import {
    attemptsWords,
    dayWords,
    handoverNoteInWords,
    lastActionFact,
    missingDealerDetails,
    nextStepFor,
    nextVisitFact,
    paymentFact,
    quoteFact,
    timeLimitLine,
    type NextStepFacts,
} from "../leadPage246";

function facts(over: Partial<NextStepFacts> = {}): NextStepFacts {
    return {
        view: "asm",
        status: "Under_Discussion",
        todayIst: "2026-11-18",
        nextBookingDate: null,
        hasOpenBooking: false,
        nextBookingOverdueDays: null,
        nextBookingBookedAt: null,
        nextFollowUpAt: null,
        lastNote: null,
        onboarding: null,
        hasApprovedQuote: false,
        hasPendingQuote: false,
        lostReasonWords: null,
        ...over,
    };
}

describe("dayWords", () => {
    it("reads a calendar day with its weekday", () => {
        expect(dayWords("2026-10-30")).toBe("Fri 30 Oct");
        expect(dayWords("2026-06-29")).toBe("Mon 29 Jun");
        expect(dayWords("2026-09-18", false)).toBe("18 Sept");
    });
    it("takes the IST day of an instant", () => {
        // 20:00 UTC on 29 Jun is 30 Jun 01:30 IST.
        expect(dayWords("2026-06-29T20:00:00Z")).toBe("Tue 30 Jun");
    });
});

describe("nextStepFor — test 1 (LOkesh): an overdue booked visit", () => {
    const step = nextStepFor(
        facts({
            hasOpenBooking: true,
            nextBookingDate: "2026-10-30",
            nextBookingOverdueDays: 19,
            nextBookingBookedAt: "2026-09-18T06:27:00Z",
            lastNote: "Bajaj finance and explained, but he looking for another option.",
        }),
    );
    it("says when the visit was due and how many days overdue", () => {
        expect(step.title).toBe("Visit was due Fri 30 Oct: 19 days overdue");
        expect(step.detail).toBe('Booked 18 Sept. Last note: "Bajaj finance and explained, but he looking for another option."');
    });
    it("offers Log visit first, then Re-plan visit and Call now", () => {
        expect(step.actions).toEqual(["log_visit", "replan_visit", "call_now"]);
    });
    it("the Inside Sales page offers Log activity instead (it logs calls)", () => {
        expect(nextStepFor(facts({ view: "isr", hasOpenBooking: true, nextBookingDate: "2026-10-30", nextBookingOverdueDays: 2 })).actions).toEqual([
            "log_activity",
            "call_now",
        ]);
    });
    it("one day reads in the singular", () => {
        expect(nextStepFor(facts({ hasOpenBooking: true, nextBookingDate: "2026-11-17", nextBookingOverdueDays: 1 })).title).toBe(
            "Visit was due Tue 17 Nov: 1 day overdue",
        );
    });
});

describe("nextStepFor — test 2 (Test Dealer): Won, onboarding stuck in draft", () => {
    const step = nextStepFor(
        facts({
            status: "Won",
            hasOpenBooking: true,
            nextBookingDate: "2026-06-29",
            nextBookingOverdueDays: 142,
            onboarding: {
                applicationId: "552a46cc-1111-2222-3333-444455556666",
                status: "draft",
                createdAt: "2026-06-29T08:57:00Z",
                agreementLabel: null,
                approved: false,
                stalled: true,
            },
        }),
    );
    it("names the stuck draft and its age", () => {
        expect(step.title).toBe("Onboarding stuck in draft: 142 days");
        expect(step.detail).toBe("Application APP-552A46CC started 29 Jun. Agreement not generated, not approved, no approved quote.");
        expect(step.also).toBe("Also: the visit booked for Mon 29 Jun was never logged.");
    });
    it("offers Continue onboarding first and never Mark Won", () => {
        expect(step.actions[0]).toBe("continue_onboarding");
        expect(step.actions).not.toContain("mark_won");
    });
    it("a draft not yet stalled is 'in draft'", () => {
        const s = nextStepFor(
            facts({
                status: "Won",
                onboarding: { applicationId: "abc", status: "draft", createdAt: "2026-11-18T05:00:00Z", agreementLabel: null, approved: false, stalled: false },
            }),
        );
        expect(s.title).toBe("Onboarding in draft: started today");
    });
    it("a submitted onboarding is with the Sales Head", () => {
        const s = nextStepFor(
            facts({
                status: "Won",
                onboarding: { applicationId: "abc", status: "submitted", createdAt: null, agreementLabel: null, approved: false, stalled: false },
            }),
        );
        expect(s.title).toBe("Onboarding submitted: with the Sales Head for review");
        expect(s.actions).not.toContain("continue_onboarding");
        expect(s.actions).not.toContain("mark_won");
    });
});

describe("nextStepFor — other stages", () => {
    it("Lost and Converted offer no action", () => {
        expect(nextStepFor(facts({ status: "Lost", lostReasonWords: "Price too high" }))).toMatchObject({ title: "Lost: Price too high", actions: [] });
        expect(nextStepFor(facts({ status: "Converted" })).actions).toEqual([]);
    });
    it("Transferred to ASM with no dated booking offers Visit not needed (ASM only)", () => {
        expect(nextStepFor(facts({ status: "Transferred_to_ASM", hasOpenBooking: true })).actions).toEqual([
            "log_visit",
            "visit_not_needed",
            "call_now",
        ]);
    });
    it("a booking today", () => {
        expect(nextStepFor(facts({ hasOpenBooking: true, nextBookingDate: "2026-11-18" })).title).toBe("Visit booked for today");
    });
    it("Commercials finalised points at Mark Won", () => {
        expect(nextStepFor(facts({ status: "Commercials_Finalised" })).actions[0]).toBe("mark_won");
    });
    it("an overdue follow-up", () => {
        expect(nextStepFor(facts({ view: "isr", nextFollowUpAt: "2026-11-15T05:00:00Z" })).title).toBe(
            "Follow-up was due Sun 15 Nov: 3 days overdue",
        );
    });
    it("a pending quote", () => {
        expect(nextStepFor(facts({ hasPendingQuote: true })).title).toBe("Quote waiting for CEO approval");
    });
});

describe("handoverNoteInWords — test 2: the hand-over note reads in words", () => {
    it("turns the stored codes into a sentence and keeps the notes", () => {
        // The shape buildTransferRemarks (lib/leads/transferToAsm.ts) writes.
        const remarks =
            "Reason: Commercials_Finalised; Visit: Initial_Visit; Date: 2026-06-29 (morning)\n\nDealer wants the 100Ah model.\n\nPending: GST copy";
        expect(handoverNoteInWords(remarks)).toBe(
            "Dealer agreed to quote. First visit booked for Mon 29 Jun (morning).\nDealer wants the 100Ah model.\nStill pending: GST copy",
        );
    });
    it("no date", () => {
        expect(handoverNoteInWords("Reason: Demo_Requested; Visit: Demo\n\n")).toBe(
            "Demo requested. Demo visit not dated yet.",
        );
    });
    it("text in another shape is left as it is", () => {
        expect(handoverNoteInWords("Please visit soon")).toBe("Please visit soon");
        expect(handoverNoteInWords(null)).toBe("");
    });
});

describe("header facts", () => {
    it("Last action reads as on My visits (244)", () => {
        const now = new Date("2026-11-18T06:00:00Z");
        expect(lastActionFact("Visit", "2026-09-18T06:27:00Z", now)).toEqual({ main: "Visit · 18 Sept, 11:57 am", sub: "2 months ago" });
        expect(lastActionFact("call_back_later", "2026-11-15T06:00:00Z", now)).toEqual({ main: "call back later · 15 Nov, 11:30 am", sub: "3 days ago" });
        expect(lastActionFact(null, null)).toEqual({ main: "No action yet", sub: null });
    });
    it("Next visit", () => {
        expect(nextVisitFact({ hasOpenBooking: true, nextBookingDate: "2026-10-30", nextBookingOverdueDays: 19, todayIst: "2026-11-18" })).toEqual({
            main: "Fri 30 Oct",
            sub: "19 days overdue, never logged",
            late: true,
        });
        expect(nextVisitFact({ hasOpenBooking: false, nextBookingDate: null, nextBookingOverdueDays: null, todayIst: "2026-11-18" }).main).toBe("None booked");
    });
    it("Attempts", () => {
        expect(attemptsWords(1, 0)).toBe("1 visit · 0 calls");
        expect(attemptsWords(0, 3)).toBe("0 visits · 3 calls");
    });
    it("Payment", () => {
        expect(paymentFact(null, null)).toEqual({ main: "Not asked yet", sub: "Cash or finance?" });
        expect(paymentFact({ dealer_payment_terms: "credit", credit_days: 30 }, null).main).toBe("Credit, 30 days");
        expect(paymentFact(null, "finance").main).toBe("Finance");
    });
    it("Quote", () => {
        const q = (o: object) => ({ event_type: "quote_issue", approval_status: "approved", dealer_decision: null, withdrawn_at: null, version_no: 1, final_price: null, ...o });
        expect(quoteFact([]).main).toBe("No quote yet");
        expect(quoteFact([q({ approval_status: "rejected" })])).toMatchObject({ main: "No approved quote", warn: true });
        expect(quoteFact([q({ approval_status: "pending", version_no: 2 })]).main).toBe("v2 waiting for the CEO");
        expect(quoteFact([q({ dealer_decision: "approved", final_price: "52000" })]).main).toBe("Dealer approved v1 · ₹52000");
    });
});

describe("dealer box and the time-limit line", () => {
    it("lists the empty dealer fields", () => {
        expect(
            missingDealerDetails({ dealer_name: "Lokesh", shop_name: "Lokesh Auto", city: "Bilaspur", state: "Chhattisgarh", language: "Hindi", segments: [] }),
        ).toEqual(["Business type", "Found via", "Pincode", "Area", "Segments"]);
    });
    it("one plain line", () => {
        expect(timeLimitLine([], [])).toEqual({ late: false, text: "Time limits: all on time" });
        expect(timeLimitLine(["first field visit within 3 working days"], []).text).toBe(
            "Time limits: 1 missed (first field visit within 3 working days)",
        );
        expect(timeLimitLine([], ["Field visit (3 working days)"]).text).toBe("Time limits: past now: Field visit (3 working days)");
    });
});

import { describe, expect, it } from "vitest";
import {
    CALL_CATEGORIES,
    CALL_CATEGORY_LABELS,
    CALL_CATEGORY_ORDER,
    callbackDueAt,
    categorizeCall,
    parseClockTime,
    type CategoryAnalysis,
} from "../callCategory";
import type { RetryWindow } from "../retryPolicy";

// IST wall clock → Date.
const ist = (s: string) => new Date(`${s}+05:30`);
const WINDOW: RetryWindow = { start: "09:00", end: "19:00", days: ["mon", "tue", "wed", "thu", "fri", "sat"] };

function a(over: Partial<CategoryAnalysis["signals"]> = {}, rest: Partial<CategoryAnalysis> = {}): CategoryAnalysis {
    return {
        band: "Cold",
        call_status: "complete",
        info_signals_count: 0,
        ...rest,
        signals: {
            lithium_dealer: "unknown",
            relevant_dealer: "yes",
            callback_agreed: "no",
            callback_topic: "none",
            wants_human: "no",
            disqualifier: "none",
            ...over,
        },
    };
}

describe("categorizeCall — not connected", () => {
    it.each([
        ["no_response", "no_response"],
        ["busy", "busy"],
        ["rejected", "busy"],
        ["voicemail", "unavailable"],
        ["switchboard", "unavailable"],
        ["silent", "no_response"],
        ["no_conversation", "no_response"],
        ["hung_up", "hung_up"],
    ] as const)("%s → %s", (status, category) => {
        const r = categorizeCall({ campaignStatus: status, analysis: null });
        expect(r.category).toBe(category);
        expect(r.connected).toBe(false);
        expect(r.callbackOwner).toBeNull();
    });

    it("failed with an invalid number → wrong_number, otherwise failed", () => {
        expect(categorizeCall({ campaignStatus: "failed", callOutcome: "invalid_number", analysis: null }).category).toBe(
            "wrong_number",
        );
        expect(categorizeCall({ campaignStatus: "failed", callOutcome: "no_webhook", analysis: null }).category).toBe(
            "failed",
        );
    });

    it("3 Nov 2026 — the specific reason for every unreached call", () => {
        const cat = (campaignStatus: Parameters<typeof categorizeCall>[0]["campaignStatus"], callOutcome?: string) =>
            categorizeCall({ campaignStatus, callOutcome, analysis: null }).category;
        // Wrong Number: a dead number, whatever status the row landed in.
        expect(cat("failed", "trigger_failed: INVITE failed: sip status: 404: Not Found")).toBe("wrong_number");
        expect(cat("failed", "trigger_failed: sip status: 484 Address Incomplete")).toBe("wrong_number");
        expect(cat("failed", "trigger_failed: sip status: 604")).toBe("wrong_number");
        // Out of Service: switched off / unreachable (classifyCallEnd's outcome).
        expect(cat("no_response", "out_of_service")).toBe("out_of_service");
        // Call Disconnected: the line dropped on the network.
        expect(cat("failed", "call-disconnected")).toBe("disconnected");
        // Early Hang-up.
        expect(cat("hung_up", "early_hangup")).toBe("hung_up");
        // Our own setup failing is not the dealer's outcome.
        expect(cat("failed", "trigger_failed: agent not found")).toBe("failed");
    });

    it("labels read the CRM's words", () => {
        expect(CALL_CATEGORY_LABELS.wrong_number).toBe("Wrong Number");
        expect(CALL_CATEGORY_LABELS.no_response).toBe("No Response");
        expect(CALL_CATEGORY_LABELS.out_of_service).toBe("Out of Service");
        expect(CALL_CATEGORY_LABELS.busy).toBe("Busy");
        expect(CALL_CATEGORY_LABELS.unavailable).toBe("Unavailable");
        expect(CALL_CATEGORY_LABELS.disconnected).toBe("Call Disconnected");
        expect(CALL_CATEGORY_LABELS.hung_up).toBe("Early Hang-up");
        expect(new Set(CALL_CATEGORY_ORDER)).toEqual(new Set(CALL_CATEGORIES));
    });

    it("a dealer who never spoke is never categorised from the transcript", () => {
        const r = categorizeCall({ campaignStatus: "silent", analysis: a({ callback_agreed: "yes" }) });
        expect(r.category).toBe("no_response");
        expect(r.callbackOwner).toBeNull();
    });
});

describe("categorizeCall — connected", () => {
    const done = "completed" as const;

    it("analysis failed → needs_review", () => {
        expect(categorizeCall({ campaignStatus: done, analysis: null, analysisFailed: true }).category).toBe("needs_review");
    });

    it("a firm no beats a callback", () => {
        const r = categorizeCall({
            campaignStatus: done,
            analysis: a({ callback_agreed: "yes", disqualifier: "not_interested" }, { band: "Disqualified" }),
        });
        expect(r.category).toBe("not_interested");
        expect(r.callbackOwner).toBeNull();
    });

    it("D10 — lead-acid dealer in our lines (Warm) keeps his callback", () => {
        const r = categorizeCall({
            campaignStatus: done,
            analysis: a({ lithium_dealer: "no", relevant_dealer: "yes", callback_agreed: "yes" }, { band: "Warm" }),
        });
        expect(r.category).toBe("callback_sales");
        expect(r.callbackOwner).toBe("sales");
    });

    it("not a lithium dealer → not_relevant", () => {
        expect(categorizeCall({ campaignStatus: done, analysis: a({ lithium_dealer: "no" }, { band: "Disqualified" })}).category).toBe(
            "not_relevant",
        );
    });

    it("asked for a person → sales_manager_request, owned by sales (even if not a lithium dealer)", () => {
        for (const lithium of ["unknown", "no"] as const) {
            const r = categorizeCall({ campaignStatus: done, analysis: a({ wants_human: "yes", lithium_dealer: lithium }) });
            expect(r.category).toBe("sales_manager_request");
            expect(r.callbackOwner).toBe("sales");
            expect(r.wantsHuman).toBe(true);
        }
    });

    it.each(["pricing", "negotiation", "dealership", "purchase", "general_info", "none"] as const)(
        "every agreed callback goes to sales — topic %s",
        (topic) => {
            const r = categorizeCall({ campaignStatus: done, analysis: a({ callback_agreed: "yes", callback_topic: topic }) });
            expect(r.category).toBe("callback_sales");
            expect(r.callbackOwner).toBe("sales");
            expect(r.callbackTopic).toBe(topic);
        },
    );

    it("a Qualified lead's simple callback still goes to sales — never an AI re-dial", () => {
        const r = categorizeCall({
            campaignStatus: done,
            analysis: a({ lithium_dealer: "yes", callback_agreed: "yes", callback_topic: "general_info" }, { band: "Qualified" }),
        });
        expect(r.category).toBe("callback_sales");
        expect(r.callbackOwner).toBe("sales");
    });

    it("cut off mid-conversation → disconnected, retried", () => {
        const r = categorizeCall({
            campaignStatus: done,
            analysis: a({ disqualifier: "call_dropped" }, { band: null, call_status: "dropped_empty" }),
        });
        expect(r.category).toBe("disconnected");
        expect(r.retryAsDisconnected).toBe(true);
    });

    it("a dropped call that already Qualified is not retried — it went to sales", () => {
        const r = categorizeCall({
            campaignStatus: done,
            analysis: a({ disqualifier: "call_dropped", lithium_dealer: "yes" }, { band: "Qualified", call_status: "dropped_partial" }),
        });
        expect(r.category).toBe("interested");
        expect(r.retryAsDisconnected).toBe(false);
    });

    it("a dropped call where he agreed to a callback is a callback, not a retry", () => {
        const r = categorizeCall({
            campaignStatus: done,
            analysis: a({ disqualifier: "call_dropped", callback_agreed: "yes" }, { band: "Warm", call_status: "dropped_partial" }),
        });
        expect(r.category).toBe("callback_sales");
        expect(r.retryAsDisconnected).toBe(false);
    });

    it("Qualified or any info signal → interested; nothing → no_interest_signal", () => {
        expect(categorizeCall({ campaignStatus: done, analysis: a({ lithium_dealer: "yes" }, { band: "Qualified" }) }).category).toBe(
            "interested",
        );
        expect(categorizeCall({ campaignStatus: done, analysis: a({}, { info_signals_count: 1 }) }).category).toBe("interested");
        expect(categorizeCall({ campaignStatus: done, analysis: a() }).category).toBe("no_interest_signal");
    });
});

describe("parseClockTime", () => {
    const now = ist("2026-10-23T11:00:00"); // a Friday

    it("evening words make it pm", () => {
        expect(parseClockTime("shaam 5 baje", now)).toEqual(ist("2026-10-23T17:00:00"));
        expect(parseClockTime("शाम को 6 बजे के बाद", now)).toEqual(ist("2026-10-23T18:00:00"));
    });

    it("a bare small hour in a working day is pm", () => {
        expect(parseClockTime("4 baje", now)).toEqual(ist("2026-10-23T16:00:00"));
    });

    it("kal / parso shift the day", () => {
        expect(parseClockTime("kal 11 baje", now)).toEqual(ist("2026-10-24T11:00:00"));
        expect(parseClockTime("parso subah 10 baje", now)).toEqual(ist("2026-10-25T10:00:00"));
    });

    it("a time already gone today means tomorrow", () => {
        expect(parseClockTime("10 baje", now)).toEqual(ist("2026-10-24T10:00:00"));
    });

    it("no clock time → null", () => {
        expect(parseClockTime("baad mein", now)).toBeNull();
        expect(parseClockTime("60V 100Ah", now)).toBeNull();
    });
});

describe("callbackDueAt", () => {
    const now = ist("2026-10-23T11:00:00");

    it("uses a valid model time", () => {
        expect(callbackDueAt({ owner: "sales", callbackAt: "2026-10-23T15:30:00+05:30", now, window: WINDOW })).toEqual(
            ist("2026-10-23T15:30:00"),
        );
    });

    it("ignores a garbage or far-future model time and falls back to his words", () => {
        expect(
            callbackDueAt({ owner: "sales", callbackAt: "next week sometime", callbackWhen: "shaam 5 baje", now, window: WINDOW }),
        ).toEqual(ist("2026-10-23T17:00:00"));
        expect(
            callbackDueAt({ owner: "sales", callbackAt: "2027-06-01T10:00:00+05:30", callbackWhen: "shaam 5 baje", now, window: WINDOW }),
        ).toEqual(ist("2026-10-23T17:00:00"));
    });

    it("reads a delay in his words", () => {
        expect(callbackDueAt({ owner: "ai", callbackWhen: "2 ghante baad", now, window: WINDOW }).getTime()).toBeCloseTo(
            ist("2026-10-23T13:00:00").getTime(),
            -4,
        );
    });

    it("defaults by owner — AI a day later, sales the next working morning (D8)", () => {
        expect(callbackDueAt({ owner: "ai", now, window: WINDOW })).toEqual(ist("2026-10-24T11:00:00"));
        expect(callbackDueAt({ owner: "sales", now, window: WINDOW })).toEqual(ist("2026-10-24T11:00:00"));
    });

    it("D8 — time words without a clock", () => {
        // now = Fri 23 Oct 11:00 IST
        expect(callbackDueAt({ owner: "sales", callbackWhen: "kal shaam", now, window: WINDOW })).toEqual(
            ist("2026-10-24T17:00:00"),
        );
        expect(callbackDueAt({ owner: "sales", callbackWhen: "dopahar mein", now, window: WINDOW })).toEqual(
            ist("2026-10-23T14:00:00"),
        );
        expect(callbackDueAt({ owner: "sales", callbackWhen: "tomorrow", now, window: WINDOW })).toEqual(
            ist("2026-10-24T11:00:00"),
        );
        // "subah" said at 11:00 → tomorrow morning.
        expect(callbackDueAt({ owner: "sales", callbackWhen: "subah", now, window: WINDOW })).toEqual(
            ist("2026-10-24T11:00:00"),
        );
        // A clock time still wins over the word.
        expect(callbackDueAt({ owner: "sales", callbackWhen: "kal shaam 6 baje", now, window: WINDOW })).toEqual(
            ist("2026-10-24T18:00:00"),
        );
    });

    it("D8 — a complaint goes to a person, whatever else was said", () => {
        const r = categorizeCall({
            campaignStatus: "completed",
            analysis: a({ callback_topic: "complaint", disqualifier: "not_interested" }),
        });
        expect(r.callbackOwner).toBe("sales");
        expect(r.callbackTopic).toBe("complaint");
    });

    it("is always moved into the calling window", () => {
        // 9 pm → next opening (Sat 09:00).
        expect(callbackDueAt({ owner: "sales", callbackWhen: "raat 9 baje", now, window: WINDOW })).toEqual(
            ist("2026-10-24T09:00:00"),
        );
        // Saturday + a day = Sunday, closed → Monday 09:00.
        const sat = ist("2026-10-24T12:00:00");
        expect(callbackDueAt({ owner: "ai", now: sat, window: WINDOW })).toEqual(ist("2026-10-26T09:00:00"));
    });
});

describe("categorizeCall — the agent's own call_result on a connected call", () => {
    it("a person saying it is the wrong number → Wrong Number", () => {
        const r = categorizeCall({ campaignStatus: "completed", agentCallResult: "wrong_number", analysis: a() });
        expect(r.category).toBe("wrong_number");
        expect(r.connected).toBe(true);
    });

    it("owner not available, nothing else agreed → Unavailable", () => {
        expect(
            categorizeCall({ campaignStatus: "completed", agentCallResult: "owner_not_available", analysis: a() }).category,
        ).toBe("unavailable");
    });

    it("owner not available but a callback was agreed → still a callback", () => {
        expect(
            categorizeCall({
                campaignStatus: "completed",
                agentCallResult: "owner_not_available",
                analysis: a({ callback_agreed: "yes" }),
            }).category,
        ).toBe("callback_sales");
    });
});

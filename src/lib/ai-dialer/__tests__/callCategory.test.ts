import { describe, expect, it } from "vitest";
import {
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
        ["no_response", "unavailable"],
        ["busy", "unavailable"],
        ["rejected", "unavailable"],
        ["voicemail", "unavailable"],
        ["silent", "unavailable"],
        ["no_conversation", "unavailable"],
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

    it("a dealer who never spoke is never categorised from the transcript", () => {
        const r = categorizeCall({ campaignStatus: "silent", analysis: a({ callback_agreed: "yes" }) });
        expect(r.category).toBe("unavailable");
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

    it("defaults by owner — AI a day later, sales within 2 hours", () => {
        expect(callbackDueAt({ owner: "ai", now, window: WINDOW })).toEqual(ist("2026-10-24T11:00:00"));
        expect(callbackDueAt({ owner: "sales", now, window: WINDOW })).toEqual(ist("2026-10-23T13:00:00"));
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

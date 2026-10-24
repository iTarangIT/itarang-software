import { describe, expect, it } from "vitest";

import {
    ALL_CLOCK_KINDS,
    E350_CLOCK_KINDS,
    clockLimitKey,
    clocksForLead,
    nonHotSpans,
    workingDayCloseDueAt,
    type ClockLead,
    type ClockTouch,
    type QuoteVersion,
} from "@/lib/leads/clockRules";
import { TIME_LIMIT_DEFAULTS, formatLimit, timeLimitDef } from "@/lib/timeLimits/registry";

// 18 Oct rework of IDs 85 / 86 (sheet row 10): non-Hot Ready → assigned
// (#1), the owner clock's Hot / non-Hot limit (#2), no Hot clock after the
// owner already acted (#3), and the two quote clocks (#5).

const ist = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:30`);
/** End of an IST day, as working-day limits fall due. */
const endOf = (day: string) => new Date(new Date(`${day}T23:59:59.999+05:30`).getTime());
const NONE = new Set<string>();
const limits = () => TIME_LIMIT_DEFAULTS;
const LATER = ist("2026-10-30", "12:00");

const lead = (over: Partial<ClockLead> = {}): ClockLead => ({
    id: "L1",
    created_at: ist("2026-10-12", "09:00"),
    sales_ready_at: ist("2026-10-12", "10:00"),
    assigned_at: null,
    current_owner_id: null,
    ...over,
});
const call = (at: Date, by: string, connected = false): ClockTouch => ({ lead_id: "L1", at, by, kind: "call", attempt: true, contact: connected });
const hot = (at: Date) => ({ lead_id: "L1", at, to: "hot" });
const warm = (at: Date) => ({ lead_id: "L1", at, to: "warm" });
const hop = (at: Date, owner_id: string) => ({ lead_id: "L1", at, owner_id });
const version = (over: Partial<QuoteVersion>): QuoteVersion => ({
    lead_id: "L1",
    created_at: ist("2026-10-12", "11:00"),
    approved_at: null,
    delivered_at: null,
    dealer_decision: null,
    dealer_decision_at: null,
    withdrawn_at: null,
    ...over,
});

describe("registry (18 Oct)", () => {
    it("new limits with the agreed defaults", () => {
        expect(TIME_LIMIT_DEFAULTS.ready_to_assigned).toBe(2);
        expect(timeLimitDef("ready_to_assigned")?.unit).toBe("working_days");
        expect(TIME_LIMIT_DEFAULTS.nonhot_owner_first_attempt).toBe(1);
        expect(timeLimitDef("nonhot_owner_first_attempt")?.unit).toBe("working_days");
        expect(TIME_LIMIT_DEFAULTS.quote_approved_not_delivered).toBe(1);
        expect(formatLimit(1, "working_day_close")).toBe("the same working day");
        expect(TIME_LIMIT_DEFAULTS.quote_declined_not_revised).toBe(2);
    });

    it("the three new kinds need E-355; E-350 keeps its seven", () => {
        expect(E350_CLOCK_KINDS).toHaveLength(7);
        expect(ALL_CLOCK_KINDS).toEqual(expect.arrayContaining(["ready_assign", "quote_deliver", "quote_revise"]));
        // lead_clocks / lead_limit_events.clock are varchar(20) after E-355.
        for (const k of ALL_CLOCK_KINDS) expect(k.length).toBeLessThanOrEqual(20);
    });

    it("the owner clock's limit depends on the lead being Hot at the assignment", () => {
        expect(clockLimitKey("owner", true)).toBe("hot_owner_first_attempt");
        expect(clockLimitKey("owner", false)).toBe("nonhot_owner_first_attempt");
        expect(clockLimitKey("ready_assign")).toBe("ready_to_assigned");
    });

    // ID 85 #3 (22 Oct): the settings page said the 4-hour owner limit still
    // applies to hand-overs before 21 Oct — now it does.
    it("an owner stint before 21 Oct keeps the old owner limit, Hot or not", () => {
        expect(clockLimitKey("owner", false, "2026-10-20")).toBe("owner_first_attempt");
        expect(clockLimitKey("owner", true, "2026-10-20")).toBe("owner_first_attempt");
        expect(clockLimitKey("owner", false, "2026-10-21")).toBe("nonhot_owner_first_attempt");
        expect(clockLimitKey("owner", true, "2026-10-21")).toBe("hot_owner_first_attempt");
    });
});

describe("#1 ready → assigned for leads that are not Hot", () => {
    it("2 working days from sales-ready; an owner after that is a 'Limit passed'", () => {
        // Sales-ready Mon 12 Oct → due end of Wed 14 Oct; assigned Thu 15 Oct.
        const clocks = clocksForLead(
            lead({ assigned_at: ist("2026-10-15", "11:00"), current_owner_id: "rep" }),
            [],
            [hop(ist("2026-10-15", "11:00"), "rep")],
            [],
            limits,
            NONE,
            LATER,
        );
        const c = clocks.find((x) => x.clock === "ready_assign")!;
        expect(c.started_at.toISOString()).toBe(ist("2026-10-12", "10:00").toISOString());
        expect(c.due_at?.toISOString()).toBe(endOf("2026-10-14").toISOString());
        expect(c.limit_passed_at?.toISOString()).toBe(endOf("2026-10-14").toISOString());
        expect(c.first_attempt_at?.toISOString()).toBe(ist("2026-10-15", "11:00").toISOString());
        expect(c.owner_id).toBeNull();
    });

    it("assigned within the limit: no miss; a Hot lead gets the Hot clock instead", () => {
        const inTime = clocksForLead(
            lead({ assigned_at: ist("2026-10-13", "11:00"), current_owner_id: "rep" }),
            [],
            [hop(ist("2026-10-13", "11:00"), "rep")],
            [],
            limits,
            NONE,
            LATER,
        ).find((x) => x.clock === "ready_assign")!;
        expect(inTime.limit_passed_at).toBeNull();

        const hotLead = clocksForLead(lead(), [], [], [], limits, NONE, LATER, { interest: [hot(ist("2026-10-12", "09:00"))] });
        expect(hotLead.some((x) => x.clock === "ready_assign")).toBe(false);
        expect(hotLead.some((x) => x.clock === "hot_assign")).toBe(true);
    });

    it("a lead that turns Hot while waiting stops the non-Hot clock there", () => {
        const turned = ist("2026-10-13", "12:00");
        const clocks = clocksForLead(lead(), [], [], [], limits, NONE, LATER, { interest: [hot(turned)] });
        const c = clocks.find((x) => x.clock === "ready_assign")!;
        expect(c.ended_at?.toISOString()).toBe(turned.toISOString());
        expect(c.limit_passed_at).toBeNull();
    });

    it("non-Hot spans are the gaps between Hot spans", () => {
        const spans = nonHotSpans(
            [
                { from: ist("2026-10-12", "12:00"), to: ist("2026-10-13", "12:00") },
                { from: ist("2026-10-14", "12:00"), to: null },
            ],
            ist("2026-10-12", "10:00"),
        );
        expect(spans.map((s) => [s.from.toISOString(), s.to?.toISOString() ?? null])).toEqual([
            [ist("2026-10-12", "10:00").toISOString(), ist("2026-10-12", "12:00").toISOString()],
            [ist("2026-10-13", "12:00").toISOString(), ist("2026-10-14", "12:00").toISOString()],
        ]);
    });
});

describe("#2 owner clock: Hot 4 working hours, others 1 working day", () => {
    // Hand-overs on Mon 26 Oct, after the 21 Oct switch to these limits.
    it("a non-Hot lead's owner has until the end of the next working day", () => {
        const at = ist("2026-10-26", "15:00");
        const owner = clocksForLead(
            lead({ assigned_at: at, current_owner_id: "rep" }),
            [call(ist("2026-10-27", "18:00"), "rep")],
            [hop(at, "rep")],
            [],
            limits,
            NONE,
            LATER,
        ).find((x) => x.clock === "owner")!;
        expect(owner.limit_key).toBe("nonhot_owner_first_attempt");
        expect(owner.due_at?.toISOString()).toBe(endOf("2026-10-27").toISOString());
        // A call the next evening is in time (it would have been late under 4 hours).
        expect(owner.limit_passed_at).toBeNull();
    });

    it("a lead Hot when assigned is timed by the Hot limit", () => {
        const at = ist("2026-10-26", "15:00");
        const owner = clocksForLead(lead({ assigned_at: at, current_owner_id: "rep" }), [], [hop(at, "rep")], [], limits, NONE, LATER, {
            interest: [hot(ist("2026-10-12", "09:00"))],
        }).find((x) => x.clock === "owner")!;
        expect(owner.limit_key).toBe("hot_owner_first_attempt");
        // Mon 15:00 + 4 office hours = Mon 19:00.
        expect(owner.due_at?.toISOString()).toBe(ist("2026-10-26", "19:00").toISOString());
    });
});

describe("#3 no Hot clock when the owner already called or visited", () => {
    const at = ist("2026-10-12", "10:00");
    const turned = ist("2026-10-14", "11:00");

    it("the rep whose own call made the lead Hot gets no fresh 4-hour clock", () => {
        const clocks = clocksForLead(
            lead({ assigned_at: at, current_owner_id: "rep" }),
            [call(ist("2026-10-14", "10:30"), "rep", true)],
            [hop(at, "rep")],
            [],
            limits,
            NONE,
            LATER,
            { interest: [hot(turned)] },
        );
        expect(clocks.some((x) => x.clock === "hot_owner")).toBe(false);
    });

    it("an owner who had not called yet still gets the Hot clock", () => {
        const clocks = clocksForLead(
            lead({ assigned_at: at, current_owner_id: "rep" }),
            [call(ist("2026-10-14", "10:30"), "someone-else")],
            [hop(at, "rep")],
            [],
            limits,
            NONE,
            LATER,
            { interest: [hot(turned)] },
        );
        const h = clocks.find((x) => x.clock === "hot_owner")!;
        expect(h.started_at.toISOString()).toBe(turned.toISOString());
        expect(h.owner_id).toBe("rep");
    });

    it("cooling and turning Hot again does not restart it after the owner acted", () => {
        const clocks = clocksForLead(
            lead({ assigned_at: at, current_owner_id: "rep" }),
            [call(ist("2026-10-13", "12:00"), "rep")],
            [hop(at, "rep")],
            [],
            limits,
            NONE,
            LATER,
            { interest: [hot(ist("2026-10-14", "10:00")), warm(ist("2026-10-15", "10:00")), hot(ist("2026-10-16", "10:00"))] },
        );
        expect(clocks.filter((x) => x.clock === "hot_owner")).toHaveLength(0);
    });
});

describe("#5 quote clocks", () => {
    const owned = { assigned_at: ist("2026-10-12", "10:00"), current_owner_id: "rep" };
    const hops = [hop(ist("2026-10-12", "10:00"), "rep")];

    it("approved quote not delivered: due by the close of the same working day, charged to the owner", () => {
        const approved = ist("2026-10-13", "16:00");
        const late = clocksForLead(lead(owned), [], hops, [], limits, NONE, LATER, {
            quoteVersions: [version({ approved_at: approved, delivered_at: ist("2026-10-14", "10:00") })],
        }).find((x) => x.clock === "quote_deliver")!;
        expect(late.due_at?.toISOString()).toBe(endOf("2026-10-13").toISOString());
        expect(late.limit_passed_at?.toISOString()).toBe(endOf("2026-10-13").toISOString());
        expect(late.owner_id).toBe("rep");

        const sameDay = clocksForLead(lead(owned), [], hops, [], limits, NONE, LATER, {
            quoteVersions: [version({ approved_at: approved, delivered_at: ist("2026-10-13", "18:30") })],
        }).find((x) => x.clock === "quote_deliver")!;
        expect(sameDay.limit_passed_at).toBeNull();
    });

    it("an approval on a Sunday is due by the close of Monday", () => {
        expect(workingDayCloseDueAt(ist("2026-10-18", "12:00"), 1, NONE)?.toISOString()).toBe(endOf("2026-10-19").toISOString());
    });

    it("a newer version ends the old version's delivery clock", () => {
        const c = clocksForLead(lead(owned), [], hops, [], limits, NONE, LATER, {
            quoteVersions: [
                version({ approved_at: ist("2026-10-13", "11:00") }),
                version({ created_at: ist("2026-10-13", "15:00") }),
            ],
        }).find((x) => x.clock === "quote_deliver")!;
        expect(c.ended_at?.toISOString()).toBe(ist("2026-10-13", "15:00").toISOString());
        expect(c.limit_passed_at).toBeNull();
    });

    it("dealer declined: a revised version within 2 working days is in time; none is a miss", () => {
        const declined = ist("2026-10-13", "12:00");
        const revised = clocksForLead(lead(owned), [], hops, [], limits, NONE, LATER, {
            quoteVersions: [
                version({ approved_at: ist("2026-10-12", "12:00"), delivered_at: ist("2026-10-12", "13:00"), dealer_decision: "declined", dealer_decision_at: declined }),
                version({ created_at: ist("2026-10-15", "11:00") }),
            ],
        }).find((x) => x.clock === "quote_revise")!;
        expect(revised.due_at?.toISOString()).toBe(endOf("2026-10-15").toISOString());
        expect(revised.limit_passed_at).toBeNull();

        const none = clocksForLead(lead(owned), [], hops, [], limits, NONE, LATER, {
            quoteVersions: [version({ dealer_decision: "declined", dealer_decision_at: declined })],
        }).find((x) => x.clock === "quote_revise")!;
        expect(none.limit_passed_at?.toISOString()).toBe(endOf("2026-10-15").toISOString());
        expect(none.owner_id).toBe("rep");
    });

    it("marking the lead Lost answers a declined quote", () => {
        const declined = ist("2026-10-13", "12:00");
        const c = clocksForLead(lead(owned), [], hops, [{ lead_id: "L1", at: ist("2026-10-14", "10:00"), to_status: "Lost" }], limits, NONE, LATER, {
            quoteVersions: [version({ dealer_decision: "declined", dealer_decision_at: declined })],
        }).find((x) => x.clock === "quote_revise")!;
        expect(c.first_attempt_at?.toISOString()).toBe(ist("2026-10-14", "10:00").toISOString());
        expect(c.limit_passed_at).toBeNull();
    });
});

import { describe, expect, it } from "vitest";

import { BASE_CLOCK_KINDS, clocksForLead, hotSpans, type ClockLead, type ClockTouch } from "@/lib/leads/clockRules";
import { TIME_LIMIT_DEFAULTS, formatLimit } from "@/lib/timeLimits/registry";

// 15 Oct rework of IDs 85 / 86: Hot clocks, retry, CEO quote approval, the
// owner charged at the time of the miss, the 10 Sep cutoff, dated holidays.

const ist = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:30`);
const NONE = new Set<string>();
const limits = () => TIME_LIMIT_DEFAULTS;
const LATER = ist("2026-10-26", "12:00");

const lead = (over: Partial<ClockLead> = {}): ClockLead => ({
    id: "L1",
    created_at: ist("2026-10-12", "09:00"),
    sales_ready_at: ist("2026-10-12", "10:00"),
    assigned_at: ist("2026-10-12", "10:00"),
    current_owner_id: "rep",
    ...over,
});
const call = (at: Date, by: string, connected = false): ClockTouch => ({ lead_id: "L1", at, by, kind: "call", attempt: true, contact: connected });
const hot = (at: Date) => ({ lead_id: "L1", at, to: "hot" });
const warm = (at: Date) => ({ lead_id: "L1", at, to: "warm" });
const hop = (at: Date, owner_id: string) => ({ lead_id: "L1", at, owner_id });

describe("Hot clocks", () => {
    it("a Hot lead reaching its owner at 18:00 Saturday is due by 13:00 Monday (4 office hours)", () => {
        const sat = ist("2026-10-17", "18:00");
        const clocks = clocksForLead(
            lead({ sales_ready_at: ist("2026-10-17", "09:00"), assigned_at: sat }),
            [],
            [hop(sat, "rep")],
            [],
            limits,
            NONE,
            LATER,
            { interest: [hot(ist("2026-10-17", "09:00"))] },
        );
        // 18 Oct rework 2: assigned while Hot → the owner clock carries the Hot limit (no second hot_owner clock).
        expect(clocks.some((c) => c.clock === "hot_owner")).toBe(false);
        const owner = clocks.find((c) => c.clock === "owner")!;
        expect(owner.limit_key).toBe("hot_owner_first_attempt");
        expect(owner.started_at.toISOString()).toBe(sat.toISOString());
        expect(owner.due_at?.toISOString()).toBe(ist("2026-10-19", "13:00").toISOString());
    });

    it("ready → assigned: 9 office hours, until the first assignment", () => {
        const clocks = clocksForLead(
            lead({ assigned_at: ist("2026-10-13", "15:00") }),
            [],
            [hop(ist("2026-10-13", "15:00"), "rep")],
            [],
            limits,
            NONE,
            LATER,
            { interest: [hot(ist("2026-10-12", "09:00"))] },
        );
        const hotAssign = clocks.find((c) => c.clock === "hot_assign")!;
        // 9 working hours from Mon 10:00 = Mon 19:00; assigned Tue 15:00 → passed.
        expect(hotAssign.due_at?.toISOString()).toBe(ist("2026-10-12", "19:00").toISOString());
        expect(hotAssign.limit_passed_at?.toISOString()).toBe(ist("2026-10-12", "19:00").toISOString());
        expect(hotAssign.first_attempt_at?.toISOString()).toBe(ist("2026-10-13", "15:00").toISOString());
        expect(hotAssign.owner_id).toBeNull();
    });

    it("turning Hot under an owner starts a fresh 4-hour clock; no ready → assigned clock when already owned", () => {
        const turnedHot = ist("2026-10-14", "11:00");
        const clocks = clocksForLead(
            lead(),
            [call(ist("2026-10-14", "12:00"), "rep")],
            [hop(ist("2026-10-12", "10:00"), "rep")],
            [],
            limits,
            NONE,
            LATER,
            { interest: [hot(turnedHot)] },
        );
        expect(clocks.some((c) => c.clock === "hot_assign")).toBe(false);
        const hotOwner = clocks.find((c) => c.clock === "hot_owner")!;
        expect(hotOwner.started_at.toISOString()).toBe(turnedHot.toISOString());
        expect(hotOwner.attempt_working_minutes).toBe(60);
        expect(hotOwner.limit_passed_at).toBeNull();
    });

    it("a lead that cools before anyone acts stops its Hot clock", () => {
        const clocks = clocksForLead(
            lead({ current_owner_id: null, assigned_at: null }),
            [],
            [],
            [],
            limits,
            NONE,
            LATER,
            { interest: [hot(ist("2026-10-12", "10:00")), warm(ist("2026-10-12", "12:00"))] },
        );
        const hotAssign = clocks.find((c) => c.clock === "hot_assign")!;
        expect(hotAssign.ended_at?.toISOString()).toBe(ist("2026-10-12", "12:00").toISOString());
        expect(hotAssign.limit_passed_at).toBeNull();
    });

    it("hot spans: hot → warm → hot gives two spans", () => {
        const spans = hotSpans([hot(ist("2026-10-12", "10:00")), warm(ist("2026-10-13", "10:00")), hot(ist("2026-10-14", "10:00"))]);
        expect(spans).toHaveLength(2);
        expect(spans[1].to).toBeNull();
    });
});

describe("who a miss is charged to", () => {
    it("a missed lead clock goes to the owner when it fell due, not to today's owner", () => {
        const clocks = clocksForLead(
            lead({ current_owner_id: "b" }),
            [],
            [hop(ist("2026-10-12", "10:00"), "a"), hop(ist("2026-10-15", "10:00"), "b")],
            [],
            limits,
            NONE,
            LATER,
        );
        const leadClock = clocks.find((c) => c.clock === "lead")!;
        expect(leadClock.limit_passed_at?.toISOString()).toBe(ist("2026-10-12", "14:00").toISOString());
        expect(leadClock.owner_id).toBe("a");
        expect(leadClock.owner_inferred).toBe(false);
    });

    it("a miss before 10 Sep (inferred owner) is flagged, so per-person counts leave it out", () => {
        const clocks = clocksForLead(
            lead({ created_at: ist("2026-08-01", "09:00"), sales_ready_at: ist("2026-08-03", "10:00"), assigned_at: ist("2026-08-03", "10:00") }),
            [],
            [],
            [],
            limits,
            NONE,
            LATER,
        );
        const leadClock = clocks.find((c) => c.clock === "lead")!;
        expect(leadClock.limit_passed_at).not.toBeNull();
        expect(leadClock.owner_id).toBe("rep");
        expect(leadClock.owner_inferred).toBe(true);
    });
});

describe("retry and quote approval", () => {
    it("next attempt within the gap; only the first N unanswered calls in a row are timed", () => {
        const calls = [
            call(ist("2026-10-12", "11:00"), "rep"),
            call(ist("2026-10-12", "15:00"), "rep"), // 4 h later: in time
            call(ist("2026-10-14", "15:00"), "rep"), // 2 days later: passed
            call(ist("2026-10-15", "11:00"), "rep"),
            call(ist("2026-10-15", "12:00"), "rep"), // 5th in a row: over the limit of 3, not timed
        ];
        const retries = clocksForLead(lead(), calls, [], [], limits, NONE, LATER).filter((c) => c.clock === "retry");
        expect(retries).toHaveLength(3);
        expect(retries[0].limit_passed_at).toBeNull();
        expect(retries[1].limit_passed_at).not.toBeNull();
        expect(retries[1].owner_id).toBe("rep");
    });

    it("a connected call resets the retry count", () => {
        const calls = [call(ist("2026-10-12", "11:00"), "rep"), call(ist("2026-10-12", "12:00"), "rep", true), call(ist("2026-10-12", "13:00"), "rep")];
        expect(clocksForLead(lead(), calls, [], [], limits, NONE, LATER).filter((c) => c.clock === "retry")).toHaveLength(2);
    });

    it("a lead closed as Lost ends its retry clock", () => {
        const retries = clocksForLead(
            lead(),
            [call(ist("2026-10-12", "11:00"), "rep")],
            [],
            [{ lead_id: "L1", at: ist("2026-10-12", "12:00"), to_status: "Lost" }],
            limits,
            NONE,
            LATER,
        ).filter((c) => c.clock === "retry");
        expect(retries[0].ended_at?.toISOString()).toBe(ist("2026-10-12", "12:00").toISOString());
        expect(retries[0].limit_passed_at).toBeNull();
    });

    it("CEO quote approval: 4 working hours to decide, charged to the decider", () => {
        const clocks = clocksForLead(lead(), [], [], [], limits, NONE, LATER, {
            quotes: [{ lead_id: "L1", submitted_at: ist("2026-10-12", "17:00"), decided_at: ist("2026-10-13", "15:00"), withdrawn_at: null, decided_by: "ceo" }],
        });
        const q = clocks.find((c) => c.clock === "quote")!;
        // Mon 17:00 + 4 h = Tue 12:00; decided 15:00 → passed.
        expect(q.due_at?.toISOString()).toBe(ist("2026-10-13", "12:00").toISOString());
        expect(q.limit_passed_at?.toISOString()).toBe(ist("2026-10-13", "12:00").toISOString());
        expect(q.owner_id).toBe("ceo");
    });
});

describe("dated holidays and kinds", () => {
    it("a holiday added after a clock finished does not move it; one added while it runs does", () => {
        // Clock from Fri 16 Oct 18:00 → due Sat 17 Oct 13:00 (4 h). Sat is declared a holiday on 20 Oct.
        const start = ist("2026-10-16", "18:00");
        const added = ist("2026-10-20", "10:00");
        const asOf = (at: Date) => (at >= added ? new Set(["2026-10-17"]) : NONE);
        const finished = clocksForLead(lead({ sales_ready_at: start, assigned_at: start }), [call(ist("2026-10-17", "16:00"), "rep")], [], [], limits, asOf, LATER).find(
            (c) => c.clock === "lead",
        )!;
        expect(finished.limit_passed_at?.toISOString()).toBe(ist("2026-10-17", "13:00").toISOString());
        const running = clocksForLead(lead({ sales_ready_at: start, assigned_at: start }), [], [], [], limits, asOf, LATER).find((c) => c.clock === "lead")!;
        // Still running when the holiday was added → Sat skipped: Fri 1 h + Mon 3 h = Mon 13:00.
        expect(running.due_at?.toISOString()).toBe(ist("2026-10-19", "13:00").toISOString());
    });

    it("only the asked-for kinds are computed (a database without E-350)", () => {
        const kinds = new Set(BASE_CLOCK_KINDS);
        const clocks = clocksForLead(lead(), [call(ist("2026-10-12", "11:00"), "rep")], [], [], limits, NONE, LATER, {
            kinds,
            interest: [hot(ist("2026-10-12", "09:00"))],
        });
        expect(clocks.length).toBeGreaterThan(0);
        expect(clocks.every((c) => kinds.has(c.clock))).toBe(true);
    });

    it("count limits format as a plain number", () => {
        expect(formatLimit(3, "count")).toBe("3");
    });
});

import { describe, expect, it } from "vitest";

import { clocksForLead, medianAndP90, type ClockLead, type ClockTouch } from "@/lib/leads/clockRules";
import { TIME_LIMIT_DEFAULTS, crossLimitProblem, formatLimit } from "@/lib/timeLimits/registry";

const ist = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:30`);
const NONE = new Set<string>();
const limits = () => TIME_LIMIT_DEFAULTS; // lead / owner first attempt: 4 working hours; transfer visit: 3 working days
const NOW = ist("2026-10-20", "12:00");

const lead = (over: Partial<ClockLead> = {}): ClockLead => ({
    id: "L1",
    created_at: ist("2026-10-12", "09:00"),
    sales_ready_at: ist("2026-10-12", "10:00"),
    assigned_at: ist("2026-10-12", "10:00"),
    current_owner_id: "rep",
    ...over,
});
const call = (at: Date, by: string, connected = false): ClockTouch => ({ lead_id: "L1", at, by, kind: "call", attempt: true, contact: connected });

describe("lead clocks (ID 86)", () => {
    it("lead clock: first call by anyone within 4 working hours is in time", () => {
        const [, leadClock] = clocksForLead(lead(), [call(ist("2026-10-12", "12:00"), "other", true)], [], [], limits, NONE, NOW);
        expect(leadClock.clock).toBe("lead");
        expect(leadClock.attempt_working_minutes).toBe(120);
        expect(leadClock.limit_passed_at).toBeNull();
        expect(leadClock.first_contact_at?.toISOString()).toBe(ist("2026-10-12", "12:00").toISOString());
    });

    it("owner clock counts only that owner's attempts; the stint is inferred without an assignment row", () => {
        const [owner] = clocksForLead(lead(), [call(ist("2026-10-12", "11:00"), "other")], [], [], limits, NONE, NOW);
        expect(owner.clock).toBe("owner");
        expect(owner.owner_inferred).toBe(true);
        expect(owner.first_attempt_at).toBeNull();
        // Due 14:00 IST, never attempted → passed at the due moment.
        expect(owner.limit_passed_at?.toISOString()).toBe(ist("2026-10-12", "14:00").toISOString());
    });

    it("a stint handed on before its limit fell due never passes", () => {
        const hops = [
            { lead_id: "L1", at: ist("2026-10-12", "10:00"), owner_id: "a" },
            { lead_id: "L1", at: ist("2026-10-12", "11:00"), owner_id: "rep" },
        ];
        const clocks = clocksForLead(lead(), [call(ist("2026-10-12", "11:30"), "rep")], hops, [], limits, NONE, NOW);
        const [first, second] = clocks.filter((c) => c.clock === "owner");
        expect(first.owner_id).toBe("a");
        expect(first.ended_at?.toISOString()).toBe(ist("2026-10-12", "11:00").toISOString());
        expect(first.limit_passed_at).toBeNull();
        expect(second.owner_inferred).toBe(false);
        expect(second.attempt_working_minutes).toBe(30);
    });

    it("transfer clock: visit within 3 working days; a stint starting with the transfer has no owner limit", () => {
        const transferAt = ist("2026-10-16", "15:00");
        const clocks = clocksForLead(
            lead({ current_owner_id: "asm" }),
            [{ lead_id: "L1", at: ist("2026-10-21", "10:00"), by: "asm", kind: "visit", attempt: true, contact: true }],
            [{ lead_id: "L1", at: transferAt, owner_id: "asm" }],
            [{ lead_id: "L1", at: transferAt, to_status: "Transferred_to_ASM" }],
            limits,
            NONE,
            ist("2026-10-22", "12:00"),
        );
        const transfer = clocks.find((c) => c.clock === "transfer")!;
        const owner = clocks.find((c) => c.clock === "owner")!;
        // Due end of Tue 20 Oct; the visit came Wed 21 → passed.
        expect(transfer.limit_passed_at?.toISOString()).toBe(new Date("2026-10-20T18:29:59.999Z").toISOString());
        expect(owner.limit_key).toBeNull();
        expect(owner.limit_passed_at).toBeNull();
    });

    it("a lead with an owner but no sales-ready date starts at the first assignment, flagged", () => {
        const clocks = clocksForLead(lead({ sales_ready_at: null }), [], [], [], limits, NONE, NOW);
        expect(clocks.find((c) => c.clock === "lead")?.start_inferred).toBe(true);
    });

    it("no owner and never sales-ready: no clock at all", () => {
        expect(clocksForLead(lead({ sales_ready_at: null, current_owner_id: null }), [], [], [], limits, NONE, NOW)).toEqual([]);
    });

    it("the limit is the one in force on the day the clock started", () => {
        const dated = (day: string) => ({ ...TIME_LIMIT_DEFAULTS, owner_first_attempt: day >= "2026-10-13" ? 8 : 4 });
        const [owner] = clocksForLead(lead(), [], [], [], dated, NONE, NOW);
        expect(owner.limit_value).toBe(4);
    });

    it("median and slowest 1 in 10", () => {
        expect(medianAndP90([])).toEqual({ median: null, p90: null });
        expect(medianAndP90([5, 1, 3])).toEqual({ median: 3, p90: 5 });
        expect(medianAndP90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual({ median: 5.5, p90: 9 });
    });
});

describe("time limit registry (ID 85)", () => {
    it("formats units", () => {
        expect(formatLimit(1, "working_days")).toBe("1 working day");
        expect(formatLimit(4, "working_hours")).toBe("4 working hours");
        expect(formatLimit(21, "days")).toBe("21 days");
    });

    it("the no-touch warnings must rise", () => {
        expect(crossLimitProblem(TIME_LIMIT_DEFAULTS)).toBeNull();
        expect(crossLimitProblem({ ...TIME_LIMIT_DEFAULTS, stale_red: 4 })).toMatch(/must rise/);
    });
});

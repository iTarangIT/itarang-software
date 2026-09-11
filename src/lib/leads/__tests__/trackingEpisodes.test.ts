import { describe, expect, it } from "vitest";
import {
    attachEvents,
    deriveEpisodes,
    isHop,
    type HopInput,
} from "../trackingEpisodes";
import { buildTrackingCsvRows, TRACKING_CSV_COLUMNS } from "../trackingCsv";
import {
    NOT_RECORDED_PERSON,
    UNASSIGNED_PERSON,
    fmtDuration,
    type LeadTracking,
    type TrackingEvent,
    type TrackingPerson,
} from "../trackingTypes";

const PEOPLE: Record<string, TrackingPerson> = {
    nidhi: { id: "nidhi", name: "Nidhi", role: "inside_sales_rep" },
    ganesh: { id: "ganesh", name: "Ganesh", role: "asm" },
    admin: { id: "admin", name: "Anirudh", role: "sales_head" },
};
const resolve = (id: string | null) =>
    id ? (PEOPLE[id] ?? { id, name: id, role: null }) : UNASSIGNED_PERSON;

const T0 = "2026-09-01T00:00:00Z";
const T1 = "2026-09-02T00:00:00Z"; // +1d
const T2 = "2026-09-04T00:00:00Z"; // +3d
const T3 = "2026-09-05T12:00:00Z"; // +4d12h
const NOW = "2026-09-08T00:00:00Z"; // +7d

const lead = (over: Partial<Parameters<typeof deriveEpisodes>[0]> = {}) => ({
    id: "DL-1",
    created_at: T0,
    assigned_at: null,
    updated_at: null,
    current_owner_id: null,
    ...over,
});

const hop = (over: Partial<HopInput> & { at: string }): HopInput => ({
    touchpoint_type: "ownership_transfer",
    from_owner_id: null,
    to_owner_id: null,
    recorded: true,
    actor: PEOPLE.admin!,
    remarks: null,
    label: "Reassigned",
    ...over,
});

const DAY = 86400;

describe("deriveEpisodes", () => {
    it("a lead nobody ever touched is one open Unassigned episode", () => {
        const eps = deriveEpisodes(lead(), [], resolve, NOW);
        expect(eps).toHaveLength(1);
        expect(eps[0]!.holder).toBe(UNASSIGNED_PERSON);
        expect(eps[0]!.to_at).toBeNull();
        expect(eps[0]!.duration_sec).toBe(7 * DAY);
        expect(eps[0]!.approximate).toBe(false);
    });

    it("claim → reassign → ASM transfer tiles the life with no gaps", () => {
        const hops = [
            hop({ at: T1, touchpoint_type: "lead_claimed", to_owner_id: "nidhi", actor: PEOPLE.nidhi!, label: "Claimed" }),
            hop({ at: T2, from_owner_id: "nidhi", to_owner_id: "ganesh", touchpoint_type: "asm_transfer", actor: PEOPLE.nidhi!, remarks: "Visit needed", label: "Transferred to ASM" }),
        ];
        const eps = deriveEpisodes(lead({ current_owner_id: "ganesh" }), hops, resolve, NOW);
        expect(eps.map((e) => e.holder.name)).toEqual(["Unassigned", "Nidhi", "Ganesh"]);
        expect(eps.map((e) => e.duration_sec)).toEqual([1 * DAY, 2 * DAY, 4 * DAY]);
        // contiguous
        for (let i = 1; i < eps.length; i++) expect(eps[i]!.from_at).toBe(eps[i - 1]!.to_at);
        expect(eps[2]!.to_at).toBeNull();
        expect(eps[2]!.handed_by?.name).toBe("Nidhi");
        expect(eps[2]!.handoff_reason).toBe("Visit needed");
        expect(eps[2]!.handoff_label).toBe("Transferred to ASM");
        expect(eps.every((e) => !e.approximate)).toBe(true);
        // durations sum to the lead's age
        expect(eps.reduce((s, e) => s + e.duration_sec, 0)).toBe(7 * DAY);
    });

    it("a legacy hop with no recipient recorded is honest about it", () => {
        const hops = [
            hop({ at: T1, recorded: false }), // pre-E-295 reassign, recipient unknown
            hop({ at: T2, from_owner_id: null, to_owner_id: "ganesh", touchpoint_type: "asm_transfer" }),
        ];
        const eps = deriveEpisodes(lead({ current_owner_id: "ganesh" }), hops, resolve, NOW);
        expect(eps[1]!.holder).toBe(NOT_RECORDED_PERSON);
        expect(eps[1]!.approximate).toBe(true);
        expect(eps[2]!.holder.name).toBe("Ganesh");
    });

    it("a legacy claim still names the claimer as the holder", () => {
        const hops = [
            hop({ at: T1, recorded: false, touchpoint_type: "lead_claimed", actor: PEOPLE.nidhi! }),
        ];
        const eps = deriveEpisodes(lead({ current_owner_id: "nidhi" }), hops, resolve, NOW);
        expect(eps).toHaveLength(2);
        expect(eps[1]!.holder.name).toBe("Nidhi");
        expect(eps[1]!.approximate).toBe(true);
    });

    it("a pre-E-295 lead with an owner but no hop gets an approximate episode from assigned_at", () => {
        const eps = deriveEpisodes(
            lead({ current_owner_id: "nidhi", assigned_at: T2 }),
            [],
            resolve,
            NOW,
        );
        expect(eps.map((e) => e.holder.name)).toEqual(["Unassigned", "Nidhi"]);
        expect(eps[0]!.to_at).toBe(T2);
        expect(eps[1]!.approximate).toBe(true);
        expect(eps[1]!.duration_sec).toBe(4 * DAY);
    });

    it("the first hop's from_owner reveals a pre-tracking owner for episode 0", () => {
        const hops = [hop({ at: T2, from_owner_id: "nidhi", to_owner_id: "ganesh" })];
        const eps = deriveEpisodes(lead({ current_owner_id: "ganesh" }), hops, resolve, NOW);
        expect(eps[0]!.holder.name).toBe("Nidhi");
        expect(eps[0]!.approximate).toBe(true);
        expect(eps[1]!.holder.name).toBe("Ganesh");
    });

    it("a release to the pool is an Unassigned episode", () => {
        const hops = [
            hop({ at: T1, to_owner_id: "nidhi" }),
            hop({ at: T2, from_owner_id: "nidhi", to_owner_id: null, touchpoint_type: "reactivated_via_admin" }),
        ];
        const eps = deriveEpisodes(lead({ current_owner_id: null }), hops, resolve, NOW);
        expect(eps.map((e) => e.holder.name)).toEqual(["Unassigned", "Nidhi", "Unassigned"]);
        expect(eps).toHaveLength(3);
    });

    it("re-pushing to the same holder does not open a new episode", () => {
        const hops = [
            hop({ at: T1, to_owner_id: "nidhi" }),
            hop({ at: T2, from_owner_id: "nidhi", to_owner_id: "nidhi", touchpoint_type: "lead_assigned" }),
        ];
        const eps = deriveEpisodes(lead({ current_owner_id: "nidhi" }), hops, resolve, NOW);
        expect(eps).toHaveLength(2);
    });
});

describe("attachEvents", () => {
    const ev = (at: string, over: Partial<TrackingEvent> = {}): TrackingEvent => ({
        at,
        actor: PEOPLE.nidhi!,
        kind: "touchpoint",
        action: "Call",
        type_code: "inside_sales_call",
        details: null,
        status_from: null,
        status_to: null,
        call_status: "connected",
        duration_sec: 60,
        next_action: null,
        to_person: null,
        episode_seq: 0,
        ...over,
    });

    it("stamps each event with the episode active at its time; a boundary belongs to the new episode", () => {
        const hops = [
            hop({ at: T1, to_owner_id: "nidhi" }),
            hop({ at: T2, from_owner_id: "nidhi", to_owner_id: "ganesh" }),
        ];
        const eps = deriveEpisodes(lead({ current_owner_id: "ganesh" }), hops, resolve, NOW);
        const events = [
            ev("2026-09-01T06:00:00Z", { action: "AI call" }),
            ev(T1, { action: "Reassigned" }), // the hop itself
            ev(T1, { kind: "status_change", status_from: "New_Unassigned", status_to: "Assigned_Not_Contacted", action: "Status" }),
            ev("2026-09-03T00:00:00Z"),
            ev(T2, { action: "Transferred" }),
            ev(T2, { kind: "status_change", status_from: "Assigned_Not_Contacted", status_to: "Transferred_to_ASM", action: "Status" }),
            ev(T3, { action: "Visit" }),
        ];
        attachEvents(eps, events, "New_Unassigned");
        expect(events.map((e) => e.episode_seq)).toEqual([0, 1, 1, 1, 2, 2, 2]);
        expect(eps.map((e) => e.actions_count)).toEqual([1, 3, 3]);
        expect(eps[0]!.status_at_start).toBe("New_Unassigned");
        expect(eps[0]!.status_at_end).toBe("New_Unassigned");
        expect(eps[1]!.status_at_start).toBe("New_Unassigned");
        expect(eps[1]!.status_at_end).toBe("Assigned_Not_Contacted");
        expect(eps[2]!.status_at_start).toBe("Assigned_Not_Contacted");
        expect(eps[2]!.status_at_end).toBe("Transferred_to_ASM");
    });

    it("an event in an empty tail episode still lands there", () => {
        const eps = deriveEpisodes(lead(), [], resolve, NOW);
        const events = [ev(T3)];
        attachEvents(eps, events, null);
        expect(events[0]!.episode_seq).toBe(0);
        expect(eps[0]!.actions_count).toBe(1);
    });
});

describe("isHop", () => {
    it("recognises recorded columns and legacy assignment types", () => {
        expect(isHop({ touchpoint_type: "inside_sales_call", from_owner_id: null, to_owner_id: null })).toBe(false);
        expect(isHop({ touchpoint_type: "inside_sales_call", from_owner_id: "a", to_owner_id: null })).toBe(true);
        expect(isHop({ touchpoint_type: "asm_transfer", from_owner_id: null, to_owner_id: null })).toBe(true);
        expect(isHop({ touchpoint_type: "lead_claimed", from_owner_id: null, to_owner_id: null })).toBe(true);
    });
});

describe("fmtDuration", () => {
    it("renders days / hours / minutes and the sub-minute floor", () => {
        expect(fmtDuration(0)).toBe("<1m");
        expect(fmtDuration(59)).toBe("<1m");
        expect(fmtDuration(60)).toBe("1m");
        expect(fmtDuration(3600 + 120)).toBe("1h 2m");
        expect(fmtDuration(2 * DAY + 3600 * 5 + 60 * 7)).toBe("2d 5h 7m");
        expect(fmtDuration(null)).toBe("—");
    });
});

describe("CSV contract", () => {
    it("emits HOLD rows then ACTION rows per lead, oldest first, headline repeated", () => {
        const hops = [hop({ at: T1, to_owner_id: "nidhi", touchpoint_type: "lead_claimed", actor: PEOPLE.nidhi!, label: "Claimed" })];
        const episodes = deriveEpisodes(lead({ current_owner_id: "nidhi" }), hops, resolve, NOW);
        const events: TrackingEvent[] = [
            {
                at: T1, actor: PEOPLE.nidhi!, kind: "touchpoint", action: "Claimed", type_code: "lead_claimed",
                details: "Claimed from unassigned queue", status_from: null, status_to: null, call_status: null,
                duration_sec: null, next_action: null, to_person: PEOPLE.nidhi!, episode_seq: 0,
            },
            {
                at: T3, actor: PEOPLE.nidhi!, kind: "touchpoint", action: "Call", type_code: "inside_sales_call",
                details: "Spoke, wants a quote", status_from: null, status_to: null, call_status: "connected",
                duration_sec: 90, next_action: "follow_up", to_person: null, episode_seq: 0,
            },
        ];
        attachEvents(episodes, events, "New_Unassigned");
        const tracking: LeadTracking = {
            lead: {
                id: "DL-1", dealer_name: "Bhopal Battery", shop_name: null, phone: "9827598936", city: "Bhopal",
                state: "MP", source: "neodove", created_at: T0, closed_at: null, lead_status: "Assigned_Not_Contacted",
                current_owner: PEOPLE.nidhi!, asm: null, age_sec: 7 * DAY, time_in_status_sec: 6 * DAY,
                time_with_owner_sec: 6 * DAY, handoffs: 1,
            },
            episodes, events, truncated: false, as_of: NOW,
        };
        const rows = buildTrackingCsvRows([tracking]);
        expect(rows.map((r) => r.row_type)).toEqual(["HOLD", "HOLD", "ACTION", "ACTION"]);
        expect(rows[0]!.holder).toBe("Unassigned");
        expect(rows[1]!.holder).toBe("Nidhi");
        expect(rows[1]!.holder_role).toBe("Inside Sales Rep");
        expect(rows[1]!.held_until).toBe("(still holding)");
        expect(rows[1]!.actions_in_hold).toBe(2);
        expect(rows[2]!.holder_at_time).toBe("Nidhi");
        expect(rows[2]!.handed_to).toBe("Nidhi");
        expect(rows[3]!.call_status).toBe("Connected");
        expect(rows[3]!.next_action).toBe("Follow up");
        // headline repeats on every row
        expect(new Set(rows.map((r) => r.dealer))).toEqual(new Set(["Bhopal Battery"]));
        expect(rows.every((r) => r.current_status === "Assigned")).toBe(true);
        // header contract
        expect(TRACKING_CSV_COLUMNS[0]!.header).toBe("Row Type");
        expect(TRACKING_CSV_COLUMNS.map((c) => c.header)).toContain("Held For");
        expect(TRACKING_CSV_COLUMNS.map((c) => c.header)).toContain("Holder At The Time");
        expect(TRACKING_CSV_COLUMNS).toHaveLength(44);
    });
});

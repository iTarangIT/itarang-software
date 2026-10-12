/**
 * Lead clocks (tracker ID 86) — the pure rules. No I/O: clocks.ts loads the
 * rows and writes the result; this decides every clock, so it is unit-tested.
 *
 *   lead      starts when the lead becomes sales-ready (sales_ready_at). A lead
 *             with an owner but no sales_ready_at starts at its first owner's
 *             assignment, flagged start_inferred. Ends never. First attempt =
 *             the first call or visit by ANYONE.
 *   owner     starts at every assignment (an owner-change touchpoint). A lead
 *             whose current owner has no such row gets one stint from
 *             assigned_at, flagged owner_inferred. Ends at the next assignment.
 *             First attempt = the first call or visit by THAT owner. A stint
 *             that starts with a Transfer to ASM (within 10 minutes) has no
 *             owner limit: the transfer clock governs that hand-off.
 *   transfer  starts at each move to Transferred_to_ASM, ends at the lead's
 *             next status change. First attempt = the first visit marked
 *             visited (the ASM transfer-visit limit, ID 77.1).
 *
 * Attempt = a human call (any outcome) or a visit that happened (visited /
 * no_show). Contact = a connected call or a visit marked visited.
 *
 * Limit: the one in force on the IST day the clock started. Passed when no
 * attempt came by the due moment while the clock was still running; the
 * moment it fell due is the "Limit passed" event. A stint handed to another
 * owner before its limit fell due never passes.
 */
import {
    addWorkingMinutes,
    calendarDaysDueAt,
    istDay,
    workingDaysDueAt,
    workingMinutesBetween,
} from "@/lib/calendar/officeCalendar";
import { timeLimitDef, type TimeLimitKey, type TimeLimits } from "@/lib/timeLimits/registry";

export type ClockKind = "lead" | "owner" | "transfer";

export type ClockLead = {
    id: string;
    created_at: Date;
    sales_ready_at: Date | null;
    assigned_at: Date | null;
    current_owner_id: string | null;
};

/** A call or a visit on a lead. */
export type ClockTouch = {
    lead_id: string;
    at: Date;
    by: string | null;
    kind: "call" | "visit";
    /** It happened (a call, a visit made or a no-show). */
    attempt: boolean;
    /** It reached the dealer (a connected call, a visit marked visited). */
    contact: boolean;
};

export type OwnerHop = { lead_id: string; at: Date; owner_id: string };
export type StatusChange = { lead_id: string; at: Date; to_status: string };

export type LeadClock = {
    dealer_lead_id: string;
    clock: ClockKind;
    owner_id: string | null;
    owner_inferred: boolean;
    start_inferred: boolean;
    started_at: Date;
    ended_at: Date | null;
    first_attempt_at: Date | null;
    first_attempt_kind: "call" | "visit" | null;
    first_contact_at: Date | null;
    attempt_working_minutes: number | null;
    contact_working_minutes: number | null;
    limit_key: TimeLimitKey | null;
    limit_value: number | null;
    due_at: Date | null;
    limit_passed_at: Date | null;
};

const LIMIT_OF: Record<ClockKind, TimeLimitKey> = {
    lead: "lead_first_attempt",
    owner: "owner_first_attempt",
    transfer: "asm_transfer_first_visit",
};

function dueAt(start: Date, key: TimeLimitKey, value: number, holidays: ReadonlySet<string>): Date | null {
    const unit = timeLimitDef(key)?.unit;
    if (unit === "working_hours") return addWorkingMinutes(start, value * 60, holidays);
    if (unit === "working_days") return workingDaysDueAt(start, value, holidays);
    return calendarDaysDueAt(start, value);
}

const TRANSFER_WINDOW_MS = 10 * 60 * 1000;

function finish(
    base: Omit<LeadClock, "attempt_working_minutes" | "contact_working_minutes" | "limit_key" | "limit_value" | "due_at" | "limit_passed_at">,
    limitsOn: (day: string) => TimeLimits,
    holidays: ReadonlySet<string>,
    now: Date,
    noLimit = false,
): LeadClock {
    const key = noLimit ? null : LIMIT_OF[base.clock];
    const value = key ? limitsOn(istDay(base.started_at))[key] : null;
    const due = key && value != null ? dueAt(base.started_at, key, value, holidays) : null;
    // The clock stops at the first attempt, the end of the stint, or now.
    const stop = base.first_attempt_at ?? (base.ended_at && base.ended_at < now ? base.ended_at : now);
    const passed = due != null && stop > due ? due : null;
    return {
        ...base,
        attempt_working_minutes: base.first_attempt_at ? workingMinutesBetween(base.started_at, base.first_attempt_at, holidays) : null,
        contact_working_minutes: base.first_contact_at ? workingMinutesBetween(base.started_at, base.first_contact_at, holidays) : null,
        limit_key: key,
        limit_value: value,
        due_at: due,
        limit_passed_at: passed,
    };
}

/** First touch in [from, to) passing `ok`, by time. `touches` is sorted by time. */
function firstTouch(touches: readonly ClockTouch[], from: Date, to: Date | null, ok: (t: ClockTouch) => boolean): ClockTouch | null {
    for (const t of touches) {
        if (t.at < from) continue;
        if (to && t.at >= to) break;
        if (ok(t)) return t;
    }
    return null;
}

/**
 * Every clock for one lead. `touches`, `hops` and `statuses` belong to this
 * lead and are sorted by time.
 */
export function clocksForLead(
    lead: ClockLead,
    touches: readonly ClockTouch[],
    hops: readonly OwnerHop[],
    statuses: readonly StatusChange[],
    limitsOn: (day: string) => TimeLimits,
    holidays: ReadonlySet<string>,
    now: Date,
): LeadClock[] {
    const out: LeadClock[] = [];

    // Owner stints: every recorded assignment, plus an inferred one when the
    // current owner never got an assignment row (or got the lead after it).
    const stints: Array<{ at: Date; owner: string; inferred: boolean }> = hops.map((h) => ({ at: h.at, owner: h.owner_id, inferred: false }));
    const last = stints[stints.length - 1];
    if (lead.current_owner_id && (!last || last.owner !== lead.current_owner_id)) {
        const at = lead.assigned_at ?? lead.sales_ready_at ?? lead.created_at;
        if (!last || at > last.at) stints.push({ at, owner: lead.current_owner_id, inferred: true });
    }
    const transfers = statuses.filter((st) => st.to_status === "Transferred_to_ASM");
    stints.forEach((s, i) => {
        const end = stints[i + 1]?.at ?? null;
        const viaTransfer = transfers.some((t) => Math.abs(t.at.getTime() - s.at.getTime()) <= TRANSFER_WINDOW_MS);
        const mine = (t: ClockTouch) => t.by === s.owner;
        const attempt = firstTouch(touches, s.at, end, (t) => t.attempt && mine(t));
        const contact = firstTouch(touches, s.at, end, (t) => t.contact && mine(t));
        out.push(
            finish(
                {
                    dealer_lead_id: lead.id,
                    clock: "owner",
                    owner_id: s.owner,
                    owner_inferred: s.inferred,
                    start_inferred: false,
                    started_at: s.at,
                    ended_at: end,
                    first_attempt_at: attempt?.at ?? null,
                    first_attempt_kind: attempt?.kind ?? null,
                    first_contact_at: contact?.at ?? null,
                },
                limitsOn,
                holidays,
                now,
                viaTransfer,
            ),
        );
    });

    // Lead clock: from sales-ready, else (inferred) from the first assignment.
    const leadStart = lead.sales_ready_at ?? stints[0]?.at ?? null;
    if (leadStart) {
        const attempt = firstTouch(touches, leadStart, null, (t) => t.attempt);
        const contact = firstTouch(touches, leadStart, null, (t) => t.contact);
        out.push(
            finish(
                {
                    dealer_lead_id: lead.id,
                    clock: "lead",
                    owner_id: lead.current_owner_id,
                    owner_inferred: false,
                    start_inferred: !lead.sales_ready_at,
                    started_at: leadStart,
                    ended_at: null,
                    first_attempt_at: attempt?.at ?? null,
                    first_attempt_kind: attempt?.kind ?? null,
                    first_contact_at: contact?.at ?? null,
                },
                limitsOn,
                holidays,
                now,
            ),
        );
    }

    // Transfer clocks: each move to Transferred_to_ASM until the next status change.
    statuses.forEach((st, i) => {
        if (st.to_status !== "Transferred_to_ASM") return;
        const end = statuses[i + 1]?.at ?? null;
        const visit = firstTouch(touches, st.at, end, (t) => t.kind === "visit" && t.contact);
        const owner = [...stints].reverse().find((s) => s.at <= (end ?? now))?.owner ?? null;
        out.push(
            finish(
                {
                    dealer_lead_id: lead.id,
                    clock: "transfer",
                    owner_id: owner,
                    owner_inferred: false,
                    start_inferred: false,
                    started_at: st.at,
                    ended_at: end,
                    first_attempt_at: visit?.at ?? null,
                    first_attempt_kind: visit ? "visit" : null,
                    first_contact_at: visit?.at ?? null,
                },
                limitsOn,
                holidays,
                now,
            ),
        );
    });

    return out;
}

/** Median and the slowest 1 in 10 (90th percentile, nearest rank) of a list. */
export function medianAndP90(values: readonly number[]): { median: number | null; p90: number | null } {
    if (!values.length) return { median: null, p90: null };
    const v = [...values].sort((a, b) => a - b);
    const mid = Math.floor(v.length / 2);
    const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
    const p90 = v[Math.min(v.length - 1, Math.ceil(0.9 * v.length) - 1)];
    return { median, p90 };
}

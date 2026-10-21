// How long a lead has been sitting untouched, for the admin Leads list.
//
// ID 192 (18 Oct sheet): WORKING days on the office calendar
// (src/lib/calendar/officeCalendar.ts — the working weekdays in force, default
// Mon–Sat, holidays off), counted from the shared follow-up ageing basis — the
// same count as Needs Attention, the ISR queue and the idle email, so a lead
// shows the same number everywhere. The admin list still uses its own
// admin-scale bands (30 / 60 / 90) rather than the queue's 5 / 10 / 14 cues:
// the whole pool's median lead is idle for months, and the queue's ramp would
// paint every row "critical". "Past its idle limit" (idle_cc / idle_asm) is a
// separate filter — idlePastLimitSql in src/lib/leads/idleLimit.ts.
//
// Pure and client-safe.

import { workingDaysSince, type OfficeHoursArg } from "@/lib/calendar/officeCalendar";
import { followUpAgeingBasis } from "./followUpAgeing";

export type IdleSeverity = "fresh" | "watch" | "stale" | "cold";

/** Working days in a month (Mon–Sat), for the secondary reading only. Not a date calculation. */
const WORKING_DAYS_PER_MONTH = 26;

const NO_HOLIDAYS: ReadonlySet<string> = new Set();

/**
 * WORKING days the CURRENT HOLDER has let the lead sit — the same basis and
 * the same count as Needs Attention (followUpAgeing.ts, ID 192;
 * workingDaysSinceSql over FOLLOW_UP_AGEING_BASIS): the later of the last
 * work (E-300 last_worked_at: a call, visit or status change), the date the
 * holder got the lead (assigned_at) and a follow-up within 30 days;
 * created_at when none of those exist. A follow-up still ahead reads 0 — the
 * lead is planned, not idle (and so falls in "Under 30").
 *
 * Pass the holidays and office hours where the caller has them; without them
 * only non-working weekdays (default Sunday) are off.
 *
 * Comments, dial requests and claims still do not count as work.
 */
export function idleDays(
    lead: {
        last_worked_at: string | null;
        assigned_at?: string | null;
        next_follow_up_at?: string | null;
        created_at: string | null;
    },
    now: number = Date.now(),
    holidays: ReadonlySet<string> = NO_HOLIDAYS,
    hours?: OfficeHoursArg,
): number | null {
    const basis = followUpAgeingBasis(lead, now);
    if (!basis) return null;
    // A basis in the future (follow-up ahead) counts no working day: 0.
    return workingDaysSince(basis, new Date(now), holidays, hours);
}

// ── Filter vocabulary ────────────────────────────────────────────────────
//
// Preset bands rather than two free-text day boxes: the question people
// actually ask is "show me what has gone cold", not "show me 43-to-61 days",
// and the bands line up with the colour ramp so a filtered list is visually
// coherent instead of a random slice through it.
//
// `min`/`max` are INCLUSIVE working-day counts. max: null = open-ended. Every
// lead with an ageing basis is in exactly one band: a follow-up still ahead
// reads 0 working days, so it is "Under 30" (it used to fall in none).
//
// past_limit is not a band: leads past their holder's idle limit — idle_cc
// for inside sales, idle_asm for ASMs (ID 85 time limits), idlePastLimitSql.
export const IDLE_RANGES = {
    "0-29": { label: "Under 30 working days", min: 0, max: 29 },
    "30-59": { label: "30 – 59 working days", min: 30, max: 59 },
    "60-89": { label: "60 – 89 working days", min: 60, max: 89 },
    "90+": { label: "90+ working days", min: 90, max: null },
    never: { label: "Never worked", min: null, max: null },
    past_limit: { label: "Idle past limit", min: null, max: null },
} as const;

export type IdleRangeKey = keyof typeof IDLE_RANGES;

export const IDLE_RANGE_KEYS = Object.keys(IDLE_RANGES) as IdleRangeKey[];

export function isIdleRangeKey(v: string | null | undefined): v is IdleRangeKey {
    return !!v && (IDLE_RANGE_KEYS as string[]).includes(v);
}

/** The band a working-day count falls in (never null for a number — 0 is "Under 30"). */
export function idleBand(days: number | null): Exclude<IdleRangeKey, "never" | "past_limit"> | null {
    if (days === null) return null;
    if (days >= 90) return "90+";
    if (days >= 60) return "60-89";
    if (days >= 30) return "30-59";
    return "0-29";
}

export function idleSeverity(days: number | null): IdleSeverity {
    if (days === null) return "fresh";
    if (days >= 90) return "cold";
    if (days >= 60) return "stale";
    if (days >= 30) return "watch";
    return "fresh";
}

/**
 * "97d" (working days) plus, once it stops being readable as days, "3.7 mo"
 * (≈ 26 working days a month).
 *
 * The months line appears only from 30 days: below that it is noise ("0.4 mo"
 * tells nobody anything "12d" did not), and above it days alone stop being a
 * quantity anyone can feel.
 */
export function formatIdle(days: number | null): {
    primary: string;
    months: string | null;
} {
    if (days === null) return { primary: "—", months: null };
    return {
        primary: `${days}d`,
        months:
            days >= 30 ? `${(days / WORKING_DAYS_PER_MONTH).toFixed(1)} mo` : null,
    };
}

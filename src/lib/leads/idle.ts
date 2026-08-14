// How long a lead has been sitting untouched, for the admin Leads list.
//
// WHY NOT REUSE inside-sales/staleness.ts. That module counts WORKING days
// (Mon–Sat minus a holiday calendar) and its BRD §0.5 cues fire at 5 / 10 / 14 —
// correct for a rep working today's queue, useless one level up. The admin list
// spans the whole pool, where the median lead has been idle 71–85 days and the
// tail reaches 140: every single row would paint "critical" and the colour would
// carry no information at all. This is calendar days on an admin-scale ramp.
//
// Also deliberately holiday-free. Asking "is this lead going stale this week"
// needs a working-day count; asking "how long has this been rotting" does not,
// and a months figure computed from working days is actively misleading.

export type IdleSeverity = "fresh" | "watch" | "stale" | "cold";

const DAY_MS = 86_400_000;
/** Calendar month, for the secondary reading only. Not a date calculation. */
const DAYS_PER_MONTH = 30.44;

/**
 * Calendar days since the last touch, falling back to creation.
 *
 * The fallback is the point: a lead nobody has EVER touched is not idle for
 * zero days, it is idle for its entire life. Reading a null last_touchpoint_at
 * as "no idle time" is what lets a three-month-old untouched lead look fresher
 * than one called yesterday.
 */
export function idleDays(
    lastTouchpointAt: string | null,
    createdAt: string | null,
    now: number = Date.now(),
): number | null {
    const basis = lastTouchpointAt ?? createdAt;
    if (!basis) return null;
    const t = new Date(basis).getTime();
    if (Number.isNaN(t)) return null;
    return Math.max(0, Math.floor((now - t) / DAY_MS));
}

// ── Filter vocabulary ────────────────────────────────────────────────────
//
// Preset bands rather than two free-text day boxes: the question people
// actually ask is "show me what has gone cold", not "show me 43-to-61 days",
// and the bands line up with the colour ramp so a filtered list is visually
// coherent instead of a random slice through it.
//
// `min`/`max` are INCLUSIVE day counts. max: null = open-ended.
export const IDLE_RANGES = {
    "0-29": { label: "Under 30 days", min: 0, max: 29 },
    "30-59": { label: "30 – 59 days", min: 30, max: 59 },
    "60-89": { label: "60 – 89 days", min: 60, max: 89 },
    "90+": { label: "90+ days", min: 90, max: null },
    never: { label: "Never touched", min: null, max: null },
} as const;

export type IdleRangeKey = keyof typeof IDLE_RANGES;

export const IDLE_RANGE_KEYS = Object.keys(IDLE_RANGES) as IdleRangeKey[];

export function isIdleRangeKey(v: string | null | undefined): v is IdleRangeKey {
    return !!v && (IDLE_RANGE_KEYS as string[]).includes(v);
}

export function idleSeverity(days: number | null): IdleSeverity {
    if (days === null) return "fresh";
    if (days >= 90) return "cold";
    if (days >= 60) return "stale";
    if (days >= 30) return "watch";
    return "fresh";
}

/**
 * "97d" plus, once it stops being readable as days, "3.2 mo".
 *
 * The months line appears only from 30 days: below that it is noise ("0.4 mo"
 * tells nobody anything "12d" did not), and above it days alone stop being a
 * quantity anyone can feel — the difference between 97 and 140 is a month and a
 * half, which is not what those two numbers look like side by side.
 */
export function formatIdle(days: number | null): {
    primary: string;
    months: string | null;
} {
    if (days === null) return { primary: "—", months: null };
    return {
        primary: `${days}d`,
        months:
            days >= 30 ? `${(days / DAYS_PER_MONTH).toFixed(1)} mo` : null,
    };
}

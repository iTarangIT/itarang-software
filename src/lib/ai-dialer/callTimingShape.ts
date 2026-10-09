// ID 144 — when do dealers answer the AI dialer, by weekday and hour (IST)?
//
// Pure shaping for the grid: the SQL (callTiming.ts) returns one row per
// (weekday, hour) that had dials; this fills the 7 × 24 grid, totals it, and
// proposes calling hours. No I/O, so it is unit-tested on its own.

/** ISO weekday (1 = Monday … 7 = Sunday), as Postgres EXTRACT(ISODOW) gives it. */
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export interface CallTimingCount {
    dials: number;
    /** Picked up: the dealer spoke, or answered and stayed silent / hung up early. */
    answered: number;
    /** The dealer spoke (campaign status `completed`, E-300). */
    talked: number;
}

export interface CallTimingRow extends CallTimingCount {
    /** 1 = Monday … 7 = Sunday. */
    dow: number;
    /** 0–23, IST. */
    hour: number;
}

export interface CallTimingGrid {
    /** cells[dow - 1][hour]. */
    cells: CallTimingCount[][];
    byHour: CallTimingCount[];
    byWeekday: CallTimingCount[];
    total: CallTimingCount;
    /** null when there are too few dials to say anything. */
    suggestion: CallTimingSuggestion | null;
}

export interface CallTimingSuggestion {
    /** "HH:MM", inclusive start. */
    window_start: string;
    /** "HH:MM", exclusive end. */
    window_end: string;
    /** The hours that beat the overall talk rate, IST. */
    best_hours: number[];
    /** Talk rate inside the window vs overall, 0–1. */
    window_talk_rate: number;
    overall_talk_rate: number;
}

/** An hour needs this many dials before its rate is trusted. */
export const MIN_DIALS_PER_HOUR = 20;

const zero = (): CallTimingCount => ({ dials: 0, answered: 0, talked: 0 });

function add(into: CallTimingCount, c: CallTimingCount): void {
    into.dials += c.dials;
    into.answered += c.answered;
    into.talked += c.talked;
}

export const rate = (part: number, whole: number): number => (whole > 0 ? part / whole : 0);

const hhmm = (hour: number): string => `${String(hour).padStart(2, "0")}:00`;

export function buildCallTimingGrid(rows: CallTimingRow[]): CallTimingGrid {
    const cells = WEEKDAYS.map(() => Array.from({ length: 24 }, zero));
    const byHour = Array.from({ length: 24 }, zero);
    const byWeekday = WEEKDAYS.map(zero);
    const total = zero();
    for (const r of rows) {
        if (r.dow < 1 || r.dow > 7 || r.hour < 0 || r.hour > 23) continue;
        add(cells[r.dow - 1][r.hour], r);
        add(byHour[r.hour], r);
        add(byWeekday[r.dow - 1], r);
        add(total, r);
    }
    return { cells, byHour, byWeekday, total, suggestion: suggestCallingHours(byHour, total) };
}

/**
 * Calling hours from the data: the hours whose talk rate beats the overall
 * rate (each with at least MIN_DIALS_PER_HOUR dials), and the one continuous
 * window from the first such hour to the end of the last. A campaign window is
 * a single start–end range, so a gap in the middle is kept rather than split.
 */
export function suggestCallingHours(
    byHour: CallTimingCount[],
    total: CallTimingCount,
): CallTimingSuggestion | null {
    const overall = rate(total.talked, total.dials);
    const best = byHour
        .map((c, hour) => ({ hour, c }))
        .filter(({ c }) => c.dials >= MIN_DIALS_PER_HOUR && rate(c.talked, c.dials) >= overall)
        .map(({ hour }) => hour);
    if (best.length === 0 || total.talked === 0) return null;
    const first = best[0];
    const last = best[best.length - 1];
    const inWindow = zero();
    for (let h = first; h <= last; h++) add(inWindow, byHour[h]);
    return {
        window_start: hhmm(first),
        window_end: last + 1 === 24 ? "23:59" : hhmm(last + 1),
        best_hours: best,
        window_talk_rate: rate(inWindow.talked, inWindow.dials),
        overall_talk_rate: overall,
    };
}

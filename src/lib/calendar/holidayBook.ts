/**
 * Holidays as they stood at a moment (ID 85 item 7: adding a past holiday
 * must not change past results). Pure; the server side is holidaysAsOf() in
 * holidays.ts.
 *
 * holiday_calendar holds today's list; holiday_calendar_log (E-350) holds
 * every add / remove / rename since. A holiday's state at moment t is the
 * state after its last log row at or before t. Before its first log row it
 * was on the calendar unless that first row is the add — so every holiday
 * that predates the log counts always, exactly as before E-350.
 */

export type HolidayNow = { date: string; active: boolean };
export type HolidayLogRow = { date: string; action: "add" | "remove" | "rename"; at: Date };

export function buildHolidayBook(current: readonly HolidayNow[], log: readonly HolidayLogRow[]): (at: Date) => ReadonlySet<string> {
    const byDate = new Map<string, HolidayLogRow[]>();
    for (const r of log) {
        if (r.action === "rename") continue;
        const list = byDate.get(r.date);
        if (list) list.push(r);
        else byDate.set(r.date, [r]);
    }
    for (const list of byDate.values()) list.sort((a, b) => a.at.getTime() - b.at.getTime());

    const dates = new Set([...current.map((h) => h.date), ...byDate.keys()]);
    const activeNow = new Map(current.map((h) => [h.date, h.active]));
    // Every moment the answer can change, in order; the set between two of them is fixed.
    const times = [...new Set(log.filter((r) => r.action !== "rename").map((r) => r.at.getTime()))].sort((a, b) => a - b);
    const memo = new Map<number, ReadonlySet<string>>();

    const stateAt = (date: string, t: number): boolean => {
        const rows = byDate.get(date);
        if (!rows?.length) return activeNow.get(date) ?? false;
        let state = rows[0].action !== "add"; // before its first row
        for (const r of rows) {
            if (r.at.getTime() > t) break;
            state = r.action === "add";
        }
        return state;
    };

    return (at: Date) => {
        const t = at.getTime();
        // Index of the last change at or before t.
        let lo = 0;
        let hi = times.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (times[mid] <= t) lo = mid + 1;
            else hi = mid;
        }
        let set = memo.get(lo);
        if (!set) {
            const pivot = lo === 0 ? Number.NEGATIVE_INFINITY : times[lo - 1];
            set = new Set([...dates].filter((d) => stateAt(d, pivot)));
            memo.set(lo, set);
        }
        return set;
    };
}

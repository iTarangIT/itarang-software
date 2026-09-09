// Presets for the "Assigned" date filter on the Leads tab (sales_head / ceo
// oversight view). Pure and dependency-free so it is safe in the browser
// bundle and unit-testable without a clock.
//
// Two shapes of preset, on purpose:
//   • "Today" / "Yesterday" name a DAY — the window is that single date.
//   • "N ago" names a LOOKBACK — the window runs from N ago up to today, which
//     is what "show me what was assigned 1 week ago" means in practice (the
//     leads handed out this past week, not the ones handed out on exactly one
//     calendar day seven days back).
// Every preset just fills the same from/to date inputs, so the resulting
// window is always visible and can be nudged by hand.

export const ASSIGNED_PRESETS = [
    { key: "today", label: "Today" },
    { key: "yesterday", label: "Yesterday" },
    { key: "2d", label: "2 days ago" },
    { key: "1w", label: "1 week ago" },
    { key: "2w", label: "2 weeks ago" },
    { key: "1m", label: "1 month ago" },
    { key: "2m", label: "2 months ago" },
] as const;

export type AssignedPresetKey = (typeof ASSIGNED_PRESETS)[number]["key"];

export function isAssignedPresetKey(v: unknown): v is AssignedPresetKey {
    return ASSIGNED_PRESETS.some((p) => p.key === v);
}

/** Local-calendar YYYY-MM-DD — what a <input type="date"> holds. */
export function toLocalIsoDate(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate(),
    ).padStart(2, "0")}`;
}

function addDays(d: Date, n: number): Date {
    const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    out.setDate(out.getDate() + n);
    return out;
}

// Calendar-month step with the day clamped to the target month's length, so
// "1 month ago" from 31 March is 28/29 February rather than rolling over into
// early March the way a bare setMonth() would.
function addMonths(d: Date, n: number): Date {
    const first = new Date(d.getFullYear(), d.getMonth() + n, 1);
    const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    return new Date(first.getFullYear(), first.getMonth(), Math.min(d.getDate(), lastDay));
}

export function assignedPresetRange(
    key: AssignedPresetKey,
    now: Date = new Date(),
): { from: string; to: string } {
    const today = toLocalIsoDate(now);
    switch (key) {
        case "today":
            return { from: today, to: today };
        case "yesterday": {
            const y = toLocalIsoDate(addDays(now, -1));
            return { from: y, to: y };
        }
        case "2d":
            return { from: toLocalIsoDate(addDays(now, -2)), to: today };
        case "1w":
            return { from: toLocalIsoDate(addDays(now, -7)), to: today };
        case "2w":
            return { from: toLocalIsoDate(addDays(now, -14)), to: today };
        case "1m":
            return { from: toLocalIsoDate(addMonths(now, -1)), to: today };
        case "2m":
            return { from: toLocalIsoDate(addMonths(now, -2)), to: today };
    }
}

/**
 * Which preset, if any, the current from/to pair equals — so the dropdown can
 * reflect a range that arrived via the URL or was typed by hand. `""` when
 * nothing is set, `"custom"` when a range is set that matches no preset.
 */
export function matchAssignedPreset(
    from: string,
    to: string,
    now: Date = new Date(),
): AssignedPresetKey | "custom" | "" {
    if (!from && !to) return "";
    const hit = ASSIGNED_PRESETS.find((p) => {
        const r = assignedPresetRange(p.key, now);
        return r.from === from && r.to === to;
    });
    return hit ? hit.key : "custom";
}

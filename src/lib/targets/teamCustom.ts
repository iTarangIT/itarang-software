/**
 * ID 189 / ID 156 — the team total of a CUSTOM metric on the "Team against
 * your target" card. Pure (no I/O): unit-tested; the data half is
 * teamTargets() in src/lib/admin/teamPerformance.ts.
 *
 * A custom metric is measured per person by hand: its progress is the
 * manual_actual typed on that person's own target row (listTargets). Every
 * custom row has its own key ('custom_<random id>'), so "the same metric" on
 * the manager and on a member is matched by NAME + UNIT (trimmed, case and
 * spacing ignored). The team total is then the same measure, added up:
 *
 *   manager's own entry + each member's entry on the matching metric.
 *
 *   - A member without that metric adds nothing (nothing is tracked for them).
 *   - Anyone who carries it but has not entered progress yet → the total is
 *     not shown, and the reason names who has not entered it (a partial sum
 *     would read as the team being behind).
 *   - A unit that is a rate or a share (%, per day, average, rating, score…)
 *     cannot be added up across people → the reason says so.
 *
 * Hand-entered numbers are month-to-date totals, so a member who joined or
 * left the team mid-month is counted with their whole entry (the per-day
 * split used for measured metrics is not possible on a typed-in figure).
 */

export type CustomEntry = {
    user_id: string;
    user_name: string | null;
    label: string | null;
    unit: string | null;
    /** null = not entered yet. */
    manual_actual: number | null;
};

export type CustomTeamMeasure = { value: number | null; reason: string | null };

/** Same metric on two people: name + unit, trimmed, case and inner spacing ignored. */
export function customMetricKey(label: string | null | undefined, unit: string | null | undefined): string {
    const n = (s: string | null | undefined) => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    return `${n(label)}|${n(unit)}`;
}

const RATE_UNIT =
    /(%|percent|per\s*cent|\bpct\b|\bper\b|\/|\bavg\b|average|\bmean\b|rating|score|\bratio\b|\brate\b|\bnps\b|\bcsat\b)/i;

/** null when people's numbers on this unit add up; otherwise why they do not. */
export function customUnitNotSummable(unit: string | null | undefined): string | null {
    const u = (unit ?? "").trim();
    if (!u || !RATE_UNIT.test(u)) return null;
    return `"${u}" is a rate or a share, so the members' numbers cannot be added into one team total — see each person's own card.`;
}

/**
 * The team total of one custom metric. `own` is the manager's row (label +
 * unit of the metric); `entries` are the custom rows of everyone in the team
 * this month (the manager included); `teamIds` the manager + members.
 */
export function customTeamTotal(args: {
    managerId: string;
    label: string | null;
    unit: string | null;
    entries: readonly CustomEntry[];
    teamIds: ReadonlySet<string> | readonly string[];
}): CustomTeamMeasure {
    const notSummable = customUnitNotSummable(args.unit);
    if (notSummable) return { value: null, reason: notSummable };

    const team = args.teamIds instanceof Set ? args.teamIds : new Set(args.teamIds as readonly string[]);
    const key = customMetricKey(args.label, args.unit);
    const carriers = args.entries.filter((e) => (team.has(e.user_id) || e.user_id === args.managerId) && customMetricKey(e.label, e.unit) === key);

    const missing: string[] = [];
    let sum = 0;
    const seenMissing = new Set<string>();
    for (const e of carriers) {
        if (e.manual_actual == null || !Number.isFinite(Number(e.manual_actual))) {
            if (!seenMissing.has(e.user_id)) {
                seenMissing.add(e.user_id);
                missing.push(e.user_id === args.managerId ? "you" : (e.user_name ?? "a member"));
            }
            continue;
        }
        sum += Number(e.manual_actual);
    }
    if (missing.length) {
        return {
            value: null,
            reason: `Not entered yet by ${missing.join(", ")} — the team total adds each person's hand-entered progress on this metric.`,
        };
    }
    if (!carriers.length) {
        return { value: null, reason: "Not entered yet — this metric's progress is typed in by hand." };
    }
    return { value: Math.round(sum * 10) / 10, reason: null };
}

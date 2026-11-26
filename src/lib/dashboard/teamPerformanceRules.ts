/**
 * Sales Head › Team performance — the pure half (26 Nov task: team-level
 * performance, Hot/Warm/Cold, quotes, dealers onboarded, conversion, progress
 * against targets, monthly review, target status per person, downloadable
 * report). CLIENT-SAFE: no `db` import. The data half is ./teamPerformance.ts.
 *
 * Every figure is one the Sales dashboard builder or the targets service
 * already owns (so this card can never disagree with the scorecard below it);
 * this module only adds them up for the team and explains target status.
 */

export type TeamSegment = "all" | "field" | "inside";

const FIELD_ROLES = ["asm", "sales_manager"];
const INSIDE_ROLES = ["inside_sales_rep"];

/** Which team a role belongs to (same split as the Sales dashboard's Team control). */
export function segmentOf(role: string | null | undefined): "field" | "inside" | "other" {
    const r = (role ?? "").toLowerCase();
    if (FIELD_ROLES.includes(r)) return "field";
    if (INSIDE_ROLES.includes(r)) return "inside";
    return "other";
}

export function inSegment(role: string | null | undefined, seg: TeamSegment): boolean {
    return seg === "all" || segmentOf(role) === seg;
}

/** The activity and outcome counts one person (or the whole team) carries. */
export interface PerfCounts {
    visits: number;
    /** Dealers new to iTarang (first visit by anyone) in the range. */
    new_visits: number;
    /** Distinct dealers visited. */
    unique_visits: number;
    calls: number;
    /** Open rated leads owned now (as of today, not the range). */
    hot: number;
    warm: number;
    cold: number;
    /** Leads that became Hot in the range and are still Hot. */
    new_hot: number;
    /** Leads with a first quote in the range. */
    quotes_issued: number;
    quote_revisions: number;
    /** Onboarding applications approved in the range, credited to the salesperson. */
    dealers_onboarded: number;
    /** Leads closed Converted in the range. */
    converted: number;
    /** Leads closed Lost in the range. */
    lost: number;
    kyc_submitted: number;
    revenue: number;
}

export const ZERO_COUNTS: PerfCounts = {
    visits: 0,
    new_visits: 0,
    unique_visits: 0,
    calls: 0,
    hot: 0,
    warm: 0,
    cold: 0,
    new_hot: 0,
    quotes_issued: 0,
    quote_revisions: 0,
    dealers_onboarded: 0,
    converted: 0,
    lost: 0,
    kyc_submitted: 0,
    revenue: 0,
};

export function sumCounts(list: PerfCounts[]): PerfCounts {
    const out: PerfCounts = { ...ZERO_COUNTS };
    for (const c of list) for (const k of Object.keys(out) as (keyof PerfCounts)[]) out[k] += Number(c[k] ?? 0);
    return out;
}

/**
 * Lead conversion: of the leads CLOSED in the range, the share that closed
 * Converted (Converted ÷ (Converted + Lost)), whole %. Null when nothing closed —
 * "no closed leads" is not 0%.
 */
export function conversionPct(converted: number, lost: number): number | null {
    const closed = converted + lost;
    if (closed <= 0) return null;
    return Math.round((converted / closed) * 100);
}

// ── Target status per person (task 4) ───────────────────────────────────────

/** The fields of a target row this module reads (a subset of targets/service TargetRow). */
export interface TargetLike {
    user_id: string;
    metric: string;
    metric_label: string;
    status: string;
    final_target: number;
    kind: "count" | "money" | "per_day";
    pushed_at: string | null;
    accepted_at: string | null;
    hours_since_push_unaccepted: number | null;
    correction_open: boolean;
    progress: { actual: number | null; mtd_target: number; pct_of_mtd: number | null; monthly_target: number };
}

export type TargetState = "none" | "with_sales_head" | "awaiting_acceptance" | "correction_asked" | "accepted" | "partly_accepted";

export interface PersonTargetStatus {
    state: TargetState;
    /** Short words for the badge. */
    label: string;
    /** Why the scorecard does / does not show the person's target, and what to do. */
    detail: string;
    /** Targets in force on the scorecard (pushed or accepted). */
    in_force: number;
    accepted: number;
    /** Posted by the CEO, still with the Sales Head (not pushed). */
    with_sales_head: number;
    /** Hours since the first push, for the oldest unaccepted target. */
    oldest_unaccepted_h: number | null;
    last_pushed_at: string | null;
    last_accepted_at: string | null;
}

/**
 * Why a person's target does or does not appear (26 Nov task 4). The
 * scorecard reads only targets SENT to the member ("pushed" or "accepted",
 * ID 157), for the month of the period's end date; a CEO draft is invisible to
 * the Sales Head and a posted-but-not-pushed one is still in his queue.
 */
export function personTargetStatus(rows: TargetLike[], month: string): PersonTargetStatus {
    const live = rows.filter((r) => r.status !== "removed" && r.status !== "draft");
    const inForce = live.filter((r) => r.status === "pushed" || r.status === "accepted");
    const accepted = live.filter((r) => r.status === "accepted");
    const waiting = live.filter((r) => r.status === "pending_approval" || r.status === "rejected");
    const correction = live.filter((r) => r.correction_open);
    const unaccepted = live.filter((r) => r.status === "pushed");
    const maxIso = (xs: (string | null)[]) => xs.filter(Boolean).sort().at(-1) ?? null;
    const base = {
        in_force: inForce.length,
        accepted: accepted.length,
        with_sales_head: waiting.length,
        oldest_unaccepted_h: unaccepted.length ? Math.max(...unaccepted.map((r) => r.hours_since_push_unaccepted ?? 0)) : null,
        last_pushed_at: maxIso(live.map((r) => r.pushed_at)),
        last_accepted_at: maxIso(live.map((r) => r.accepted_at)),
    };
    const monthWord = monthLabel(month);
    if (live.length === 0) {
        return {
            ...base,
            state: "none",
            label: "No target",
            detail: `No target posted for ${monthWord}. Targets are set per month — the CEO adds the person on Admin › Targets and posts it; a CEO draft is not visible here.`,
        };
    }
    if (inForce.length === 0) {
        return {
            ...base,
            state: "with_sales_head",
            label: "Not pushed yet",
            detail: `${waiting.length} target${waiting.length === 1 ? "" : "s"} posted by the CEO but not pushed to the member — the scorecard shows "no target" until you push from Admin › Targets.`,
        };
    }
    if (correction.length > 0) {
        return {
            ...base,
            state: "correction_asked",
            label: "Correction asked",
            detail: `The member asked for a correction on ${correction.length} target${correction.length === 1 ? "" : "s"}. The pushed number stays in force on the scorecard until you push again.`,
        };
    }
    if (accepted.length === inForce.length) {
        return {
            ...base,
            state: "accepted",
            label: "Accepted",
            detail:
                `All ${inForce.length} target${inForce.length === 1 ? "" : "s"} accepted` +
                (waiting.length ? `; ${waiting.length} more posted but not pushed yet.` : "."),
        };
    }
    if (accepted.length === 0) {
        return {
            ...base,
            state: "awaiting_acceptance",
            label: "Not accepted yet",
            detail:
                `Sent, not accepted yet${base.oldest_unaccepted_h != null ? ` (${base.oldest_unaccepted_h} h since the first push)` : ""}. ` +
                "Sent targets already count on the scorecard; the member accepts them on their Performance page." +
                (waiting.length ? ` ${waiting.length} more posted but not pushed yet.` : ""),
        };
    }
    return {
        ...base,
        state: "partly_accepted",
        label: `${accepted.length} of ${inForce.length} accepted`,
        detail: `${inForce.length - accepted.length} sent target${inForce.length - accepted.length === 1 ? "" : "s"} not accepted yet; sent targets already count on the scorecard.`,
    };
}

// ── Team progress against target ────────────────────────────────────────────

export interface TeamTargetRow {
    metric: string;
    label: string;
    kind: "count" | "money" | "per_day";
    /** People whose target for this metric is in force. */
    people: number;
    /** Their ids — the rows behind the actual are theirs only. */
    user_ids: string[];
    /** Σ monthly targets in force. For a per-day metric, Σ of each person's daily rate. */
    monthly_target: number;
    /** Σ month-to-date (pro-rata) targets. */
    mtd_target: number;
    /** Σ actuals of the same people; null when none of them is measured. */
    actual: number | null;
    /** actual ÷ MTD target, whole %. */
    pct: number | null;
}

/**
 * Team progress: each metric's targets IN FORCE (pushed or accepted) added up
 * over the people in `userIds`, against the same people's actuals — a person
 * without a target for a metric adds nothing to either side, so the % never
 * mixes targeted and untargeted work.
 */
export function rollupTeamTargets(rows: TargetLike[], userIds: ReadonlySet<string>): TeamTargetRow[] {
    const by = new Map<string, TeamTargetRow & { measured: number }>();
    for (const r of rows) {
        if (!userIds.has(r.user_id)) continue;
        if (r.status !== "pushed" && r.status !== "accepted") continue;
        const t =
            by.get(r.metric) ??
            ({ metric: r.metric, label: r.metric_label, kind: r.kind, people: 0, user_ids: [], monthly_target: 0, mtd_target: 0, actual: 0, pct: null, measured: 0 } as TeamTargetRow & {
                measured: number;
            });
        t.people += 1;
        t.user_ids.push(r.user_id);
        t.monthly_target += Number(r.progress.monthly_target ?? r.final_target ?? 0);
        t.mtd_target += Number(r.progress.mtd_target ?? 0);
        if (r.progress.actual != null) {
            t.actual = (t.actual ?? 0) + Number(r.progress.actual);
            t.measured += 1;
        }
        by.set(r.metric, t);
    }
    // A metric whose targets add up to 0 (e.g. "KYC disbursed 0") is not a goal.
    return [...by.values()].filter((t) => t.monthly_target > 0).map(({ measured, ...t }) => {
        const actual = measured > 0 ? round1(t.actual ?? 0) : null;
        return {
            ...t,
            monthly_target: round1(t.monthly_target),
            mtd_target: round1(t.mtd_target),
            actual,
            pct: actual != null && t.mtd_target > 0 ? Math.round((actual / t.mtd_target) * 100) : null,
        };
    });
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// ── Monthly review ──────────────────────────────────────────────────────────

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "2026-11" → "Nov 2026". */
export function monthLabel(month: string): string {
    const [y, m] = month.slice(0, 7).split("-").map(Number);
    const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${names[(m || 1) - 1]} ${y}`;
}

/**
 * A whole calendar month as a date range for the review: 1st to the last day,
 * or to `today` while the month is still running. `month` is YYYY-MM.
 */
export function monthRange(month: string, today: string): { from: string; to: string } {
    const [y, m] = month.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const from = `${y}-${pad2(m)}-01`;
    const end = `${y}-${pad2(m)}-${pad2(last)}`;
    return { from, to: end > today ? today : end };
}

/** The month before `today`'s, YYYY-MM. */
export function previousMonth(today: string): string {
    const [y, m] = today.split("-").map(Number);
    return m === 1 ? `${y - 1}-12` : `${y}-${pad2(m - 1)}`;
}

/** The last `n` months up to and including `today`'s, newest first, YYYY-MM. */
export function recentMonths(today: string, n: number): string[] {
    const out: string[] = [];
    let [y, m] = today.split("-").map(Number);
    for (let i = 0; i < n; i++) {
        out.push(`${y}-${pad2(m)}`);
        m -= 1;
        if (m === 0) {
            m = 12;
            y -= 1;
        }
    }
    return out;
}

// ── Click a number → its rows (salesDrill.ts) ───────────────────────────────

/**
 * The drill kind behind each target metric's actual (targets/service.ts
 * measuresFor). calls_per_day lists the calls behind the daily average; a
 * metric with nothing to list (KYC disbursed, a custom metric) has none.
 */
export const TARGET_METRIC_DRILL: Record<string, string> = {
    dealer_visits: "dealers_visited",
    new_dealer_visits: "new_dealers",
    batteries_sold: "batteries",
    kyc_submitted: "kyc_submitted",
    revenue: "revenue",
    scrap_deals: "scrap_deals",
    calls_per_day: "calls",
    hot_to_ground: "hot_to_ground",
};

/** The Team card's numbers and the drill kind each opens. */
export const TEAM_COUNT_DRILL = {
    visits: "visits",
    unique_visits: "dealers_visited",
    new_visits: "new_dealers",
    calls: "calls",
    hot: "hot",
    warm: "warm",
    cold: "cold",
    new_hot: "new_hot",
    quotes_issued: "quotes_issued",
    quote_revisions: "quote_revisions",
    dealers_onboarded: "onboarded",
    converted: "converted",
    lost: "lost",
    kyc_submitted: "kyc_submitted",
    revenue: "revenue",
} as const satisfies Partial<Record<keyof PerfCounts, string>>;

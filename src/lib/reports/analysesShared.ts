// Reports › Analyses (Sales Head redesign, 6 Oct 2026). CLIENT-SAFE: types,
// the catalogue of the three analyses, and the pure helpers both the page and
// the builders use. The builders live in analyses.ts (server only).
//
// Every analysis returns the totals it shows AND the checks that prove they
// add up. A check is evaluated on every row and is never hidden: a failing one
// shows as "Breaks" with the row that broke it.

export const ANALYSIS_IDS = ["lead_sources", "ai_score", "meetings"] as const;
export type AnalysisId = (typeof ANALYSIS_IDS)[number];

export function isAnalysisId(v: string | null | undefined): v is AnalysisId {
    return (ANALYSIS_IDS as readonly string[]).includes(v ?? "");
}

export interface AnalysisCheck {
    label: string;
    holds: boolean;
    /** Why it broke, naming the row. Empty when it holds. */
    detail: string;
}

export interface AnalysisPeriod {
    /** Inclusive IST calendar days, yyyy-mm-dd. */
    from: string;
    to: string;
}

// ── Lead sources ────────────────────────────────────────────────────────────

export const LEAD_SOURCE_GROUPS = ["door", "origin", "campaign"] as const;
export type LeadSourceGroup = (typeof LEAD_SOURCE_GROUPS)[number];

/** The funnel columns after "Leads in", in order. Each is a subset of the one before. */
export const FUNNEL_STEPS = ["not_with_sales", "assigned", "called", "quote_sent", "won", "converted"] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

export interface LeadSourceRow {
    /** The group value as stored (door / origin code, campaign id); null = not recorded. */
    key: string | null;
    label: string;
    /** Under the label: origins and campaigns behind a door, the kind of a campaign. */
    sub: string;
    leads_in: number;
    not_with_sales: number;
    assigned: number;
    called: number;
    quote_sent: number;
    won: number;
    converted: number;
    /** assigned = open + onboarding + lost + converted. */
    open: number;
    onboarding: number;
    lost: number;
    top_lost_reason: string | null;
}

export interface LeadSourcesResult {
    period: AnalysisPeriod;
    group: LeadSourceGroup;
    total: LeadSourceRow;
    rows: LeadSourceRow[];
    /**
     * ID 153 — leads that came in as a bulk import (scraper, list upload,
     * AI-dialer list, NeoDove list push), counted apart from "Leads in" and
     * from every source row; null when there were none.
     */
    bulk: LeadSourceRow | null;
    checks: AnalysisCheck[];
}

// ── AI score accuracy ───────────────────────────────────────────────────────

export const AI_BANDS = ["81-100", "61-80", "41-60", "21-40", "0-20"] as const;
export const AI_NOT_SCORED = "not_scored";

export interface AiScoreRow {
    band: string;
    label: string;
    converted: number;
    lost: number;
    closed: number;
}

export interface AiScoreResult {
    period: AnalysisPeriod;
    rows: AiScoreRow[];
    total: AiScoreRow;
    checks: AnalysisCheck[];
}

// ── Meetings ────────────────────────────────────────────────────────────────

/**
 * One row per field person × city. The counting rules are the Sales Head Ops
 * dashboard's (src/lib/admin/salesDashboard.ts), so the two always agree:
 *   visits   one person, one dealer, one day with a visit that happened
 *   dealers  different dealers visited
 *   fresh    visits on the dealer's first-ever visit day; repeat = the rest
 *   planned  visits planned for a day in the period and still open
 */
export interface MeetingRow {
    manager_id: string | null;
    manager: string;
    inactive: boolean;
    city: string;
    visits: number;
    dealers: number;
    fresh: number;
    repeat: number;
    planned: number;
    ground: number;
    calling: number;
    whatsapp: number;
}

export interface MeetingsResult {
    period: AnalysisPeriod;
    rows: MeetingRow[];
    total: MeetingRow;
    checks: AnalysisCheck[];
    /** Every field person (active ASMs and sales managers, plus anyone with visits), for the filter. */
    managers: { id: string; name: string; inactive: boolean }[];
    cities: string[];
    /** True while no visit has a meeting type other than ground — the type is not captured yet. */
    mode_not_captured: boolean;
}

export type AnalysisResult = LeadSourcesResult | AiScoreResult | MeetingsResult;

// ── Catalogue (the cards) ───────────────────────────────────────────────────

export interface AnalysisMeta {
    id: AnalysisId;
    name: string;
    tag: "NEW" | "MOVED";
    decides: string;
    basis: string;
    cadence: string;
    who: string;
    dlLabel: string;
    /** The Data downloads dataset the "Download these …" button opens. */
    dataset: "leads" | "visits";
    periodLabel: string;
    note: string;
    links: { from: string; to: string }[];
}

export const ANALYSES: AnalysisMeta[] = [
    {
        id: "lead_sources",
        name: "Lead sources",
        tag: "NEW",
        decides: "Which lead sources to feed and which to cut, down to each campaign.",
        basis: "the date the lead came in",
        cadence: "weekly",
        who: "CEO, Admin, Sales Head",
        dlLabel: "Download these leads",
        dataset: "leads",
        periodLabel: "Leads created",
        note:
            "Counts leads by the date they came in (IST), so it will not match a dashboard that counts what happened in the month. " +
            "Leads from the last 30 days are still moving through the steps; their numbers will rise. Replaces the old \"Source performance\" report.",
        links: [
            { from: "CEO overview · sales funnel", to: "By source, same period" },
            { from: "Sales Head dashboard · funnel", to: "By source, same period" },
            { from: "Each campaign, scraper run and upload batch", to: "Group by Campaign" },
            { from: "Old \"Source performance\" report", to: "Replaced by this" },
        ],
    },
    {
        id: "ai_score",
        name: "AI score accuracy",
        tag: "MOVED",
        decides: "Whether the AI score keeps deciding who gets called first.",
        basis: "the date the lead closed",
        cadence: "monthly",
        who: "CEO, Admin, Sales Head",
        dlLabel: "Download these leads",
        dataset: "leads",
        periodLabel: "Leads closed",
        note:
            "Closed means converted (admin approved, dealer live) or lost. Won and waiting for approval is not closed yet. " +
            "Leads the AI never scored are shown on their own row, not in 0–20. If a higher band ever converts worse than a lower one, " +
            "the score stops deciding call order until it is retrained.",
        links: [
            { from: "AI intent learning", to: "Is the score right?" },
            { from: "Old \"AI Score Accuracy\" report", to: "Replaced by this" },
        ],
    },
    {
        id: "meetings",
        name: "Meetings",
        tag: "MOVED",
        decides: "Whether field time goes to new dealers or repeat visits, by manager and city.",
        basis: "the meeting date",
        cadence: "month to date",
        who: "CEO, Admin, Sales Head",
        dlLabel: "Download these visits",
        dataset: "visits",
        periodLabel: "Meeting date",
        note:
            "Counted the same way as the Ops dashboard and the Sales Daily email: a visit is one person at one dealer on one day, and only visits that " +
            "happened count. Fresh is a visit on the dealer's first-ever visit day; every later visit is a repeat. Planned are visits booked for a day " +
            "in this period that have not happened yet. Every active ASM is listed, even with no visits.",
        links: [
            { from: "Sales Head dashboard · Field tab", to: "Meetings by city" },
            { from: "Old \"Meetings (MTD)\" report", to: "Replaced by this" },
        ],
    },
];

// ── Pure helpers ────────────────────────────────────────────────────────────

/** Indian grouping: 12,34,567. */
export const fmtNum = (n: number): string => n.toLocaleString("en-IN");

/** A share as the spec shows it: whole number from 10% up, one decimal below. "—" when there is no base. */
export function pct(n: number, base: number): string {
    if (!base) return "—";
    const p = (n / base) * 100;
    return `${p >= 10 ? p.toFixed(0) : p.toFixed(1)}%`;
}

/** A rate always to one decimal ("4.2%"). "—" when there is no base. */
export function rate1(n: number, base: number): string {
    if (!base) return "—";
    return `${((n / base) * 100).toFixed(1)}%`;
}

/**
 * The base each funnel cell is a share of.
 *   share — every cell ÷ Leads in.
 *   step  — each cell ÷ the step before it. "Assigned" follows "Leads in", not
 *           "Not with sales yet": the two are a split of Leads in, not a step.
 */
export function stepBase(row: Pick<LeadSourceRow, FunnelStep | "leads_in">, step: FunnelStep, mode: "share" | "step"): number {
    if (mode === "share") return row.leads_in;
    switch (step) {
        case "not_with_sales":
        case "assigned":
            return row.leads_in;
        case "called":
            return row.assigned;
        case "quote_sent":
            return row.called;
        case "won":
            return row.quote_sent;
        case "converted":
            return row.won;
    }
}

/** Bar width in % of the best rate among the rows, with a 2% floor so a non-zero rate stays visible. */
export function barWidth(rate: number, best: number): number {
    if (!best || !rate) return 0;
    return Math.max(2, Math.round((rate / best) * 100));
}

/**
 * One check over many rows: holds when `ok` is true for every row; otherwise
 * names the first rows that break it (up to three) so the reader can look.
 */
export function checkRows<T>(label: string, rows: T[], ok: (r: T) => boolean, name: (r: T) => string): AnalysisCheck {
    const broken = rows.filter((r) => !ok(r));
    if (broken.length === 0) return { label, holds: true, detail: "" };
    const shown = broken.slice(0, 3).map(name).join(", ");
    const more = broken.length > 3 ? ` and ${broken.length - 3} more` : "";
    return { label, holds: false, detail: `Breaks on ${shown}${more}.` };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-01".."2026-09-26" → "1 – 26 Sep 2026"; across months/years it spells both ends. */
export function periodLabel(p: AnalysisPeriod): string {
    const d = (s: string) => new Date(`${s}T00:00:00Z`);
    const a = d(p.from);
    const b = d(p.to);
    const day = (x: Date) => x.getUTCDate();
    // A fixed list: ICU's en-GB "short" month is "Sept" on some runtimes.
    const mon = (x: Date) => MONTHS[x.getUTCMonth()];
    const yr = (x: Date) => x.getUTCFullYear();
    if (yr(a) !== yr(b)) return `${day(a)} ${mon(a)} ${yr(a)} – ${day(b)} ${mon(b)} ${yr(b)}`;
    if (mon(a) !== mon(b)) return `${day(a)} ${mon(a)} – ${day(b)} ${mon(b)} ${yr(b)}`;
    return `${day(a)} – ${day(b)} ${mon(b)} ${yr(b)}`;
}

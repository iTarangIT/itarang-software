/**
 * Sales targets — the pure rules (review R-17, sheet 8, Requirement #15). No
 * I/O: unit-tested and importable from client components. The data half is
 * ./service.ts.
 *
 * WORKFLOW (sheet 8 + item 3, 14 Oct 2026): the CEO creates a person's targets
 * and SENDS THEM TO THE SALES HEAD ("pending_approval" = with the Sales Head
 * for review). The Sales Head reviews, may change the numbers and add or remove
 * metrics, and SENDS THEM TO THE MEMBER ("pushed"). The member is told (bell +
 * email) and ACCEPTS or REJECTS — a reject needs a comment and goes back to the
 * Sales Head and CEO, who edit and send again. Admin may still ADD (never
 * reduce). Unaccepted 48h after sending → a daily email to Admin + Sales Head
 * (the targets_pending digest). Editing a sent or accepted target sends it back
 * to the Sales Head's review, so a changed number is re-reviewed and
 * re-accepted rather than silently swapped under the employee.
 *
 * METRICS: any built-in metric (TARGET_METRICS — a role's defaults are added
 * with the person, others can be added one by one), or a CUSTOM one: a name and
 * unit typed in, stored as metric = 'custom_<id>', progress entered by hand.
 *
 * PRO-RATA (sheet 8 §B): the monthly target is spread equally over the month's
 * working days (Mon–Sat minus holiday_calendar). MTD target = monthly ×
 * elapsed ÷ total. A "per day" metric (calls per day) is a rate already, so it
 * is compared to the running daily average instead.
 */

export const TARGET_METRICS = {
    dealer_visits: { label: "Dealer visits (new + existing)", roles: ["asm"], kind: "count" },
    new_dealer_visits: { label: "New dealer visits", roles: ["asm"], kind: "count" },
    batteries_sold: { label: "Batteries sold (qty)", roles: ["asm"], kind: "count" },
    kyc_submitted: { label: "KYC submitted", roles: ["asm"], kind: "count" },
    kyc_disbursed: { label: "KYC disbursed", roles: ["asm"], kind: "count" },
    scrap_deals: { label: "Scrap deals", roles: ["asm"], kind: "count" },
    revenue: { label: "Total revenue ₹", roles: ["asm"], kind: "money" },
    calls_per_day: { label: "Calls per day", roles: ["inside_sales_rep"], kind: "per_day" },
    hot_to_ground: { label: "Hot leads shared with ground", roles: ["inside_sales_rep"], kind: "count" },
} as const satisfies Record<string, { label: string; roles: readonly string[]; kind: "count" | "money" | "per_day" }>;

export type TargetMetric = keyof typeof TARGET_METRICS;
export const TARGET_METRIC_KEYS = Object.keys(TARGET_METRICS) as TargetMetric[];

export function isTargetMetric(v: string): v is TargetMetric {
    return (TARGET_METRIC_KEYS as string[]).includes(v);
}

export type MetricKind = "count" | "money" | "per_day";

/** A custom metric's key: 'custom_' + a short random id (fits varchar(40)). */
export const CUSTOM_METRIC_PREFIX = "custom_";

export function isCustomMetric(metric: string): boolean {
    return metric.startsWith(CUSTOM_METRIC_PREFIX);
}

export function newCustomMetricKey(): string {
    return `${CUSTOM_METRIC_PREFIX}${Math.random().toString(36).slice(2, 10)}`;
}

/** How a metric's numbers read: built-in from TARGET_METRICS; custom from its unit ('₹' / 'rs' = money). */
export function metricKind(metric: string, customUnit?: string | null): MetricKind {
    if (isTargetMetric(metric)) return TARGET_METRICS[metric].kind;
    return /^(₹|rs\.?|inr|rupees?)$/i.test((customUnit ?? "").trim()) ? "money" : "count";
}

/** A custom metric's name and unit: trimmed, required name, short. */
export function validateCustomMetric(label: string, unit: string | null | undefined): string | null {
    const l = label.trim();
    if (l.length < 2) return "Give the metric a name.";
    if (l.length > 80) return "Keep the metric name under 80 characters.";
    if ((unit ?? "").trim().length > 20) return "Keep the unit under 20 characters.";
    return null;
}

/** Shortest reject comment accepted — a reason, not a shrug. */
export const REJECT_COMMENT_MIN = 5;

export function validateRejectComment(comment: string | null | undefined): string | null {
    const c = (comment ?? "").trim();
    if (c.length < REJECT_COMMENT_MIN) return `Say why you are rejecting (at least ${REJECT_COMMENT_MIN} characters).`;
    if (c.length > 1000) return "Keep the comment under 1000 characters.";
    return null;
}

/** The metrics a role is given targets on (#15). Unknown roles get none. */
export function metricsForRole(role: string | null | undefined): TargetMetric[] {
    const r = (role ?? "").toLowerCase();
    return TARGET_METRIC_KEYS.filter((m) => (TARGET_METRICS[m].roles as readonly string[]).includes(r));
}

export const TARGET_STATUSES = ["draft", "pending_approval", "pushed", "accepted", "rejected"] as const;
export type TargetStatus = (typeof TARGET_STATUSES)[number];

/** What each status means on screen. "pending_approval" is the Sales Head's review. */
export const TARGET_STATUS_LABEL: Record<TargetStatus, string> = {
    draft: "Draft (CEO)",
    pending_approval: "With Sales Head for review",
    pushed: "Sent — awaiting acceptance",
    accepted: "Accepted",
    rejected: "Rejected by member",
};

/** Hours after push before an unaccepted target is escalated (#15). */
export const ACCEPT_WITHIN_HOURS = 48;

/** "can add, never reduce": a negative add-on is refused, never clamped silently. */
export function validateAddon(addon: number): string | null {
    if (!Number.isFinite(addon)) return "Enter a number.";
    if (addon < 0) return "Admin can add to the CEO's target but never reduce it.";
    return null;
}

/** #15: KYC disbursed target must not exceed KYC submitted target. */
export function validateKycPair(submittedFinal: number | null, disbursedFinal: number | null): string | null {
    if (submittedFinal == null || disbursedFinal == null) return null;
    return disbursedFinal > submittedFinal
        ? "KYC disbursed target cannot be more than the KYC submitted target."
        : null;
}

/** First day of the month containing `iso` (YYYY-MM-DD). */
export function monthStart(iso: string): string {
    return `${iso.slice(0, 7)}-01`;
}

/** Working days (Mon–Sat, not a holiday) in [from, to] inclusive, IST dates as YYYY-MM-DD. */
export function workingDaysBetween(from: string, to: string, holidays: ReadonlySet<string>): number {
    if (to < from) return 0;
    let n = 0;
    const d = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    while (d.getTime() <= end.getTime()) {
        const iso = d.toISOString().slice(0, 10);
        if (d.getUTCDay() !== 0 && !holidays.has(iso)) n++;
        d.setUTCDate(d.getUTCDate() + 1);
    }
    return n;
}

export function monthEnd(monthFirst: string): string {
    const d = new Date(`${monthFirst}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    d.setUTCDate(0);
    return d.toISOString().slice(0, 10);
}

export type Rag = "green" | "amber" | "red";

/** ≥100 % green, 80–99 % amber, below 80 % red (sheet 5 S1; thresholds fixed for now). */
export function rag(pct: number | null): Rag | null {
    if (pct == null) return null;
    if (pct >= 100) return "green";
    if (pct >= 80) return "amber";
    return "red";
}

export type Progress = {
    monthly_target: number;
    mtd_target: number;
    actual: number | null;
    pct_of_mtd: number | null;
    remaining: number | null;
    required_per_day: number | null;
    rag: Rag | null;
};

/**
 * Sheet 8 §B for one target. `actual` null = the metric is not measurable in
 * the CRM yet; the row still shows its target, with no RAG.
 */
export function progress(args: {
    metric: string;
    /** A custom metric's kind (metricKind); built-in metrics read TARGET_METRICS. */
    kind?: MetricKind;
    monthly: number;
    actual: number | null;
    workingDaysTotal: number;
    workingDaysElapsed: number;
}): Progress {
    const { metric, monthly, actual, workingDaysTotal, workingDaysElapsed } = args;
    const perDay = (args.kind ?? metricKind(metric)) === "per_day";
    const mtd = perDay
        ? monthly
        : workingDaysTotal > 0
          ? (monthly * workingDaysElapsed) / workingDaysTotal
          : 0;
    const pct = actual == null || mtd <= 0 ? null : Math.round((actual / mtd) * 100);
    const left = Math.max(workingDaysTotal - workingDaysElapsed, 0);
    const remaining = actual == null || perDay ? null : Math.max(monthly - actual, 0);
    return {
        monthly_target: monthly,
        mtd_target: Math.round(mtd * 100) / 100,
        actual,
        pct_of_mtd: pct,
        remaining,
        required_per_day: remaining == null ? null : left > 0 ? Math.round((remaining / left) * 100) / 100 : remaining,
        rag: rag(pct),
    };
}

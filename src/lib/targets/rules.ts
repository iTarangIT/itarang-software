/**
 * Sales targets — the pure rules (review R-17, sheet 8, Requirement #15). No
 * I/O: unit-tested and importable from client components. The data half is
 * ./service.ts.
 *
 * WORKFLOW (sheet 8): CEO sets → Admin may ADD (never reduce) → Admin / Sales
 * Head approve and push → the employee accepts; unaccepted 48h after push →
 * a daily email to Admin + Sales Head (the targets_pending digest). Targets
 * stay editable during the month: editing a pushed or accepted target sends it
 * back to "pending approval", so a changed number is re-approved and re-accepted
 * rather than silently swapped under the employee.
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

/** The metrics a role is given targets on (#15). Unknown roles get none. */
export function metricsForRole(role: string | null | undefined): TargetMetric[] {
    const r = (role ?? "").toLowerCase();
    return TARGET_METRIC_KEYS.filter((m) => (TARGET_METRICS[m].roles as readonly string[]).includes(r));
}

export const TARGET_STATUSES = ["draft", "pending_approval", "pushed", "accepted"] as const;
export type TargetStatus = (typeof TARGET_STATUSES)[number];

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
    metric: TargetMetric;
    monthly: number;
    actual: number | null;
    workingDaysTotal: number;
    workingDaysElapsed: number;
}): Progress {
    const { metric, monthly, actual, workingDaysTotal, workingDaysElapsed } = args;
    const perDay = TARGET_METRICS[metric].kind === "per_day";
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

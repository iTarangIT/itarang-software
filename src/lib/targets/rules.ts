/**
 * Sales targets — the pure rules (review R-17, sheet 8, Requirement #15). No
 * I/O: unit-tested and importable from client components. The data half is
 * ./service.ts.
 *
 * WORKFLOW (ID 189 — Kartik 14 Oct, confirmed 16 Oct): the CEO enters each
 * person's targets as DRAFTS nobody else sees, and only the CEO POSTS them to
 * the Sales Head ("pending_approval" = posted, with the Sales Head). The Sales
 * Head (or Admin) adds an ADD-ONLY STRETCH per target with an optional note —
 * final = CEO target + stretch (CEO 100 + 50 = 150), no CEO re-confirmation —
 * and PUSHES to the member ("pushed"). The member is told (bell + email) and
 * ACCEPTS (optional remark) or ASKS FOR A CORRECTION with a remark, which tells
 * the Sales Head; there is no reject. The 48-hour acceptance clock runs from
 * the FIRST push and a correction never resets it; unaccepted 48h after the
 * first push → a daily email to Admin + Sales Head (targets_pending).
 *
 * VERSIONS: a CEO edit after Post is a DRAFT REVISION and a stretch change on a
 * target the member already has waits for the next push — the posted version
 * stays IN FORCE (the member's card, the scorecard, the daily email) until the
 * revision is posted and pushed. Every change is kept (sales_target_versions).
 * Where an edit lands is decided by ceoEditLands / stretchEditLands / postLands
 * below. "rejected" is the old (14 Oct) flow's status, still readable.
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

/** Shortest correction remark accepted — a reason, not a shrug. */
export const CORRECTION_REMARK_MIN = 5;
/** @deprecated the 14 Oct reject — kept for old callers. */
export const REJECT_COMMENT_MIN = CORRECTION_REMARK_MIN;

/** ID 189: "Ask for correction" needs a remark the Sales Head can act on. */
export function validateCorrectionRemark(remark: string | null | undefined): string | null {
    const c = (remark ?? "").trim();
    if (c.length < CORRECTION_REMARK_MIN) return `Say what needs correcting (at least ${CORRECTION_REMARK_MIN} characters).`;
    if (c.length > 1000) return "Keep the remark under 1000 characters.";
    return null;
}

/** @deprecated the 14 Oct reject — validateCorrectionRemark. */
export const validateRejectComment = validateCorrectionRemark;

/** ID 189: Accept and the stretch take an OPTIONAL remark / note; only its length is checked. */
export function validateOptionalRemark(remark: string | null | undefined): string | null {
    return (remark ?? "").trim().length > 1000 ? "Keep the remark under 1000 characters." : null;
}

/** The metrics a role is given targets on (#15). Unknown roles get none. */
export function metricsForRole(role: string | null | undefined): TargetMetric[] {
    const r = (role ?? "").toLowerCase();
    return TARGET_METRIC_KEYS.filter((m) => (TARGET_METRICS[m].roles as readonly string[]).includes(r));
}

/** Live statuses. A removed target is "removed" (TARGET_REMOVED_STATUS) — never listed. */
export const TARGET_STATUSES = ["draft", "pending_approval", "pushed", "accepted", "rejected"] as const;
export type TargetStatus = (typeof TARGET_STATUSES)[number];

/** What each status means on screen. "pending_approval" = posted by the CEO, with the Sales Head. */
export const TARGET_STATUS_LABEL: Record<TargetStatus, string> = {
    draft: "Draft (CEO only)",
    pending_approval: "Posted — with Sales Head",
    pushed: "Sent — awaiting acceptance",
    accepted: "Accepted",
    rejected: "Rejected (old flow) — push again",
};

/** Hours after the FIRST push before an unaccepted target is escalated (#15, ID 189). */
export const ACCEPT_WITHIN_HOURS = 48;

/**
 * ID 189 — the stretch is add-only: "can add, never reduce". A negative
 * stretch is refused, never clamped silently.
 */
export function validateStretch(stretch: number): string | null {
    if (!Number.isFinite(stretch)) return "Enter a number.";
    if (stretch < 0) return "The stretch adds to the CEO's target; it can never reduce it.";
    return null;
}

/** @deprecated the admin add-on is the Sales Head stretch now — validateStretch. */
export const validateAddon = validateStretch;

// ── ID 189: where an edit lands (versions) ──────────────────────────────────

/** Has the member been sent this target (so a version is in force for them)? */
export function isWithMember(status: string): boolean {
    return status === "pushed" || status === "accepted" || status === "rejected";
}

/**
 * A CEO edit: on a never-posted draft it changes the draft in place; once
 * posted it is a draft REVISION (draft_ceo_target) the Sales Head does not see
 * and the posted number stays in force.
 */
export function ceoEditLands(status: string): "in_place" | "draft_revision" {
    return status === "draft" ? "in_place" : "draft_revision";
}

/**
 * A stretch edit (Sales Head / Admin): before the member has it, in place;
 * once the member has it, it waits for the next push (next_stretch), so the
 * member never sees a number change under them.
 */
export function stretchEditLands(status: string): "in_place" | "next" {
    return isWithMember(status) ? "next" : "in_place";
}

/**
 * The CEO's Post: a draft becomes posted (with the Sales Head); a revision of
 * a posted-but-not-pushed target replaces it at once (nobody has it yet); a
 * revision of a target the member has waits for the Sales Head's push.
 */
export function postLands(status: string): "first_post" | "in_place" | "next" {
    if (status === "draft") return "first_post";
    return isWithMember(status) ? "next" : "in_place";
}

/**
 * The 48-hour clock after a push: it starts at the FIRST push and a push after
 * a correction never restarts it. Only a target the member had ACCEPTED, sent
 * again as a new version, starts a fresh clock.
 */
export function clockAfterPush(prevStatus: string, firstPushedAt: string | null): "keep" | "start" {
    if (!firstPushedAt) return "start";
    return prevStatus === "accepted" ? "start" : "keep";
}

// ── ID 189: who adds and removes a target (16 Oct gap fixes) ────────────────

/**
 * A removed target keeps its row and its history (sales_target_versions) with
 * this status; every reader leaves it out. Not in TARGET_STATUSES, so no
 * filter or label offers it.
 */
export const TARGET_REMOVED_STATUS = "removed";

/**
 * Which rows a viewer sees, as statuses:
 *   ceo     everything but removed rows (his own unposted drafts included)
 *   manager posted and later — never a CEO draft
 *   member  only what was pushed to them (a posted-but-not-pushed target is
 *           still with the Sales Head)
 */
export function visibleStatuses(viewer: "ceo" | "manager" | "member"): readonly string[] {
    if (viewer === "member") return ["pushed", "accepted", "rejected"];
    if (viewer === "manager") return ["pending_approval", "pushed", "accepted", "rejected"];
    return ["draft", "pending_approval", "pushed", "accepted", "rejected"];
}

/**
 * A new person or metric is the CEO's alone: it lands as his draft and goes
 * out with his Post. The Sales Head / Admin only add a stretch to targets the
 * CEO has posted.
 */
export function mayAddTarget(role: string | null | undefined): boolean {
    return (role ?? "").toLowerCase() === "ceo";
}

/**
 * Is a target the CEO's? Yes when the CEO created or posted it, or it carries
 * a CEO number (in force, waiting or in draft). Only rows the old flow let a
 * Sales Head add on their own (CEO target 0, created and posted by them) are not.
 */
export function isCeoTarget(t: {
    createdByRole: string | null | undefined;
    postedByRole: string | null | undefined;
    ceoTarget: number;
    pendingCeoTarget?: number | null;
}): boolean {
    const ceo = (r: string | null | undefined) => (r ?? "").toLowerCase() === "ceo";
    return ceo(t.createdByRole) || ceo(t.postedByRole) || Number(t.ceoTarget) > 0 || t.pendingCeoTarget != null;
}

/** The CEO removes any target; the Sales Head / Admin only one that is not the CEO's. */
export function mayRemoveTarget(role: string | null | undefined, ceoTarget: boolean): boolean {
    const r = (role ?? "").toLowerCase();
    if (r === "ceo") return true;
    return (r === "sales_head" || r === "admin") && !ceoTarget;
}

/**
 * Who is told (bell) when a target is removed: the member only if it had been
 * pushed to them; the Sales Head once the CEO had posted it.
 */
export function removalAudience(status: string): { member: boolean; salesHead: boolean } {
    return { member: isWithMember(status), salesHead: status !== "draft" };
}

/** "per day" / "per month": how a target number reads (calls per day is a rate). */
export function targetPeriodLabel(kind: MetricKind): "per day" | "per month" {
    return kind === "per_day" ? "per day" : "per month";
}

/** "Target to date (n of N working days)". */
export function targetToDateLabel(elapsed: number, total: number): string {
    return `Target to date (${elapsed} of ${total} working day${total === 1 ? "" : "s"})`;
}

/**
 * "CEO 100 + 50 = 150" — or "CEO 100" with no stretch. `fmt` formats a number
 * the way the metric reads (₹, unit).
 */
export function targetSumLabel(ceo: number, stretch: number, fmt: (n: number) => string = String): string {
    return stretch > 0 ? `CEO ${fmt(ceo)} + ${fmt(stretch)} = ${fmt(ceo + stretch)}` : `CEO ${fmt(ceo)}`;
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
    /**
     * ID 189 — why `actual` is null, in words shown on screen next to "not
     * measured" (not only on hover). null when the actual is measured.
     */
    not_measured_reason?: string | null;
};

/** ID 189 — the reasons an actual reads "not measured" instead of a number. */
export const NOT_MEASURED = {
    kyc_disbursed: "Loans are not linked to a CRM owner yet, so this cannot be counted per person.",
    no_data: "Nothing recorded for this person in the CRM this month (no leads, calls or visits).",
    custom_not_entered: "Not entered yet — this metric's progress is typed in by hand.",
    no_working_day: "No working day of the month has passed yet.",
    unknown_metric: "The CRM has no way to count this metric.",
} as const;

/**
 * Sheet 8 §B for one target. `actual` null = the metric is not measurable in
 * the CRM yet; the row still shows its target, with no RAG, and `reason` says
 * why (ID 189).
 */
export function progress(args: {
    metric: string;
    /** A custom metric's kind (metricKind); built-in metrics read TARGET_METRICS. */
    kind?: MetricKind;
    monthly: number;
    actual: number | null;
    workingDaysTotal: number;
    workingDaysElapsed: number;
    /** Why `actual` is null (NOT_MEASURED). Ignored when actual is a number. */
    reason?: string | null;
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
        not_measured_reason: actual == null ? (args.reason ?? NOT_MEASURED.unknown_metric) : null,
    };
}

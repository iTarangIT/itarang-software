/**
 * Sales targets — data and workflow (E-303, review R-17). Rules, metric
 * vocabulary and pro-rata maths are in ./rules.ts.
 *
 * WHO MAY DO WHAT (ID 189 — Kartik 14 Oct, confirmed 16 Oct):
 *   CEO           adds people to a month, sets the CEO target (drafts nobody
 *                 else sees) and is the ONLY one who posts them to the Sales
 *                 Head ("Post to Sales Head")
 *   sales_head / admin   add an add-only STRETCH per target with an optional
 *                 note (final = CEO + stretch, no CEO re-confirmation) and push
 *                 POSTED targets to the member — never an unposted draft
 *   CEO           adds a metric (built-in or custom) — it lands as his draft —
 *                 and removes any target (16 Oct gap fix: the Sales Head /
 *                 Admin no longer create a target without a CEO post, and only
 *                 remove a row the old flow let them add themselves)
 *   CEO / sales_head / admin   enter a custom metric's progress
 *   A removal is soft: status 'removed', a 'removed' history row, and a bell
 *   to the member (if it had been pushed) and the Sales Head (if posted).
 *   the employee  accepts (optional remark) or asks for a correction (remark
 *                 required) on their own sent targets, and enters progress on
 *                 their own custom metrics. There is no reject.
 *
 * VERSIONS (E-343): ceo_target + admin_addon (the stretch) are the version IN
 * FORCE — what the member, the scorecard and the daily emails read. A CEO edit
 * after Post waits in draft_ceo_target (only the CEO sees it); his Post moves
 * it to next_ceo_target when the member already has the target; a stretch
 * change on such a target waits in next_stretch. The Sales Head's push applies
 * next_* — until then the old version stays in force. Every change is written
 * to sales_target_versions. Where an edit lands: ceoEditLands / stretchEditLands
 * / postLands / clockAfterPush in ./rules.ts (unit-tested; the SQL below
 * mirrors them).
 *
 * NOTIFICATIONS (bell + email, src/lib/notifications/emit.ts, "Targets"):
 *   targets.review_requested     CEO posts → Sales Head(s)
 *   targets.sent                 push → the member, opening their performance page
 *   targets.correction_requested member → Sales Head(s), with the remark
 *   targets.accepted             member → Sales Head(s) + CEO (bell only), with any remark
 *   (targets.rejected — the 14 Oct reject; no longer emitted)
 *
 * ACTUALS come from the Sales dashboard builder (B6 + R-10 outcome) over the
 * month so far, so a target's actual can never disagree with the dashboard,
 * plus three small queries for what the builder does not carry: scrap deals,
 * hot leads handed to ground, and calls. Where the CRM has nothing to count,
 * the actual is null with a reason in words (NOT_MEASURED), never 0.
 */
import { humanCall, transferCredit, wasHotAt } from "@/lib/reports/metricDefinitions";
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import {
    isCustomMetric,
    isCeoTarget,
    maySalesHeadAddMetric,
    isTargetMetric,
    mayAddTarget,
    mayRemoveTarget,
    metricKind,
    removalAudience,
    TARGET_REMOVED_STATUS,
    TARGET_STATUS_LABEL,
    metricsForRole,
    monthEnd,
    newCustomMetricKey,
    NOT_MEASURED,
    progress,
    TARGET_METRICS,
    validateCorrectionRemark,
    validateCustomMetric,
    validateKycPair,
    validateOptionalRemark,
    validateStretch,
    workingDaysBetween,
    type MetricKind,
    type Progress,
    type TargetMetric,
    type TargetStatus,
} from "@/lib/targets/rules";
import { emit, type EmitInput } from "@/lib/notifications/emit";
import { finalTargetSql, targetVisibleSql } from "@/lib/targets/sql";
import { ADMIN_PARTY } from "@/lib/notifications/provenance";

/**
 * Add a metric. The CEO's lands as his draft; the Sales Head's (ISR / ASM only,
 * maySalesHeadAddMetric) lands in his own queue, ready to push (ID 189, 16 Oct).
 */
export const TARGET_METRIC_ROLES = ["ceo", "sales_head"];
/** Remove a target: the CEO any; the Sales Head / Admin only one that is not the CEO's (mayRemoveTarget). */
export const TARGET_REMOVE_ROLES = ["ceo", "sales_head", "admin"];
/** Enter a custom metric's progress for someone else. */
export const TARGET_PROGRESS_ROLES = ["ceo", "sales_head", "admin"];
/** Set the CEO target number. */
export const TARGET_CEO_ROLES = ["ceo"];
/** ID 189 — post the CEO's targets to the Sales Head: the CEO only (Admin's Submit removed). */
export const TARGET_POST_ROLES = ["ceo"];
/** ID 189 — the add-only stretch on top of the CEO target. */
export const TARGET_STRETCH_ROLES = ["sales_head", "admin"];
/** @deprecated E-342's replacing Sales Head number — the stretch roles now. */
export const TARGET_SALES_HEAD_ROLES = TARGET_STRETCH_ROLES;
/** @deprecated the admin add-on IS the stretch now. */
export const TARGET_ADDON_ROLES = TARGET_STRETCH_ROLES;
/** Push posted targets to the member (the Sales Head's step). */
export const TARGET_APPROVER_ROLES = ["admin", "sales_head"];
/** Add a person to a month — the CEO only (ID 189). */
export const TARGET_ADD_PERSON_ROLES = ["ceo"];
export const TARGET_VIEW_ROLES = ["ceo", "admin", "sales_head", "business_head"];
/** Told when a member accepts. */
const TARGET_MANAGER_ROLES = ["sales_head", "ceo"];
/** Told when a member asks for a correction (ID 189: the Sales Head). */
const TARGET_CORRECTION_ROLES = ["sales_head"];

export class TargetError extends Error {}

type Actor = { id: string; role: string };
const has = (roles: string[], a: Actor) => roles.includes((a.role ?? "").toLowerCase());

/**
 * Who is looking. "ceo" sees his own unposted drafts and draft revisions;
 * "manager" (Sales Head, Admin, Business Head, every internal reader) never
 * does; "member" (the rep's own card) sees only the version in force.
 */
export type TargetViewer = "ceo" | "manager" | "member";

export function targetViewerFor(role: string | null | undefined): TargetViewer {
    return TARGET_CEO_ROLES.includes((role ?? "").toLowerCase()) ? "ceo" : "manager";
}

export type TargetRow = {
    id: string;
    month: string;
    user_id: string;
    user_name: string | null;
    user_role: string | null;
    /** A built-in TargetMetric, or 'custom_<id>' for a custom one. */
    metric: string;
    metric_label: string;
    is_custom: boolean;
    /** A custom metric's unit (free text); null for built-in metrics. */
    unit: string | null;
    kind: MetricKind;
    /** The CEO target in force. */
    ceo_target: number;
    /** ID 189 — the Sales Head's add-only stretch in force (E-343: admin_addon). */
    stretch: number;
    stretch_note: string | null;
    /** @deprecated = stretch (same column). */
    admin_addon: number;
    /** In force: ceo_target + stretch. */
    final_target: number;
    status: TargetStatus;
    /** The version in force (0 = never posted). */
    version: number;
    /** When the CEO last posted (E-341 review_requested_at). */
    posted_at: string | null;
    /** Latest push — "Target arrived on <date>". */
    pushed_at: string | null;
    /** First push — the 48-hour clock. */
    first_pushed_at: string | null;
    accepted_at: string | null;
    accept_remark: string | null;
    /** Hours since the FIRST push while unaccepted. */
    hours_since_push_unaccepted: number | null;
    /** The CEO's unposted revision — only for the CEO viewer, else null. */
    draft_ceo_target: number | null;
    /** A posted revision waiting for the push — never for the member viewer. */
    next_ceo_target: number | null;
    next_stretch: number | null;
    next_stretch_note: string | null;
    /** Posted and the Sales Head has something to push. */
    waiting_push: boolean;
    correction_requested_at: string | null;
    correction_remark: string | null;
    /** The member asked for a correction after the latest push. */
    correction_open: boolean;
    /** @deprecated the 14 Oct reject, still readable on old rows. */
    review_requested_at: string | null;
    rejected_at: string | null;
    reject_comment: string | null;
    /** ID 189 — the CEO created, posted or numbered it: only the CEO may remove it. */
    ceo_owned: boolean;
    /** Against the final target (CEO + stretch) — reps, the Sales Head, daily emails. */
    progress: Progress;
    /** Against the CEO target alone — the CEO's tiles (stretch shown apart). */
    ceo_progress: Progress;
};

/** IST today as YYYY-MM-DD, from Postgres (never the Node clock). */
async function istToday(): Promise<string> {
    const r = (await db.execute(sql`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)) as unknown as Array<{ d: string }>;
    return r[0].d;
}

async function holidays(from: string, to: string): Promise<Set<string>> {
    const r = (await db.execute(sql`
        SELECT holiday_date::text AS d FROM holiday_calendar
         WHERE is_active IS NOT FALSE AND holiday_date BETWEEN ${from}::date AND ${to}::date
    `)) as unknown as Array<{ d: string }>;
    return new Set(r.map((x) => x.d));
}

export type Measure = { value: number | null; reason: string | null };

/**
 * Month-to-date actual per (user, metric), with the reason when there is
 * none (ID 189: "not measured" and why, never a silent 0). A person with
 * nothing recorded anywhere this month reads "not measured — nothing recorded".
 */
export async function measuresFor(monthFirst: string, upTo: string, elapsedWorkingDays: number) {
    const { buildSalesDashboard } = await import("@/lib/admin/salesDashboard");
    const dash = await buildSalesDashboard({ from: monthFirst, to: upTo, granularity: "month" });
    const extra = (await db.execute(sql`
        WITH scrap AS (
            SELECT br.owner_id AS u, COUNT(DISTINCT al.request_id) AS n
              FROM buyback_activity_log al
              JOIN buyback_requests br ON br.id = al.request_id
             WHERE al.action = 'dealer_accept'
               AND (al.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${monthFirst}::date AND ${upTo}::date
               AND br.owner_id IS NOT NULL
             GROUP BY br.owner_id
        ),
        hot AS (
            -- ID 59: Hot AT THE MOMENT of transfer, not Hot now.
            -- ID 169 (Kartik, 10 Oct): a dealer handed back and transferred
            -- again counts once, as in the daily email.
            -- ID 179: credited to the owner at the moment of transfer
            -- (transferCredit), not the manager who pressed Transfer.
            SELECT ${transferCredit()} AS u, COUNT(DISTINCT t.dealer_lead_id) AS n
              FROM lead_touchpoints t
              JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
             WHERE t.touchpoint_type = 'asm_transfer'
               AND ${wasHotAt(sql`t.dealer_lead_id`, sql`t.performed_at`, sql`dl.interest_level`)}
               AND (t.performed_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${monthFirst}::date AND ${upTo}::date
               AND ${transferCredit()} IS NOT NULL
             GROUP BY 1
        ),
        calls AS (
            SELECT t.performed_by AS u, COUNT(*) AS n
              FROM lead_touchpoints t
             WHERE ${humanCall()}
               AND (t.performed_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${monthFirst}::date AND ${upTo}::date
               AND t.performed_by IS NOT NULL
             GROUP BY t.performed_by
        )
        SELECT u, 'scrap' AS k, n::text FROM scrap
        UNION ALL SELECT u, 'hot', n::text FROM hot
        UNION ALL SELECT u, 'calls', n::text FROM calls
    `)) as unknown as Array<{ u: string; k: string; n: string }>;

    const ex = new Map<string, number>();
    const seen = new Set<string>();
    for (const r of extra) {
        ex.set(`${r.u}:${r.k}`, Number(r.n));
        seen.add(r.u);
    }
    const byUser = new Map((dash.per_spoc ?? []).map((b) => [b.spoc_id, b]));
    const ok = (value: number): Measure => ({ value, reason: null });
    const none = (reason: string): Measure => ({ value: null, reason });

    return (userId: string, metric: string): Measure => {
        if (!isTargetMetric(metric)) return none(NOT_MEASURED.unknown_metric);
        if (metric === "kyc_disbursed") return none(NOT_MEASURED.kyc_disbursed);
        const b = byUser.get(userId);
        // Nothing for this person in any source: not a measured zero.
        if (!b && !seen.has(userId)) return none(NOT_MEASURED.no_data);
        switch (metric) {
            case "dealer_visits":
                // ID 59: DISTINCT dealers visited (M08) — the figure the daily
                // email puts against this target — not the number of visits.
                return ok(b?.totals.unique_visits ?? 0);
            case "new_dealer_visits":
                return ok(b?.totals.new_visits ?? 0);
            case "batteries_sold":
                return ok(b?.outcome.batteries_to_dealers ?? 0);
            case "kyc_submitted":
                return ok(b?.outcome.kyc_submitted ?? 0);
            case "revenue":
                return ok(b?.outcome.revenue ?? 0);
            case "scrap_deals":
                return ok(ex.get(`${userId}:scrap`) ?? 0);
            case "hot_to_ground":
                return ok(ex.get(`${userId}:hot`) ?? 0);
            case "calls_per_day": {
                if (elapsedWorkingDays <= 0) return none(NOT_MEASURED.no_working_day);
                const calls = ex.get(`${userId}:calls`) ?? 0;
                return ok(Math.round((calls / elapsedWorkingDays) * 10) / 10);
            }
        }
        return none(NOT_MEASURED.unknown_metric);
    };
}

/**
 * Month-to-date actual per (user, metric) as a number; null = not measurable.
 * Exported for ID 156: a manager's team actual sums the members' actuals, each
 * over the days they were in the team (src/lib/admin/teamPerformance.ts) — a
 * member with nothing recorded adds 0 there, so the team total still reads.
 */
export async function actualsFor(monthFirst: string, upTo: string, elapsedWorkingDays: number) {
    const m = await measuresFor(monthFirst, upTo, elapsedWorkingDays);
    return (userId: string, metric: string): number | null => {
        const r = m(userId, metric);
        return r.value ?? (r.reason === NOT_MEASURED.no_data ? 0 : null);
    };
}

/** A column added by E-341 / E-343, read so a DB without it returns null instead of failing. */
const j = (col: string) => sql.raw(`(to_jsonb(t) ->> '${col}')`);

export async function listTargets(opts: { month: string; userId?: string; viewer?: TargetViewer }): Promise<TargetRow[]> {
    const viewer = opts.viewer ?? "manager";
    const monthFirst = `${opts.month.slice(0, 7)}-01`;
    const last = monthEnd(monthFirst);
    const today = await istToday();
    const upTo = today < monthFirst ? monthFirst : today > last ? last : today;
    const hol = await holidays(monthFirst, last);
    const total = workingDaysBetween(monthFirst, last, hol);
    const elapsed = today < monthFirst ? 0 : workingDaysBetween(monthFirst, upTo, hol);

    const rows = (await db.execute(sql`
        SELECT t.id, t.month::text AS month, t.user_id, u.name AS user_name, u.role AS user_role,
               t.metric, t.ceo_target::float8 AS ceo_target, t.admin_addon::float8 AS stretch,
               t.status, t.pushed_at, t.accepted_at,
               ${j("custom_label")} AS custom_label,
               ${j("custom_unit")} AS custom_unit,
               ${j("manual_actual")}::float8 AS manual_actual,
               ${j("review_requested_at")} AS review_requested_at,
               ${j("rejected_at")} AS rejected_at,
               ${j("reject_comment")} AS reject_comment,
               ${j("stretch_note")} AS stretch_note,
               ${j("draft_ceo_target")}::float8 AS draft_ceo_target,
               ${j("next_ceo_target")}::float8 AS next_ceo_target,
               ${j("next_stretch")}::float8 AS next_stretch,
               ${j("next_stretch_note")} AS next_stretch_note,
               COALESCE(${j("version")}::int, CASE WHEN t.status = 'draft' THEN 0 ELSE 1 END) AS version,
               COALESCE(${j("first_pushed_at")}::timestamptz, t.pushed_at) AS first_pushed_at,
               ${j("correction_requested_at")} AS correction_requested_at,
               ${j("correction_remark")} AS correction_remark,
               ${j("accept_remark")} AS accept_remark,
               CASE WHEN t.status IN ('pushed', 'rejected')
                    THEN FLOOR(EXTRACT(EPOCH FROM (now() - COALESCE(${j("first_pushed_at")}::timestamptz, t.pushed_at))) / 3600)::int
               END AS hours_unaccepted,
               cb.role AS created_by_role, pb.role AS posted_by_role
          FROM sales_targets t
          LEFT JOIN users u ON u.id::text = t.user_id
          LEFT JOIN users cb ON cb.id::text = t.created_by
          LEFT JOIN users pb ON pb.id::text = ${j("review_requested_by")}
         WHERE t.month = ${monthFirst}::date
           ${opts.userId ? sql`AND t.user_id = ${opts.userId}` : sql``}
           -- ID 189: the CEO's unposted drafts are his alone; the member sees
           -- only what was pushed to them; a removed target is nobody's.
           AND ${targetVisibleSql(viewer)}
         ORDER BY u.name NULLS LAST, t.created_at, t.metric
    `)) as unknown as Array<Record<string, unknown>>;

    const measure = rows.length ? await measuresFor(monthFirst, upTo, elapsed) : null;
    const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
    const numOrNull = (v: unknown) => (v == null ? null : Number(v));
    return rows
        .filter((r) => isTargetMetric(String(r.metric)) || (isCustomMetric(String(r.metric)) && r.custom_label))
        .map((r) => {
            const metric = String(r.metric);
            const custom = !isTargetMetric(metric);
            const unit = custom ? ((r.custom_unit as string | null) ?? null) : null;
            const kind = metricKind(metric, unit);
            const ceo = Number(r.ceo_target);
            const stretch = Math.max(Number(r.stretch ?? 0), 0);
            // Same rule as finalTargetSql(): CEO target + stretch, the version in force.
            const finalTarget = ceo + stretch;
            const status = String(r.status) as TargetStatus;
            const m = custom
                ? r.manual_actual == null
                    ? { value: null, reason: NOT_MEASURED.custom_not_entered }
                    : { value: Number(r.manual_actual), reason: null }
                : (measure?.(String(r.user_id), metric) ?? { value: null, reason: NOT_MEASURED.unknown_metric });
            const nextCeo = viewer === "member" ? null : numOrNull(r.next_ceo_target);
            const nextStretch = viewer === "member" ? null : numOrNull(r.next_stretch);
            const pushedAt = iso(r.pushed_at);
            const correctionAt = iso(r.correction_requested_at);
            const prog = (monthly: number) =>
                progress({
                    metric,
                    kind,
                    monthly,
                    actual: m.value,
                    reason: m.reason,
                    workingDaysTotal: total,
                    workingDaysElapsed: elapsed,
                });
            return {
                id: String(r.id),
                month: String(r.month),
                user_id: String(r.user_id),
                user_name: (r.user_name as string | null) ?? null,
                user_role: (r.user_role as string | null) ?? null,
                metric,
                metric_label: custom ? String(r.custom_label) : TARGET_METRICS[metric as TargetMetric].label,
                is_custom: custom,
                unit,
                kind,
                ceo_target: ceo,
                stretch,
                stretch_note: (r.stretch_note as string | null) ?? null,
                admin_addon: stretch,
                final_target: finalTarget,
                status,
                version: Number(r.version ?? 0),
                posted_at: iso(r.review_requested_at),
                pushed_at: pushedAt,
                first_pushed_at: iso(r.first_pushed_at),
                accepted_at: iso(r.accepted_at),
                accept_remark: (r.accept_remark as string | null) ?? null,
                hours_since_push_unaccepted: r.hours_unaccepted == null ? null : Number(r.hours_unaccepted),
                draft_ceo_target: viewer === "ceo" ? numOrNull(r.draft_ceo_target) : null,
                next_ceo_target: nextCeo,
                next_stretch: nextStretch,
                next_stretch_note: viewer === "member" ? null : ((r.next_stretch_note as string | null) ?? null),
                waiting_push: status === "pending_approval" || status === "rejected" || nextCeo != null || nextStretch != null,
                correction_requested_at: correctionAt,
                correction_remark: (r.correction_remark as string | null) ?? null,
                correction_open: status === "pushed" && correctionAt != null && (pushedAt == null || correctionAt > pushedAt),
                review_requested_at: iso(r.review_requested_at),
                rejected_at: iso(r.rejected_at),
                reject_comment: (r.reject_comment as string | null) ?? null,
                ceo_owned: isCeoTarget({
                    createdByRole: r.created_by_role as string | null,
                    postedByRole: r.posted_by_role as string | null,
                    ceoTarget: ceo,
                    pendingCeoTarget: numOrNull(r.next_ceo_target) ?? numOrNull(r.draft_ceo_target),
                }),
                progress: prog(finalTarget),
                ceo_progress: prog(ceo),
            };
        });
}

export async function workingDayContext(month: string) {
    const monthFirst = `${month.slice(0, 7)}-01`;
    const last = monthEnd(monthFirst);
    const today = await istToday();
    const hol = await holidays(monthFirst, last);
    const upTo = today > last ? last : today;
    return {
        month: monthFirst,
        // A26: the last day the actuals count (today while the month runs). The
        // daily email reads the same figures to the day it covers (yesterday).
        actuals_up_to: today < monthFirst ? null : upTo,
        working_days_total: workingDaysBetween(monthFirst, last, hol),
        working_days_elapsed: today < monthFirst ? 0 : workingDaysBetween(monthFirst, upTo, hol),
    };
}

// ── History (E-343 sales_target_versions) ───────────────────────────────────

type Exec = Pick<typeof db, "execute">;

type VersionEvent = "ceo_draft" | "posted" | "stretch" | "pushed" | "accepted" | "correction_requested" | "removed";

type VersionEntry = {
    target_id: string;
    version: number;
    event: VersionEvent;
    ceo_target: number | null;
    stretch: number | null;
    old_ceo_target?: number | null;
    old_stretch?: number | null;
    note?: string | null;
};

async function logVersions(ex: Exec, entries: VersionEntry[], actor: Actor) {
    if (!entries.length) return;
    await ex.execute(sql`
        INSERT INTO sales_target_versions
            (target_id, version, event, ceo_target, stretch, old_ceo_target, old_stretch, note, changed_by)
        VALUES ${sql.join(
            entries.map(
                (e) => sql`(${e.target_id}::uuid, ${e.version}, ${e.event}, ${e.ceo_target}::numeric, ${e.stretch}::numeric,
                            ${e.old_ceo_target ?? null}::numeric, ${e.old_stretch ?? null}::numeric, ${e.note ?? null}, ${actor.id})`,
            ),
            sql`, `,
        )}
    `);
}

export type TargetVersionRow = {
    target_id: string;
    metric_label: string;
    version: number;
    event: string;
    ceo_target: number | null;
    stretch: number | null;
    old_ceo_target: number | null;
    old_stretch: number | null;
    note: string | null;
    changed_by_name: string | null;
    changed_at: string;
};

/**
 * Every recorded change to a person's targets for a month, newest first. The
 * CEO's unposted drafts ("ceo_draft") are shown to the CEO only. Empty on a DB
 * without E-343.
 */
export async function targetHistory(opts: { month: string; userId: string; viewer: TargetViewer }): Promise<TargetVersionRow[]> {
    const monthFirst = `${opts.month.slice(0, 7)}-01`;
    const ok = (await db.execute(sql`SELECT to_regclass('public.sales_target_versions') IS NOT NULL AS ok`)) as unknown as Array<{ ok: boolean }>;
    if (!ok[0]?.ok) return [];
    const r = (await db.execute(sql`
        SELECT v.target_id::text AS target_id, t.metric, to_jsonb(t) ->> 'custom_label' AS custom_label,
               v.version, v.event, v.ceo_target::float8 AS ceo_target, v.stretch::float8 AS stretch,
               v.old_ceo_target::float8 AS old_ceo_target, v.old_stretch::float8 AS old_stretch,
               v.note, COALESCE(u.name, u.email) AS changed_by_name, v.changed_at
          FROM sales_target_versions v
          JOIN sales_targets t ON t.id = v.target_id
          LEFT JOIN users u ON u.id::text = v.changed_by
         WHERE t.month = ${monthFirst}::date AND t.user_id = ${opts.userId}
           -- A removed target's history is kept and shown; one removed before
           -- it was ever posted (version 0) stays the CEO's alone.
           ${opts.viewer === "ceo"
               ? sql``
               : sql`AND v.event <> 'ceo_draft' AND t.status <> 'draft'
                     AND NOT (t.status = ${TARGET_REMOVED_STATUS} AND t.version = 0)`}
         ORDER BY v.changed_at DESC
         LIMIT 300
    `)) as unknown as Array<Record<string, unknown>>;
    const n = (v: unknown) => (v == null ? null : Number(v));
    return r.map((x) => ({
        target_id: String(x.target_id),
        metric_label: isTargetMetric(String(x.metric))
            ? TARGET_METRICS[String(x.metric) as TargetMetric].label
            : String(x.custom_label ?? x.metric),
        version: Number(x.version ?? 0),
        event: String(x.event),
        ceo_target: n(x.ceo_target),
        stretch: n(x.stretch),
        old_ceo_target: n(x.old_ceo_target),
        old_stretch: n(x.old_stretch),
        note: (x.note as string | null) ?? null,
        changed_by_name: (x.changed_by_name as string | null) ?? null,
        changed_at: new Date(x.changed_at as string).toISOString(),
    }));
}

/**
 * ON CONFLICT clause that brings a REMOVED row back as a fresh CEO draft (the
 * unique (month, user, metric) index keeps the removed row). Same id, so its
 * history continues; everything about the old version is cleared, including
 * the 48-hour clock. A live row is left alone (DO UPDATE ... WHERE no-ops).
 */
function reviveRemoved(ceoTarget: number, actor: Actor): SQL {
    return sql`
        ON CONFLICT (month, user_id, metric) DO UPDATE
           SET status = 'draft', ceo_target = ${ceoTarget}::numeric, admin_addon = 0, stretch_note = NULL,
               stretch_by = NULL, stretch_at = NULL,
               draft_ceo_target = NULL, next_ceo_target = NULL, next_stretch = NULL, next_stretch_note = NULL,
               review_requested_at = NULL, review_requested_by = NULL,
               approved_by = NULL, approved_at = NULL, pushed_at = NULL, first_pushed_at = NULL,
               accepted_at = NULL, accept_remark = NULL, reminded_at = NULL,
               correction_requested_at = NULL, correction_requested_by = NULL, correction_remark = NULL,
               rejected_at = NULL, rejected_by = NULL, reject_comment = NULL,
               created_by = ${actor.id}, updated_by = ${actor.id}, updated_at = now()
         WHERE sales_targets.status = ${TARGET_REMOVED_STATUS}`;
}

/**
 * ID 189 (16 Oct): a metric the Sales Head adds for an ISR / ASM. No CEO
 * number (0); the Sales Head's number is the stretch, so final = 0 + number.
 * It lands with the Sales Head ('pending_approval'), ready to push like a
 * posted target, and is not the CEO's (isCeoTarget false) — the Sales Head
 * may change or remove it. A metric removed earlier this month comes back
 * this way too. One history row records who added it.
 */
async function addSalesHeadMetric(
    input: { userId: string; metric?: string; custom?: { label: string; unit?: string | null } },
    target: number,
    monthFirst: string,
    actor: Actor,
) {
    const note = "Added by the Sales Head";
    let metric: string;
    let label: string;
    if (input.custom) {
        const bad = validateCustomMetric(input.custom.label, input.custom.unit);
        if (bad) throw new TargetError(bad);
        metric = newCustomMetricKey();
        label = input.custom.label.trim();
    } else {
        if (!input.metric || !isTargetMetric(input.metric)) throw new TargetError("Pick a metric.");
        metric = input.metric;
        label = TARGET_METRICS[input.metric].label;
    }
    const r = (await db.execute(sql`
        INSERT INTO sales_targets (month, user_id, metric, ceo_target, admin_addon, stretch_note, stretch_by, stretch_at,
                                   status, version, review_requested_at, review_requested_by,
                                   custom_label, custom_unit, created_by, updated_by)
        VALUES (${monthFirst}::date, ${input.userId}, ${metric}, 0, ${target}, ${note}, ${actor.id}, now(),
                'pending_approval', 1, now(), ${actor.id},
                ${input.custom ? input.custom.label.trim() : null}, ${input.custom ? (input.custom.unit ?? "").trim() || null : null},
                ${actor.id}, ${actor.id})
        ON CONFLICT (month, user_id, metric) DO UPDATE
           SET status = 'pending_approval', ceo_target = 0, admin_addon = ${target}::numeric, stretch_note = ${note},
               stretch_by = ${actor.id}, stretch_at = now(),
               draft_ceo_target = NULL, next_ceo_target = NULL, next_stretch = NULL, next_stretch_note = NULL,
               review_requested_at = now(), review_requested_by = ${actor.id},
               approved_by = NULL, approved_at = NULL, pushed_at = NULL, first_pushed_at = NULL,
               accepted_at = NULL, accept_remark = NULL, reminded_at = NULL,
               correction_requested_at = NULL, correction_requested_by = NULL, correction_remark = NULL,
               rejected_at = NULL, rejected_by = NULL, reject_comment = NULL,
               version = sales_targets.version + 1,
               created_by = ${actor.id}, updated_by = ${actor.id}, updated_at = now()
         WHERE sales_targets.status = ${TARGET_REMOVED_STATUS}
        RETURNING id::text AS id, version
    `)) as unknown as Array<{ id: string; version: number }>;
    if (!r.length) throw new TargetError(`${label} is already a target for this person this month.`);
    await logVersions(db, [{ target_id: r[0].id, version: r[0].version, event: "stretch", ceo_target: 0, stretch: target, note }], actor);
    return { id: r[0].id };
}

/**
 * Add a person to a month: one draft row per metric their role carries. CEO
 * only (ID 189). A metric removed earlier this month comes back as a draft.
 */
export async function addPersonToMonth(month: string, userId: string, actor: Actor) {
    if (!has(TARGET_ADD_PERSON_ROLES, actor)) throw new TargetError("Only the CEO adds people to a month's targets.");
    const u = (await db.execute(sql`
        SELECT role FROM users WHERE id::text = ${userId} AND is_active = TRUE
    `)) as unknown as Array<{ role: string }>;
    if (!u.length) throw new TargetError("That person does not exist or is inactive.");
    const metrics = metricsForRole(u[0].role);
    if (!metrics.length) throw new TargetError(`No target metrics are defined for the ${u[0].role} role.`);
    const monthFirst = `${month.slice(0, 7)}-01`;
    for (const m of metrics) {
        const r = (await db.execute(sql`
            INSERT INTO sales_targets (month, user_id, metric, created_by, updated_by)
            VALUES (${monthFirst}::date, ${userId}, ${m}, ${actor.id}, ${actor.id})
            ${reviveRemoved(0, actor)}
            RETURNING id::text AS id, version, (xmax::text <> '0') AS revived
        `)) as unknown as Array<{ id: string; version: number; revived: boolean }>;
        if (r[0]?.revived) {
            await logVersions(db, [{ target_id: r[0].id, version: r[0].version, event: "ceo_draft", ceo_target: 0, stretch: 0, note: "Added again after it was removed" }], actor);
        }
    }
    return { added: metrics.length };
}

/**
 * Edit a target's numbers (ID 189).
 *   ceo_target (CEO): a never-posted draft changes in place; once posted it is
 *     a draft revision (draft_ceo_target) only the CEO sees — the posted number
 *     stays in force until he posts the revision and the Sales Head pushes it.
 *   stretch (+ optional note; Sales Head / Admin): add-only, ≥ 0. Before the
 *     member has the target it changes in place; after, it waits for the next
 *     push (next_stretch). A stretch on an unposted draft is refused.
 * Nothing is sent back for re-approval and no clock restarts.
 */
export async function updateTarget(
    id: string,
    patch: { ceo_target?: number; stretch?: number; stretch_note?: string | null; admin_addon?: number; sales_head_target?: number | null },
    actor: Actor,
) {
    if (patch.sales_head_target !== undefined) {
        throw new TargetError("The Sales Head target is replaced by the stretch: add on top of the CEO's target instead.");
    }
    const stretch = patch.stretch ?? patch.admin_addon;
    if (patch.ceo_target !== undefined) {
        if (!has(TARGET_CEO_ROLES, actor)) throw new TargetError("Only the CEO sets the CEO target.");
        if (!Number.isFinite(patch.ceo_target) || patch.ceo_target < 0) throw new TargetError("The target must be zero or more.");
    }
    if (stretch !== undefined) {
        if (!has(TARGET_STRETCH_ROLES, actor)) throw new TargetError("Only the Sales Head or an admin sets the stretch.");
        const bad = validateStretch(stretch);
        if (bad) throw new TargetError(bad);
    }
    const note = patch.stretch_note == null ? null : patch.stretch_note.trim() || null;
    const badNote = validateOptionalRemark(note);
    if (badNote) throw new TargetError(badNote);

    await db.transaction(async (tx) => {
        const cur = (await tx.execute(sql`
            SELECT user_id, month::text AS month, status, version,
                   ceo_target::float8 AS ceo, admin_addon::float8 AS stretch,
                   draft_ceo_target::float8 AS draft, next_ceo_target::float8 AS next_ceo,
                   next_stretch::float8 AS next_stretch, stretch_note
              FROM sales_targets WHERE id = ${id}::uuid FOR UPDATE
        `)) as unknown as Array<{
            user_id: string; month: string; status: string; version: number; ceo: number; stretch: number;
            draft: number | null; next_ceo: number | null; next_stretch: number | null; stretch_note: string | null;
        }>;
        if (!cur.length || cur[0].status === TARGET_REMOVED_STATUS) throw new TargetError("Target not found.");
        const c = cur[0];
        const withMember = c.status === "pushed" || c.status === "accepted" || c.status === "rejected";
        const log: VersionEntry[] = [];

        if (patch.ceo_target !== undefined) {
            const v = patch.ceo_target;
            if (c.status === "draft") {
                // ceoEditLands('draft') = in place.
                if (v !== Number(c.ceo)) {
                    await tx.execute(sql`
                        UPDATE sales_targets SET ceo_target = ${v}::numeric, updated_by = ${actor.id}, updated_at = now()
                         WHERE id = ${id}::uuid
                    `);
                    log.push({ target_id: id, version: c.version, event: "ceo_draft", ceo_target: v, stretch: c.stretch, old_ceo_target: Number(c.ceo) });
                }
            } else {
                // ceoEditLands(posted) = a draft revision; back to the posted number = no revision.
                const posted = c.next_ceo ?? Number(c.ceo);
                const was = c.draft ?? posted;
                if (v !== was) {
                    await tx.execute(sql`
                        UPDATE sales_targets
                           SET draft_ceo_target = ${v === posted ? null : v}::numeric, updated_by = ${actor.id}, updated_at = now()
                         WHERE id = ${id}::uuid
                    `);
                    log.push({ target_id: id, version: c.version, event: "ceo_draft", ceo_target: v, stretch: c.next_stretch ?? c.stretch, old_ceo_target: was, note: "Draft revision — not posted yet" });
                }
            }
        }

        if (stretch !== undefined) {
            if (c.status === "draft") throw new TargetError("The CEO has not posted this target yet.");
            if (!withMember) {
                // stretchEditLands(posted, not sent) = in place.
                await tx.execute(sql`
                    UPDATE sales_targets
                       SET admin_addon = ${stretch}::numeric,
                           ${patch.stretch_note === undefined ? sql`` : sql`stretch_note = ${note},`}
                           stretch_by = ${actor.id}, stretch_at = now(), updated_by = ${actor.id}, updated_at = now()
                     WHERE id = ${id}::uuid
                `);
            } else {
                // stretchEditLands(with member) = waits for the next push.
                const same = stretch === Number(c.stretch) && (patch.stretch_note === undefined || note === c.stretch_note);
                await tx.execute(sql`
                    UPDATE sales_targets
                       SET next_stretch = ${same ? null : stretch}::numeric,
                           next_stretch_note = ${same ? null : patch.stretch_note === undefined ? c.stretch_note : note},
                           stretch_by = ${actor.id}, stretch_at = now(), updated_by = ${actor.id}, updated_at = now()
                     WHERE id = ${id}::uuid
                `);
            }
            log.push({
                target_id: id,
                version: c.version,
                event: "stretch",
                ceo_target: c.next_ceo ?? Number(c.ceo),
                stretch,
                old_stretch: c.next_stretch ?? Number(c.stretch),
                note: [note, withMember ? "Waits for the next push" : null].filter(Boolean).join(" · ") || null,
            });
        }

        // #15 — KYC disbursed ≤ KYC submitted, on the newest numbers.
        const kyc = (await tx.execute(sql`
            SELECT metric,
                   (COALESCE(draft_ceo_target, next_ceo_target, ceo_target) + COALESCE(next_stretch, admin_addon))::float8 AS f
              FROM sales_targets
             WHERE user_id = ${c.user_id} AND month = ${c.month}::date
               AND metric IN ('kyc_submitted', 'kyc_disbursed')
               AND status <> ${TARGET_REMOVED_STATUS}
        `)) as unknown as Array<{ metric: string; f: number }>;
        const sub = kyc.find((k) => k.metric === "kyc_submitted")?.f ?? null;
        const dis = kyc.find((k) => k.metric === "kyc_disbursed")?.f ?? null;
        const bad = validateKycPair(sub, dis);
        if (bad) throw new TargetError(bad);
        await logVersions(tx, log, actor);
    });
}

// ── Workflow: CEO posts → Sales Head stretch + push → member accepts ────────

const idList = (ids: string[]) => sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);

type Changed = { id: string; user_id: string; month: string };

/** "October 2026" for a month's first day. */
function monthName(monthFirst: string): string {
    const [y, m] = monthFirst.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** Where a member reads and accepts their targets. */
function performanceHrefFor(role: string | null | undefined): string {
    return (role ?? "").toLowerCase() === "asm" ? "/asm/performance" : "/inside-sales/performance";
}

const registerHref = (monthFirst: string) => `/admin/targets?month=${monthFirst.slice(0, 7)}`;

async function namesOf(userIds: string[]): Promise<Map<string, { name: string; role: string | null }>> {
    const list = [...new Set(userIds)];
    if (!list.length) return new Map();
    const r = (await db.execute(sql`
        SELECT id::text AS id, COALESCE(name, email) AS name, role FROM users
         WHERE id::text IN (${sql.join(list.map((i) => sql`${i}`), sql`, `)})
    `)) as unknown as Array<{ id: string; name: string | null; role: string | null }>;
    return new Map(r.map((x) => [x.id, { name: x.name ?? "Someone", role: x.role }]));
}

/** Group changed rows by (person, month) — one notice per person per month. */
function byPersonMonth(rows: Changed[]): Array<{ user_id: string; month: string; count: number }> {
    const m = new Map<string, { user_id: string; month: string; count: number }>();
    for (const r of rows) {
        const k = `${r.user_id}|${r.month}`;
        const e = m.get(k) ?? { user_id: r.user_id, month: r.month, count: 0 };
        e.count++;
        m.set(k, e);
    }
    return [...m.values()];
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

async function labelsOf(ids: string[]): Promise<string> {
    if (!ids.length) return "";
    const labels = (await db.execute(sql`
        SELECT metric, to_jsonb(t) ->> 'custom_label' AS custom_label FROM sales_targets t
         WHERE id IN (${idList(ids)})
    `)) as unknown as Array<{ metric: string; custom_label: string | null }>;
    return labels.map((l) => (isTargetMetric(l.metric) ? TARGET_METRICS[l.metric].label : (l.custom_label ?? l.metric))).join(", ");
}

/**
 * CEO only: "Post to Sales Head" (ID 189). A draft becomes posted; a draft
 * revision of a posted-not-sent target replaces it at once; a revision of a
 * target the member already has waits for the Sales Head's push (postLands).
 * The Sales Head(s) get a bell and an email.
 */
export async function postTargets(ids: string[], actor: Actor) {
    if (!has(TARGET_POST_ROLES, actor)) throw new TargetError("Only the CEO posts targets to the Sales Head.");
    if (!ids.length) return { changed: 0 };
    const rows = (await db.execute(sql`
        WITH old AS (
            SELECT id, status AS old_status, draft_ceo_target AS old_draft
              FROM sales_targets
             WHERE id IN (${idList(ids)}) AND (status = 'draft' OR draft_ceo_target IS NOT NULL)
               AND status <> ${TARGET_REMOVED_STATUS}
             FOR UPDATE
        )
        UPDATE sales_targets t
           SET status = CASE WHEN old.old_status = 'draft' THEN 'pending_approval' ELSE t.status END,
               ceo_target = CASE WHEN old.old_status = 'pending_approval' AND old.old_draft IS NOT NULL
                                 THEN old.old_draft ELSE t.ceo_target END,
               next_ceo_target = CASE WHEN old.old_status IN ('pushed', 'accepted', 'rejected') AND old.old_draft IS NOT NULL
                                      THEN old.old_draft ELSE t.next_ceo_target END,
               draft_ceo_target = NULL,
               version = t.version + CASE WHEN old.old_status IN ('draft', 'pending_approval') THEN 1 ELSE 0 END,
               review_requested_at = now(), review_requested_by = ${actor.id},
               updated_by = ${actor.id}, updated_at = now()
          FROM old
         WHERE t.id = old.id
        RETURNING t.id::text AS id, t.user_id, t.month::text AS month, old.old_status,
                  t.version, t.ceo_target::float8 AS ceo, t.admin_addon::float8 AS stretch,
                  t.next_ceo_target::float8 AS next_ceo
    `)) as unknown as Array<Changed & { old_status: string; version: number; ceo: number; stretch: number; next_ceo: number | null }>;
    if (rows.length) {
        await logVersions(
            db,
            rows.map((r) => ({
                target_id: r.id,
                version: r.next_ceo != null ? r.version + 1 : r.version,
                event: "posted" as const,
                ceo_target: r.next_ceo ?? r.ceo,
                stretch: r.stretch,
                note: r.old_status === "draft" ? null : r.next_ceo != null ? "Revision — waits for the Sales Head's push" : "Revision",
            })),
            actor,
        );
        const groups = byPersonMonth(rows);
        const revisions = rows.filter((r) => r.old_status !== "draft").length;
        const names = await namesOf([actor.id, ...groups.map((g) => g.user_id)]);
        const who = groups.map((g) => `${names.get(g.user_id)?.name ?? "a member"} (${plural(g.count, "target")})`).join(", ");
        await emit({
            type: "targets.review_requested",
            title: revisions === rows.length ? "Target changes posted to you" : "Targets posted to you",
            message:
                `${names.get(actor.id)?.name ?? "The CEO"} posted ${monthName(groups[0].month)} targets for ${who}` +
                `${revisions ? ` (${plural(revisions, "change")} to targets already posted)` : ""}. ` +
                `Add a stretch if you want to, then approve and push them to the team.`,
            from: ADMIN_PARTY,
            emailSubject: `${monthName(groups[0].month)} targets posted — please review and push`,
            data: { ids: rows.map((r) => r.id) },
            to: [{ audience: { kind: "roles", roles: ["sales_head"] }, as: ADMIN_PARTY, href: registerHref(groups[0].month) }],
        });
    }
    return { changed: rows.length };
}

/** @deprecated the 14 Oct "Send to Sales Head" — postTargets (CEO only now). */
export const sendForReview = postTargets;

/**
 * Sales Head / admin: "Approve & push" POSTED targets to the member — never an
 * unposted draft. Applies any waiting revision (next_*) so the new version is
 * in force from now. The 48-hour clock starts at the FIRST push and is not
 * restarted (clockAfterPush) unless the member had accepted the old version.
 * The member gets a bell and an email.
 */
export async function sendToMember(ids: string[], actor: Actor) {
    if (!has(TARGET_APPROVER_ROLES, actor)) throw new TargetError("Only the Sales Head or an admin pushes targets to the member.");
    if (!ids.length) return { changed: 0 };
    const rows = (await db.execute(sql`
        WITH old AS (
            SELECT id, status AS old_status, ceo_target AS old_ceo, admin_addon AS old_stretch,
                   (next_ceo_target IS NOT NULL OR next_stretch IS NOT NULL) AS has_next
              FROM sales_targets
             WHERE id IN (${idList(ids)})
               AND (status IN ('pending_approval', 'rejected')
                    OR (status IN ('pushed', 'accepted') AND (next_ceo_target IS NOT NULL OR next_stretch IS NOT NULL)))
             FOR UPDATE
        )
        UPDATE sales_targets t
           SET ceo_target = COALESCE(t.next_ceo_target, t.ceo_target),
               admin_addon = COALESCE(t.next_stretch, t.admin_addon),
               stretch_note = CASE WHEN t.next_stretch IS NOT NULL THEN t.next_stretch_note ELSE t.stretch_note END,
               version = t.version + CASE WHEN old.has_next THEN 1 ELSE 0 END,
               next_ceo_target = NULL, next_stretch = NULL, next_stretch_note = NULL,
               status = 'pushed', approved_by = ${actor.id}, approved_at = now(), pushed_at = now(),
               first_pushed_at = CASE WHEN t.first_pushed_at IS NULL OR old.old_status = 'accepted'
                                      THEN now() ELSE t.first_pushed_at END,
               accepted_at = NULL, reminded_at = NULL,
               updated_by = ${actor.id}, updated_at = now()
          FROM old
         WHERE t.id = old.id
        RETURNING t.id::text AS id, t.user_id, t.month::text AS month, t.version,
                  t.ceo_target::float8 AS ceo, t.admin_addon::float8 AS stretch, t.stretch_note,
                  old.old_ceo::float8 AS old_ceo, old.old_stretch::float8 AS old_stretch, old.old_status
    `)) as unknown as Array<
        Changed & { version: number; ceo: number; stretch: number; stretch_note: string | null; old_ceo: number; old_stretch: number; old_status: string }
    >;
    if (rows.length) {
        await logVersions(
            db,
            rows.map((r) => ({
                target_id: r.id,
                version: r.version,
                event: "pushed" as const,
                ceo_target: r.ceo,
                stretch: r.stretch,
                old_ceo_target: r.old_status === "pending_approval" ? null : r.old_ceo,
                old_stretch: r.old_status === "pending_approval" ? null : r.old_stretch,
                note: r.stretch_note,
            })),
            actor,
        );
    }
    const groups = byPersonMonth(rows);
    const names = await namesOf([actor.id, ...groups.map((g) => g.user_id)]);
    for (const g of groups) {
        const member = names.get(g.user_id);
        await emit({
            type: "targets.sent",
            title: `Your ${monthName(g.month)} targets`,
            message: `${names.get(actor.id)?.name ?? "The Sales Head"} sent you ${plural(g.count, "target")} for ${monthName(g.month)}. Open My Performance to accept them, or ask for a correction.`,
            from: ADMIN_PARTY,
            emailSubject: `Please review your ${monthName(g.month)} targets`,
            data: { month: g.month },
            to: [{ audience: { kind: "user", userId: g.user_id }, as: ADMIN_PARTY, href: performanceHrefFor(member?.role) }],
        });
    }
    return { changed: rows.length };
}

/** @deprecated name kept for older callers — postTargets. */
export const submitTargets = postTargets;
/** @deprecated name kept for older callers — sendToMember. */
export const approveAndPush = sendToMember;

/** Sent → accepted, by the person the targets belong to — and nobody else. Optional remark (ID 189). */
export async function acceptTargets(ids: string[], actor: Actor, remark?: string | null) {
    const text = (remark ?? "").trim() || null;
    const bad = validateOptionalRemark(text);
    if (bad) throw new TargetError(bad);
    if (!ids.length) return { changed: 0 };
    const rows = (await db.execute(sql`
        UPDATE sales_targets SET status = 'accepted', accepted_at = now(), accept_remark = ${text}, updated_at = now()
         WHERE id IN (${idList(ids)})
           AND status = 'pushed' AND user_id = ${actor.id}
        RETURNING id::text AS id, user_id, month::text AS month, version,
                  ceo_target::float8 AS ceo, admin_addon::float8 AS stretch
    `)) as unknown as Array<Changed & { version: number; ceo: number; stretch: number }>;
    if (rows.length) {
        await logVersions(
            db,
            rows.map((r) => ({ target_id: r.id, version: r.version, event: "accepted" as const, ceo_target: r.ceo, stretch: r.stretch, note: text })),
            actor,
        );
        const names = await namesOf([actor.id]);
        const month = rows[0].month;
        await emit({
            type: "targets.accepted",
            title: "Targets accepted",
            message:
                `${names.get(actor.id)?.name ?? "A member"} accepted ${plural(rows.length, "target")} for ${monthName(month)}` +
                (text ? `: "${text}"` : "."),
            from: ADMIN_PARTY,
            email: false,
            to: [{ audience: { kind: "roles", roles: TARGET_MANAGER_ROLES }, as: ADMIN_PARTY, href: registerHref(month) }],
        });
    }
    return { changed: rows.length };
}

/**
 * ID 189 — the member asks for a correction with a required remark, instead of
 * rejecting. The target stays sent ("pushed"): the 48-hour clock keeps running
 * from the first push, and it stays in force until the Sales Head pushes a
 * corrected version. The Sales Head(s) get a bell and an email with the remark.
 */
export async function askForCorrection(ids: string[], remark: string, actor: Actor) {
    const bad = validateCorrectionRemark(remark);
    if (bad) throw new TargetError(bad);
    if (!ids.length) return { changed: 0 };
    const text = remark.trim();
    const rows = (await db.execute(sql`
        UPDATE sales_targets
           SET correction_requested_at = now(), correction_requested_by = ${actor.id}, correction_remark = ${text},
               updated_at = now()
         WHERE id IN (${idList(ids)})
           AND status = 'pushed' AND user_id = ${actor.id}
        RETURNING id::text AS id, user_id, month::text AS month, version,
                  ceo_target::float8 AS ceo, admin_addon::float8 AS stretch
    `)) as unknown as Array<Changed & { version: number; ceo: number; stretch: number }>;
    if (rows.length) {
        await logVersions(
            db,
            rows.map((r) => ({ target_id: r.id, version: r.version, event: "correction_requested" as const, ceo_target: r.ceo, stretch: r.stretch, note: text })),
            actor,
        );
        const names = await namesOf([actor.id]);
        const month = rows[0].month;
        const what = await labelsOf(rows.map((r) => r.id));
        await emit({
            type: "targets.correction_requested",
            title: "Correction asked on targets",
            message: `${names.get(actor.id)?.name ?? "A member"} asked for a correction on ${plural(rows.length, "target")} for ${monthName(month)} (${what}): "${text}"`,
            from: ADMIN_PARTY,
            emailSubject: `${names.get(actor.id)?.name ?? "A member"} asked for a correction on ${monthName(month)} targets`,
            data: { ids: rows.map((r) => r.id), remark: text },
            to: [{ audience: { kind: "roles", roles: TARGET_CORRECTION_ROLES }, as: ADMIN_PARTY, href: registerHref(month) }],
        });
    }
    return { changed: rows.length };
}

/** @deprecated the 14 Oct reject — there is no reject now; it asks for a correction. */
export const rejectTargets = (ids: string[], comment: string, actor: Actor) => askForCorrection(ids, comment, actor);

// ── Metrics: add one (built-in or custom), remove one ───────────────────────

/**
 * Add one metric to a person's month — a built-in metric (any, not only the
 * role's defaults) or a custom one. CEO only (ID 189, 16 Oct): it lands as his
 * draft and goes out with his Post. The Sales Head / Admin cannot create a
 * target; they add a stretch to one the CEO has posted. A built-in metric
 * removed earlier this month comes back as a fresh draft.
 */
export async function addMetric(
    input: { month: string; userId: string; metric?: string; custom?: { label: string; unit?: string | null }; target?: number },
    actor: Actor,
) {
    if (!has(TARGET_METRIC_ROLES, actor)) {
        throw new TargetError("Only the CEO or the Sales Head adds a metric.");
    }
    const u = (await db.execute(sql`
        SELECT role FROM users WHERE id::text = ${input.userId} AND is_active = TRUE
    `)) as unknown as Array<{ role: string | null }>;
    if (!u.length) throw new TargetError("That person does not exist or is inactive.");
    const target = input.target ?? 0;
    if (!Number.isFinite(target) || target < 0) throw new TargetError("The target must be zero or more.");
    const monthFirst = `${input.month.slice(0, 7)}-01`;

    // ID 189 (16 Oct): the Sales Head's own metric — ISR / ASM only.
    if (!mayAddTarget(actor.role)) {
        if (!maySalesHeadAddMetric(actor.role, u[0].role)) {
            throw new TargetError("The Sales Head adds metrics only for an inside sales rep or an ASM.");
        }
        return addSalesHeadMetric(input, target, monthFirst, actor);
    }

    if (input.custom) {
        const bad = validateCustomMetric(input.custom.label, input.custom.unit);
        if (bad) throw new TargetError(bad);
        const r = (await db.execute(sql`
            INSERT INTO sales_targets (month, user_id, metric, ceo_target, status, version,
                                       custom_label, custom_unit, created_by, updated_by)
            VALUES (${monthFirst}::date, ${input.userId}, ${newCustomMetricKey()}, ${target}, 'draft', 0,
                    ${input.custom.label.trim()}, ${(input.custom.unit ?? "").trim() || null}, ${actor.id}, ${actor.id})
            RETURNING id::text AS id
        `)) as unknown as Array<{ id: string }>;
        return { id: r[0].id };
    }
    if (!input.metric || !isTargetMetric(input.metric)) throw new TargetError("Pick a metric.");
    const r = (await db.execute(sql`
        INSERT INTO sales_targets (month, user_id, metric, ceo_target, status, version, created_by, updated_by)
        VALUES (${monthFirst}::date, ${input.userId}, ${input.metric}, ${target}, 'draft', 0, ${actor.id}, ${actor.id})
        ${reviveRemoved(target, actor)}
        RETURNING id::text AS id, version, (xmax::text <> '0') AS revived
    `)) as unknown as Array<{ id: string; version: number; revived: boolean }>;
    if (!r.length) throw new TargetError(`${TARGET_METRICS[input.metric].label} is already a target for this person this month.`);
    if (r[0].revived) {
        await logVersions(db, [{ target_id: r[0].id, version: r[0].version, event: "ceo_draft", ceo_target: target, stretch: 0, note: "Added again after it was removed" }], actor);
    }
    return { id: r[0].id };
}

/**
 * Remove one target (ID 189, 16 Oct). The CEO removes any; the Sales Head /
 * Admin only a row that is not the CEO's (isCeoTarget — in practice the ones
 * the old flow let them add on their own). Soft: the row stays with status
 * 'removed' and its history, a 'removed' version row is written, and every
 * reader leaves it out. The member is told by bell if it had been pushed to
 * them, and the Sales Head(s) if the CEO had posted it.
 */
export async function removeTarget(id: string, actor: Actor) {
    if (!has(TARGET_REMOVE_ROLES, actor)) throw new TargetError("Only the CEO removes a target.");
    const removed = await db.transaction(async (tx) => {
        const cur = (await tx.execute(sql`
            SELECT t.user_id, t.month::text AS month, t.status, t.version,
                   t.ceo_target::float8 AS ceo, t.admin_addon::float8 AS stretch,
                   t.next_ceo_target::float8 AS next_ceo, t.draft_ceo_target::float8 AS draft,
                   cb.role AS created_by_role, pb.role AS posted_by_role
              FROM sales_targets t
              LEFT JOIN users cb ON cb.id::text = t.created_by
              LEFT JOIN users pb ON pb.id::text = t.review_requested_by
             WHERE t.id = ${id}::uuid
             FOR UPDATE OF t
        `)) as unknown as Array<{
            user_id: string; month: string; status: string; version: number; ceo: number; stretch: number;
            next_ceo: number | null; draft: number | null; created_by_role: string | null; posted_by_role: string | null;
        }>;
        const c = cur[0];
        // Someone else's unposted CEO draft is as good as not there.
        if (!c || c.status === TARGET_REMOVED_STATUS || (c.status === "draft" && !has(TARGET_CEO_ROLES, actor))) {
            throw new TargetError("Target not found.");
        }
        const ceoOwned = isCeoTarget({
            createdByRole: c.created_by_role,
            postedByRole: c.posted_by_role,
            ceoTarget: Number(c.ceo),
            pendingCeoTarget: c.next_ceo ?? c.draft,
        });
        if (!mayRemoveTarget(actor.role, ceoOwned)) {
            throw new TargetError("Only the CEO removes a target he has set. Ask the CEO, or change the stretch instead.");
        }
        await tx.execute(sql`
            UPDATE sales_targets
               SET status = ${TARGET_REMOVED_STATUS},
                   draft_ceo_target = NULL, next_ceo_target = NULL, next_stretch = NULL, next_stretch_note = NULL,
                   updated_by = ${actor.id}, updated_at = now()
             WHERE id = ${id}::uuid
        `);
        await logVersions(
            tx,
            [
                {
                    target_id: id,
                    version: c.version,
                    event: "removed",
                    ceo_target: Number(c.ceo),
                    stretch: Number(c.stretch),
                    note: `Removed — was ${TARGET_STATUS_LABEL[c.status as TargetStatus] ?? c.status}`,
                },
            ],
            actor,
        );
        return c;
    });

    const tell = removalAudience(removed.status);
    if (tell.member || tell.salesHead) {
        const what = await labelsOf([id]);
        const names = await namesOf([actor.id, removed.user_id]);
        const member = names.get(removed.user_id);
        const to: EmitInput["to"] = [];
        if (tell.member) {
            to.push({ audience: { kind: "user", userId: removed.user_id }, as: ADMIN_PARTY, href: performanceHrefFor(member?.role) });
        }
        if (tell.salesHead) {
            to.push({ audience: { kind: "roles", roles: ["sales_head"] }, as: ADMIN_PARTY, href: registerHref(removed.month) });
        }
        await emit({
            type: "targets.removed",
            title: "A target was removed",
            message:
                `${names.get(actor.id)?.name ?? "The CEO"} removed the ${what} target for ${member?.name ?? "a member"} ` +
                `for ${monthName(removed.month)}. It no longer counts.`,
            from: ADMIN_PARTY,
            email: false,
            data: { id, month: removed.month },
            to,
        });
    }
    return { removed: 1 };
}

/**
 * A custom metric's progress, entered by hand — by the member on their own
 * target, or by the CEO / Sales Head / admin. Built-in metrics are measured.
 */
export async function setManualActual(id: string, value: number | null, actor: Actor) {
    if (value != null && (!Number.isFinite(value) || value < 0)) throw new TargetError("Progress must be zero or more.");
    const cur = (await db.execute(sql`
        SELECT user_id, metric, status FROM sales_targets WHERE id = ${id}::uuid
    `)) as unknown as Array<{ user_id: string; metric: string; status: string }>;
    if (!cur.length || cur[0].status === TARGET_REMOVED_STATUS) throw new TargetError("Target not found.");
    if (!isCustomMetric(cur[0].metric)) throw new TargetError("Only a custom metric's progress is entered by hand.");
    if (cur[0].user_id !== actor.id && !has(TARGET_PROGRESS_ROLES, actor)) {
        throw new TargetError("You can only update your own targets.");
    }
    await db.execute(sql`
        UPDATE sales_targets
           SET manual_actual = ${value}, manual_actual_at = now(), manual_actual_by = ${actor.id}, updated_at = now()
         WHERE id = ${id}::uuid
    `);
    return { ok: true };
}

/**
 * Sent targets not accepted within 48 h of the FIRST push — for the
 * targets_pending digest (ID 189: a correction does not stop or restart the
 * clock; an old-flow reject that was never pushed again stays listed).
 */
export async function overdueAcceptance(): Promise<
    Array<{ user_name: string | null; month: string; targets: number; hours: number; corrections: number }>
> {
    const since: SQL = sql`COALESCE(${j("first_pushed_at")}::timestamptz, t.pushed_at)`;
    const r = (await db.execute(sql`
        SELECT u.name AS user_name, t.month::text AS month, COUNT(*)::int AS targets,
               MAX(FLOOR(EXTRACT(EPOCH FROM (now() - ${since})) / 3600))::int AS hours,
               COUNT(*) FILTER (WHERE ${j("correction_requested_at")} IS NOT NULL OR t.status = 'rejected')::int AS corrections
          FROM sales_targets t
          LEFT JOIN users u ON u.id::text = t.user_id
         WHERE t.status IN ('pushed', 'rejected') AND ${since} < now() - INTERVAL '48 hours'
         GROUP BY u.name, t.month
         ORDER BY hours DESC
    `)) as unknown as Array<{ user_name: string | null; month: string; targets: number; hours: number; corrections: number }>;
    return r;
}

/**
 * ID 189 — "Targets waiting for your approval" (Sales dashboard): posted
 * targets the Sales Head has not pushed yet, this month and later — first
 * posts, posted CEO revisions and stretch changes waiting for the push, and
 * open correction requests. Never the CEO's unposted drafts.
 */
export async function awaitingPush(): Promise<{
    targets: number;
    people: number;
    corrections: number;
    first_month: string | null;
}> {
    const r = (await db.execute(sql`
        SELECT COUNT(*) FILTER (WHERE w)::int AS targets,
               COUNT(DISTINCT user_id) FILTER (WHERE w OR c)::int AS people,
               COUNT(*) FILTER (WHERE c)::int AS corrections,
               MIN(month::text) FILTER (WHERE w OR c) AS first_month
          FROM (
            SELECT t.user_id, t.month,
                   (t.status IN ('pending_approval', 'rejected')
                    OR (t.status IN ('pushed', 'accepted')
                        AND (${j("next_ceo_target")} IS NOT NULL OR ${j("next_stretch")} IS NOT NULL))) AS w,
                   (t.status = 'pushed' AND ${j("correction_requested_at")} IS NOT NULL
                    AND (t.pushed_at IS NULL OR ${j("correction_requested_at")}::timestamptz > t.pushed_at)) AS c
              FROM sales_targets t
             WHERE t.month >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')::date
          ) x
    `)) as unknown as Array<{ targets: number; people: number; corrections: number; first_month: string | null }>;
    return r[0] ?? { targets: 0, people: 0, corrections: 0, first_month: null };
}

/** Exposed so readers outside this file use the same final-target rule. */
export { finalTargetSql, targetVisibleSql };

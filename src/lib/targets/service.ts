/**
 * Sales targets — data and workflow (E-303, review R-17). Rules, metric
 * vocabulary and pro-rata maths are in ./rules.ts.
 *
 * WHO MAY DO WHAT (sheet 8 + item 3, 14 Oct 2026):
 *   CEO           adds people to a month, sets the CEO target, sends them to
 *                 the Sales Head
 *   sales_head    sets the Sales Head target (E-341): empty / 0 = the CEO's
 *                 number goes to the member; any other number — higher or
 *                 lower — replaces it
 *   CEO / sales_head   add a metric (built-in or custom), remove one, enter a
 *                 custom metric's progress
 *   admin         adds people and may do what the Sales Head does. The old
 *                 admin add-on is no longer edited (0 on every row at E-341)
 *   sales_head / admin   send to the member (after review, or again after a reject)
 *   the employee  accepts or rejects (with a comment) their own sent targets,
 *                 and enters progress on their own custom metrics
 *
 * NOTIFICATIONS (bell + email, src/lib/notifications/emit.ts, "Targets"):
 *   targets.review_requested  CEO → Sales Head(s)
 *   targets.sent              → the member, opening their performance page
 *   targets.rejected          member → Sales Head(s) + CEO, with the comment
 *   targets.accepted          member → Sales Head(s) + CEO (bell only)
 *
 * ACTUALS come from the Sales dashboard builder (B6 + R-10 outcome) over the
 * month so far, so a target's actual can never disagree with the dashboard,
 * plus three small queries for what the builder does not carry: scrap deals,
 * hot leads handed to ground, and calls. KYC disbursed has no per-person source
 * yet (loans are not linked to a CRM owner) and shows as "not measured".
 */
import { humanCall, wasHotAt } from "@/lib/reports/metricDefinitions";
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
    isCustomMetric,
    isTargetMetric,
    metricKind,
    metricsForRole,
    monthEnd,
    newCustomMetricKey,
    progress,
    TARGET_METRICS,
    validateAddon,
    validateCustomMetric,
    validateKycPair,
    validateRejectComment,
    workingDaysBetween,
    type MetricKind,
    type Progress,
    type TargetMetric,
    type TargetStatus,
} from "@/lib/targets/rules";
import { emit } from "@/lib/notifications/emit";
import { finalTargetSql } from "@/lib/targets/sql";
import { ADMIN_PARTY } from "@/lib/notifications/provenance";

/** Add / remove metrics, enter custom progress. */
export const TARGET_METRIC_ROLES = ["ceo", "sales_head", "admin"];
/** Set the CEO target number. */
export const TARGET_CEO_ROLES = ["ceo"];
/** Set the Sales Head target number (E-341). */
export const TARGET_SALES_HEAD_ROLES = ["sales_head", "admin"];
/** Legacy admin add-on — no longer edited on screen; kept for the API. */
export const TARGET_ADDON_ROLES = ["admin"];
/** Send to the member (the Sales Head's step). */
export const TARGET_APPROVER_ROLES = ["admin", "sales_head"];
/** Add a person to a month, and send their targets to the Sales Head. */
export const TARGET_ADD_PERSON_ROLES = ["ceo", "admin"];
export const TARGET_VIEW_ROLES = ["ceo", "admin", "sales_head", "business_head"];
/** Told when a member rejects / accepts. */
const TARGET_MANAGER_ROLES = ["sales_head", "ceo"];

export class TargetError extends Error {}

type Actor = { id: string; role: string };
const has = (roles: string[], a: Actor) => roles.includes((a.role ?? "").toLowerCase());

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
    ceo_target: number;
    /** E-341 — the Sales Head's number; null / 0 = the CEO target goes. */
    sales_head_target: number | null;
    admin_addon: number;
    final_target: number;
    status: TargetStatus;
    pushed_at: string | null;
    accepted_at: string | null;
    hours_since_push_unaccepted: number | null;
    review_requested_at: string | null;
    rejected_at: string | null;
    reject_comment: string | null;
    progress: Progress;
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

/** Month-to-date actual per (user, metric). null = not measurable. */
async function actualsFor(monthFirst: string, upTo: string, elapsedWorkingDays: number) {
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
            SELECT t.performed_by AS u, COUNT(DISTINCT t.dealer_lead_id) AS n
              FROM lead_touchpoints t
              JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
             WHERE t.touchpoint_type = 'asm_transfer'
               AND ${wasHotAt(sql`t.dealer_lead_id`, sql`t.performed_at`, sql`dl.interest_level`)}
               AND (t.performed_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${monthFirst}::date AND ${upTo}::date
               AND t.performed_by IS NOT NULL
             GROUP BY t.performed_by
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
    for (const r of extra) ex.set(`${r.u}:${r.k}`, Number(r.n));
    const byUser = new Map((dash.per_spoc ?? []).map((b) => [b.spoc_id, b]));

    return (userId: string, metric: string): number | null => {
        if (!isTargetMetric(metric)) return null;
        const b = byUser.get(userId);
        switch (metric) {
            case "dealer_visits":
                // ID 59: DISTINCT dealers visited (M08) — the figure the daily
                // email puts against this target — not the number of visits.
                return b?.totals.unique_visits ?? 0;
            case "new_dealer_visits":
                return b?.totals.new_visits ?? 0;
            case "batteries_sold":
                return b?.outcome.batteries_to_dealers ?? 0;
            case "kyc_submitted":
                return b?.outcome.kyc_submitted ?? 0;
            case "revenue":
                return b?.outcome.revenue ?? 0;
            case "kyc_disbursed":
                return null;
            case "scrap_deals":
                return ex.get(`${userId}:scrap`) ?? 0;
            case "hot_to_ground":
                return ex.get(`${userId}:hot`) ?? 0;
            case "calls_per_day": {
                const calls = ex.get(`${userId}:calls`) ?? 0;
                return elapsedWorkingDays > 0 ? Math.round((calls / elapsedWorkingDays) * 10) / 10 : 0;
            }
        }
    };
}

export async function listTargets(opts: { month: string; userId?: string }): Promise<TargetRow[]> {
    const monthFirst = `${opts.month.slice(0, 7)}-01`;
    const last = monthEnd(monthFirst);
    const today = await istToday();
    const upTo = today < monthFirst ? monthFirst : today > last ? last : today;
    const hol = await holidays(monthFirst, last);
    const total = workingDaysBetween(monthFirst, last, hol);
    const elapsed = today < monthFirst ? 0 : workingDaysBetween(monthFirst, upTo, hol);

    const rows = (await db.execute(sql`
        SELECT t.id, t.month::text AS month, t.user_id, u.name AS user_name, u.role AS user_role,
               t.metric, t.ceo_target::float8 AS ceo_target, t.admin_addon::float8 AS admin_addon,
               t.status, t.pushed_at, t.accepted_at,
               -- E-340 columns through to_jsonb: null on a DB without them.
               to_jsonb(t) ->> 'custom_label' AS custom_label,
               to_jsonb(t) ->> 'custom_unit' AS custom_unit,
               (to_jsonb(t) ->> 'manual_actual')::float8 AS manual_actual,
               to_jsonb(t) ->> 'review_requested_at' AS review_requested_at,
               to_jsonb(t) ->> 'rejected_at' AS rejected_at,
               to_jsonb(t) ->> 'reject_comment' AS reject_comment,
               (to_jsonb(t) ->> 'sales_head_target')::float8 AS sales_head_target,
               CASE WHEN t.status = 'pushed'
                    THEN FLOOR(EXTRACT(EPOCH FROM (now() - t.pushed_at)) / 3600)::int END AS hours_unaccepted
          FROM sales_targets t
          LEFT JOIN users u ON u.id::text = t.user_id
         WHERE t.month = ${monthFirst}::date
           ${opts.userId ? sql`AND t.user_id = ${opts.userId}` : sql``}
         ORDER BY u.name NULLS LAST, t.created_at, t.metric
    `)) as unknown as Array<Record<string, unknown>>;

    const actual = rows.length ? await actualsFor(monthFirst, upTo, elapsed) : () => null;
    const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
    return rows
        .filter((r) => isTargetMetric(String(r.metric)) || (isCustomMetric(String(r.metric)) && r.custom_label))
        .map((r) => {
            const metric = String(r.metric);
            const custom = !isTargetMetric(metric);
            const unit = custom ? ((r.custom_unit as string | null) ?? null) : null;
            const kind = metricKind(metric, unit);
            const shTarget = r.sales_head_target == null ? null : Number(r.sales_head_target);
            // Same rule as finalTargetSql(): the Sales Head's number when entered, else the CEO's.
            const finalTarget = shTarget != null && shTarget > 0 ? shTarget : Number(r.ceo_target) + Number(r.admin_addon);
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
                ceo_target: Number(r.ceo_target),
                sales_head_target: shTarget,
                admin_addon: Number(r.admin_addon),
                final_target: finalTarget,
                status: String(r.status) as TargetStatus,
                pushed_at: r.pushed_at ? new Date(r.pushed_at as string).toISOString() : null,
                accepted_at: r.accepted_at ? new Date(r.accepted_at as string).toISOString() : null,
                hours_since_push_unaccepted: r.hours_unaccepted == null ? null : Number(r.hours_unaccepted),
                review_requested_at: iso(r.review_requested_at),
                rejected_at: iso(r.rejected_at),
                reject_comment: (r.reject_comment as string | null) ?? null,
                progress: progress({
                    metric,
                    kind,
                    monthly: finalTarget,
                    // A custom metric's progress is whatever was entered by hand.
                    actual: custom
                        ? r.manual_actual == null
                            ? null
                            : Number(r.manual_actual)
                        : actual(String(r.user_id), metric),
                    workingDaysTotal: total,
                    workingDaysElapsed: elapsed,
                }),
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
        working_days_total: workingDaysBetween(monthFirst, last, hol),
        working_days_elapsed: today < monthFirst ? 0 : workingDaysBetween(monthFirst, upTo, hol),
    };
}

/** Add a person to a month: one draft row per metric their role carries. */
export async function addPersonToMonth(month: string, userId: string, actor: Actor) {
    if (!has(TARGET_ADD_PERSON_ROLES, actor)) throw new TargetError("Only the CEO or an admin can add targets.");
    const u = (await db.execute(sql`
        SELECT role FROM users WHERE id::text = ${userId} AND is_active = TRUE
    `)) as unknown as Array<{ role: string }>;
    if (!u.length) throw new TargetError("That person does not exist or is inactive.");
    const metrics = metricsForRole(u[0].role);
    if (!metrics.length) throw new TargetError(`No target metrics are defined for the ${u[0].role} role.`);
    const monthFirst = `${month.slice(0, 7)}-01`;
    for (const m of metrics) {
        await db.execute(sql`
            INSERT INTO sales_targets (month, user_id, metric, created_by, updated_by)
            VALUES (${monthFirst}::date, ${userId}, ${m}, ${actor.id}, ${actor.id})
            ON CONFLICT (month, user_id, metric) DO NOTHING
        `);
    }
    return { added: metrics.length };
}

/**
 * Edit a target's numbers. The CEO sets ceo_target, an admin sets admin_addon.
 * A pushed or accepted target goes back to pending approval, so the changed
 * number is re-approved and re-accepted, never swapped silently.
 */
export async function updateTarget(
    id: string,
    patch: { ceo_target?: number; sales_head_target?: number | null; admin_addon?: number },
    actor: Actor,
) {
    if (patch.ceo_target !== undefined && !has(TARGET_CEO_ROLES, actor)) {
        throw new TargetError("Only the CEO sets the CEO target.");
    }
    if (patch.sales_head_target !== undefined) {
        if (!has(TARGET_SALES_HEAD_ROLES, actor)) throw new TargetError("Only the Sales Head sets the Sales Head target.");
        if (patch.sales_head_target !== null && (!Number.isFinite(patch.sales_head_target) || patch.sales_head_target < 0)) {
            throw new TargetError("The Sales Head target must be zero or more (leave it empty to use the CEO's).");
        }
    }
    if (patch.admin_addon !== undefined) {
        if (!has(TARGET_ADDON_ROLES, actor)) throw new TargetError("Only an admin sets the add-on.");
        const bad = validateAddon(patch.admin_addon);
        if (bad) throw new TargetError(bad);
    }
    if (patch.ceo_target !== undefined && (!Number.isFinite(patch.ceo_target) || patch.ceo_target < 0)) {
        throw new TargetError("The target must be zero or more.");
    }

    await db.transaction(async (tx) => {
        const cur = (await tx.execute(sql`
            SELECT user_id, month::text AS month, status FROM sales_targets WHERE id = ${id}::uuid FOR UPDATE
        `)) as unknown as Array<{ user_id: string; month: string; status: string }>;
        if (!cur.length) throw new TargetError("Target not found.");
        const reopen = cur[0].status === "pushed" || cur[0].status === "accepted";
        // Empty / 0 Sales Head target = "use the CEO's" — stored as NULL.
        const sh = patch.sales_head_target === undefined ? undefined : patch.sales_head_target || null;
        await tx.execute(sql`
            UPDATE sales_targets
               SET ceo_target  = COALESCE(${patch.ceo_target ?? null}::numeric, ceo_target),
                   admin_addon = COALESCE(${patch.admin_addon ?? null}::numeric, admin_addon),
                   ${sh === undefined ? sql`` : sql`sales_head_target = ${sh}::numeric,`}
                   status      = CASE WHEN ${reopen} THEN 'pending_approval' ELSE status END,
                   pushed_at   = CASE WHEN ${reopen} THEN NULL ELSE pushed_at END,
                   accepted_at = CASE WHEN ${reopen} THEN NULL ELSE accepted_at END,
                   updated_by  = ${actor.id}, updated_at = now()
             WHERE id = ${id}::uuid
        `);
        // #15 — KYC disbursed ≤ KYC submitted, checked after the edit.
        const kyc = (await tx.execute(sql`
            SELECT metric, (${finalTargetSql(sql`sales_targets`)})::float8 AS f FROM sales_targets
             WHERE user_id = ${cur[0].user_id} AND month = ${cur[0].month}::date
               AND metric IN ('kyc_submitted', 'kyc_disbursed')
        `)) as unknown as Array<{ metric: string; f: number }>;
        const sub = kyc.find((k) => k.metric === "kyc_submitted")?.f ?? null;
        const dis = kyc.find((k) => k.metric === "kyc_disbursed")?.f ?? null;
        const bad = validateKycPair(sub, dis);
        if (bad) throw new TargetError(bad);
    });
}

// ── Workflow: CEO → Sales Head → member → accept / reject ───────────────────

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

/**
 * CEO / admin: send targets to the Sales Head for review — a draft, or a
 * target the member rejected. The Sales Head(s) are told.
 */
export async function sendForReview(ids: string[], actor: Actor) {
    if (!has(TARGET_ADD_PERSON_ROLES, actor)) throw new TargetError("Only the CEO or an admin sends targets to the Sales Head.");
    if (!ids.length) return { changed: 0 };
    const rows = (await db.execute(sql`
        UPDATE sales_targets
           SET status = 'pending_approval', review_requested_at = now(), review_requested_by = ${actor.id},
               updated_by = ${actor.id}, updated_at = now()
         WHERE id IN (${idList(ids)}) AND status IN ('draft', 'rejected')
        RETURNING id::text AS id, user_id, month::text AS month
    `)) as unknown as Changed[];
    if (rows.length) {
        const groups = byPersonMonth(rows);
        const names = await namesOf([actor.id, ...groups.map((g) => g.user_id)]);
        const who = groups.map((g) => `${names.get(g.user_id)?.name ?? "a member"} (${plural(g.count, "target")})`).join(", ");
        await emit({
            type: "targets.review_requested",
            title: "Targets sent to you for review",
            message: `${names.get(actor.id)?.name ?? "The CEO"} sent ${monthName(groups[0].month)} targets for ${who}. Review, change if needed, and send them to the member.`,
            from: ADMIN_PARTY,
            data: { ids: rows.map((r) => r.id) },
            to: [{ audience: { kind: "roles", roles: ["sales_head"] }, as: ADMIN_PARTY, href: registerHref(groups[0].month) }],
        });
    }
    return { changed: rows.length };
}

/**
 * Sales Head / admin: send targets to the member — after review, a target the
 * Sales Head added, or again after a reject. Starts the 48-hour clock; the
 * member is told (bell + email) with a link to accept or reject.
 */
export async function sendToMember(ids: string[], actor: Actor) {
    if (!has(TARGET_APPROVER_ROLES, actor)) throw new TargetError("Only the Sales Head or an admin sends targets to the member.");
    if (!ids.length) return { changed: 0 };
    const rows = (await db.execute(sql`
        UPDATE sales_targets
           SET status = 'pushed', approved_by = ${actor.id}, approved_at = now(),
               pushed_at = now(), accepted_at = NULL, reminded_at = NULL,
               updated_by = ${actor.id}, updated_at = now()
         WHERE id IN (${idList(ids)}) AND status IN ('draft', 'pending_approval', 'rejected')
        RETURNING id::text AS id, user_id, month::text AS month
    `)) as unknown as Changed[];
    const groups = byPersonMonth(rows);
    const names = await namesOf([actor.id, ...groups.map((g) => g.user_id)]);
    for (const g of groups) {
        const member = names.get(g.user_id);
        await emit({
            type: "targets.sent",
            title: `Your ${monthName(g.month)} targets`,
            message: `${names.get(actor.id)?.name ?? "The Sales Head"} sent you ${plural(g.count, "target")} for ${monthName(g.month)}. Open My Performance to accept them, or reject with a comment.`,
            from: ADMIN_PARTY,
            emailSubject: `Please review your ${monthName(g.month)} targets`,
            data: { month: g.month },
            to: [{ audience: { kind: "user", userId: g.user_id }, as: ADMIN_PARTY, href: performanceHrefFor(member?.role) }],
        });
    }
    return { changed: rows.length };
}

/** @deprecated name kept for older callers — sendForReview. */
export const submitTargets = sendForReview;
/** @deprecated name kept for older callers — sendToMember. */
export const approveAndPush = sendToMember;

/** Sent → accepted, by the person the targets belong to — and nobody else. */
export async function acceptTargets(ids: string[], actor: Actor) {
    if (!ids.length) return { changed: 0 };
    const rows = (await db.execute(sql`
        UPDATE sales_targets SET status = 'accepted', accepted_at = now(), updated_at = now()
         WHERE id IN (${idList(ids)})
           AND status = 'pushed' AND user_id = ${actor.id}
        RETURNING id::text AS id, user_id, month::text AS month
    `)) as unknown as Changed[];
    if (rows.length) {
        const names = await namesOf([actor.id]);
        const month = rows[0].month;
        await emit({
            type: "targets.accepted",
            title: "Targets accepted",
            message: `${names.get(actor.id)?.name ?? "A member"} accepted ${plural(rows.length, "target")} for ${monthName(month)}.`,
            from: ADMIN_PARTY,
            email: false,
            to: [{ audience: { kind: "roles", roles: TARGET_MANAGER_ROLES }, as: ADMIN_PARTY, href: registerHref(month) }],
        });
    }
    return { changed: rows.length };
}

/**
 * Sent → rejected, by the member, with a required comment. The Sales Head(s)
 * and CEO are told (bell + email) with the comment; they edit and send again.
 */
export async function rejectTargets(ids: string[], comment: string, actor: Actor) {
    const bad = validateRejectComment(comment);
    if (bad) throw new TargetError(bad);
    if (!ids.length) return { changed: 0 };
    const text = comment.trim();
    const rows = (await db.execute(sql`
        UPDATE sales_targets
           SET status = 'rejected', rejected_at = now(), rejected_by = ${actor.id}, reject_comment = ${text},
               accepted_at = NULL, updated_at = now()
         WHERE id IN (${idList(ids)})
           AND status = 'pushed' AND user_id = ${actor.id}
        RETURNING id::text AS id, user_id, month::text AS month
    `)) as unknown as Changed[];
    if (rows.length) {
        const names = await namesOf([actor.id]);
        const month = rows[0].month;
        const labels = (await db.execute(sql`
            SELECT metric, to_jsonb(t) ->> 'custom_label' AS custom_label FROM sales_targets t
             WHERE id IN (${idList(rows.map((r) => r.id))})
        `)) as unknown as Array<{ metric: string; custom_label: string | null }>;
        const what = labels
            .map((l) => (isTargetMetric(l.metric) ? TARGET_METRICS[l.metric].label : (l.custom_label ?? l.metric)))
            .join(", ");
        await emit({
            type: "targets.rejected",
            title: "Targets rejected",
            message: `${names.get(actor.id)?.name ?? "A member"} rejected ${plural(rows.length, "target")} for ${monthName(month)} (${what}): "${text}"`,
            from: ADMIN_PARTY,
            data: { ids: rows.map((r) => r.id), comment: text },
            to: [{ audience: { kind: "roles", roles: TARGET_MANAGER_ROLES }, as: ADMIN_PARTY, href: registerHref(month) }],
        });
    }
    return { changed: rows.length };
}

// ── Metrics: add one (built-in or custom), remove one ───────────────────────

/**
 * Add one metric to a person's month — a built-in metric (any, not only the
 * role's defaults) or a custom one. Lands as a draft; it reaches the member
 * when it is sent like any other target.
 */
export async function addMetric(
    input: { month: string; userId: string; metric?: string; custom?: { label: string; unit?: string | null }; target?: number },
    actor: Actor,
) {
    if (!has(TARGET_METRIC_ROLES, actor)) throw new TargetError("Only the CEO or the Sales Head adds metrics.");
    const u = (await db.execute(sql`
        SELECT 1 FROM users WHERE id::text = ${input.userId} AND is_active = TRUE
    `)) as unknown as unknown[];
    if (!u.length) throw new TargetError("That person does not exist or is inactive.");
    const target = input.target ?? 0;
    if (!Number.isFinite(target) || target < 0) throw new TargetError("The target must be zero or more.");
    const monthFirst = `${input.month.slice(0, 7)}-01`;
    // The CEO's number is the CEO target; the Sales Head's (or admin's) is the
    // Sales Head target, so the column says whose it is.
    const byCeo = has(TARGET_CEO_ROLES, actor);
    const ceoTarget = byCeo ? target : 0;
    const shTarget = byCeo || target === 0 ? null : target;

    if (input.custom) {
        const bad = validateCustomMetric(input.custom.label, input.custom.unit);
        if (bad) throw new TargetError(bad);
        const r = (await db.execute(sql`
            INSERT INTO sales_targets (month, user_id, metric, ceo_target, sales_head_target, custom_label, custom_unit, created_by, updated_by)
            VALUES (${monthFirst}::date, ${input.userId}, ${newCustomMetricKey()}, ${ceoTarget}, ${shTarget},
                    ${input.custom.label.trim()}, ${(input.custom.unit ?? "").trim() || null}, ${actor.id}, ${actor.id})
            RETURNING id::text AS id
        `)) as unknown as Array<{ id: string }>;
        return { id: r[0].id };
    }
    if (!input.metric || !isTargetMetric(input.metric)) throw new TargetError("Pick a metric.");
    const r = (await db.execute(sql`
        INSERT INTO sales_targets (month, user_id, metric, ceo_target, sales_head_target, created_by, updated_by)
        VALUES (${monthFirst}::date, ${input.userId}, ${input.metric}, ${ceoTarget}, ${shTarget}, ${actor.id}, ${actor.id})
        ON CONFLICT (month, user_id, metric) DO NOTHING
        RETURNING id::text AS id
    `)) as unknown as Array<{ id: string }>;
    if (!r.length) throw new TargetError(`${TARGET_METRICS[input.metric].label} is already a target for this person this month.`);
    return { id: r[0].id };
}

/** Remove one target row (CEO / Sales Head), at any stage. */
export async function removeTarget(id: string, actor: Actor) {
    if (!has(TARGET_METRIC_ROLES, actor)) throw new TargetError("Only the CEO or the Sales Head removes metrics.");
    const r = (await db.execute(sql`DELETE FROM sales_targets WHERE id = ${id}::uuid RETURNING id`)) as unknown as unknown[];
    if (!r.length) throw new TargetError("Target not found.");
    return { removed: 1 };
}

/**
 * A custom metric's progress, entered by hand — by the member on their own
 * target, or by the CEO / Sales Head / admin. Built-in metrics are measured.
 */
export async function setManualActual(id: string, value: number | null, actor: Actor) {
    if (value != null && (!Number.isFinite(value) || value < 0)) throw new TargetError("Progress must be zero or more.");
    const cur = (await db.execute(sql`
        SELECT user_id, metric FROM sales_targets WHERE id = ${id}::uuid
    `)) as unknown as Array<{ user_id: string; metric: string }>;
    if (!cur.length) throw new TargetError("Target not found.");
    if (!isCustomMetric(cur[0].metric)) throw new TargetError("Only a custom metric's progress is entered by hand.");
    if (cur[0].user_id !== actor.id && !has(TARGET_METRIC_ROLES, actor)) {
        throw new TargetError("You can only update your own targets.");
    }
    await db.execute(sql`
        UPDATE sales_targets
           SET manual_actual = ${value}, manual_actual_at = now(), manual_actual_by = ${actor.id}, updated_at = now()
         WHERE id = ${id}::uuid
    `);
    return { ok: true };
}

/** Pushed targets not accepted within 48 h — for the targets_pending digest. */
export async function overdueAcceptance(): Promise<
    Array<{ user_name: string | null; month: string; targets: number; hours: number }>
> {
    const r = (await db.execute(sql`
        SELECT u.name AS user_name, t.month::text AS month, COUNT(*)::int AS targets,
               MAX(FLOOR(EXTRACT(EPOCH FROM (now() - t.pushed_at)) / 3600))::int AS hours
          FROM sales_targets t
          LEFT JOIN users u ON u.id::text = t.user_id
         WHERE t.status = 'pushed' AND t.pushed_at < now() - INTERVAL '48 hours'
         GROUP BY u.name, t.month
         ORDER BY hours DESC
    `)) as unknown as Array<{ user_name: string | null; month: string; targets: number; hours: number }>;
    return r;
}

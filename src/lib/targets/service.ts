/**
 * Sales targets — data and workflow (E-303, review R-17). Rules, metric
 * vocabulary and pro-rata maths are in ./rules.ts.
 *
 * WHO MAY DO WHAT (sheet 8):
 *   CEO           adds people to a month, sets ceo_target
 *   admin         adds people to a month, sets admin_addon (≥ 0 — add only)
 *   admin / sales_head   approve & push
 *   the employee  accepts their own pushed targets
 *
 * ACTUALS come from the Sales dashboard builder (B6 + R-10 outcome) over the
 * month so far, so a target's actual can never disagree with the dashboard,
 * plus three small queries for what the builder does not carry: scrap deals,
 * hot leads handed to ground, and calls. KYC disbursed has no per-person source
 * yet (loans are not linked to a CRM owner) and shows as "not measured".
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
    isTargetMetric,
    metricsForRole,
    monthEnd,
    progress,
    TARGET_METRICS,
    validateAddon,
    validateKycPair,
    workingDaysBetween,
    type Progress,
    type TargetMetric,
    type TargetStatus,
} from "@/lib/targets/rules";

export const TARGET_CEO_ROLES = ["ceo"];
export const TARGET_ADDON_ROLES = ["admin"];
export const TARGET_APPROVER_ROLES = ["admin", "sales_head"];
export const TARGET_ADD_PERSON_ROLES = ["ceo", "admin"];
export const TARGET_VIEW_ROLES = ["ceo", "admin", "sales_head", "business_head"];

export class TargetError extends Error {}

type Actor = { id: string; role: string };
const has = (roles: string[], a: Actor) => roles.includes((a.role ?? "").toLowerCase());

export type TargetRow = {
    id: string;
    month: string;
    user_id: string;
    user_name: string | null;
    user_role: string | null;
    metric: TargetMetric;
    metric_label: string;
    ceo_target: number;
    admin_addon: number;
    final_target: number;
    status: TargetStatus;
    pushed_at: string | null;
    accepted_at: string | null;
    hours_since_push_unaccepted: number | null;
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
            SELECT t.performed_by AS u, COUNT(*) AS n
              FROM lead_touchpoints t
              JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
             WHERE t.touchpoint_type = 'asm_transfer'
               AND lower(dl.interest_level) = 'hot'
               AND (t.performed_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${monthFirst}::date AND ${upTo}::date
               AND t.performed_by IS NOT NULL
             GROUP BY t.performed_by
        ),
        calls AS (
            SELECT t.performed_by AS u, COUNT(*) AS n
              FROM lead_touchpoints t
             WHERE t.touchpoint_type = 'inside_sales_call'
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

    return (userId: string, metric: TargetMetric): number | null => {
        const b = byUser.get(userId);
        switch (metric) {
            case "dealer_visits":
                return b?.totals.visits ?? 0;
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
               CASE WHEN t.status = 'pushed'
                    THEN FLOOR(EXTRACT(EPOCH FROM (now() - t.pushed_at)) / 3600)::int END AS hours_unaccepted
          FROM sales_targets t
          LEFT JOIN users u ON u.id::text = t.user_id
         WHERE t.month = ${monthFirst}::date
           ${opts.userId ? sql`AND t.user_id = ${opts.userId}` : sql``}
         ORDER BY u.name NULLS LAST, t.metric
    `)) as unknown as Array<Record<string, unknown>>;

    const actual = rows.length ? await actualsFor(monthFirst, upTo, elapsed) : () => null;
    return rows
        .filter((r) => isTargetMetric(String(r.metric)))
        .map((r) => {
            const metric = String(r.metric) as TargetMetric;
            const finalTarget = Number(r.ceo_target) + Number(r.admin_addon);
            return {
                id: String(r.id),
                month: String(r.month),
                user_id: String(r.user_id),
                user_name: (r.user_name as string | null) ?? null,
                user_role: (r.user_role as string | null) ?? null,
                metric,
                metric_label: TARGET_METRICS[metric].label,
                ceo_target: Number(r.ceo_target),
                admin_addon: Number(r.admin_addon),
                final_target: finalTarget,
                status: String(r.status) as TargetStatus,
                pushed_at: r.pushed_at ? new Date(r.pushed_at as string).toISOString() : null,
                accepted_at: r.accepted_at ? new Date(r.accepted_at as string).toISOString() : null,
                hours_since_push_unaccepted: r.hours_unaccepted == null ? null : Number(r.hours_unaccepted),
                progress: progress({
                    metric,
                    monthly: finalTarget,
                    actual: actual(String(r.user_id), metric),
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
    patch: { ceo_target?: number; admin_addon?: number },
    actor: Actor,
) {
    if (patch.ceo_target !== undefined && !has(TARGET_CEO_ROLES, actor)) {
        throw new TargetError("Only the CEO sets the CEO target.");
    }
    if (patch.admin_addon !== undefined) {
        if (!has(TARGET_ADDON_ROLES, actor)) throw new TargetError("Only an admin sets the add-on.");
        const bad = validateAddon(patch.admin_addon);
        if (bad) throw new TargetError(bad);
    }
    if (patch.ceo_target !== undefined && (!Number.isFinite(patch.ceo_target) || patch.ceo_target < 0)) {
        throw new TargetError("The CEO target must be zero or more.");
    }

    await db.transaction(async (tx) => {
        const cur = (await tx.execute(sql`
            SELECT user_id, month::text AS month, status FROM sales_targets WHERE id = ${id}::uuid FOR UPDATE
        `)) as unknown as Array<{ user_id: string; month: string; status: string }>;
        if (!cur.length) throw new TargetError("Target not found.");
        const reopen = cur[0].status === "pushed" || cur[0].status === "accepted";
        await tx.execute(sql`
            UPDATE sales_targets
               SET ceo_target  = COALESCE(${patch.ceo_target ?? null}::numeric, ceo_target),
                   admin_addon = COALESCE(${patch.admin_addon ?? null}::numeric, admin_addon),
                   status      = CASE WHEN ${reopen} THEN 'pending_approval' ELSE status END,
                   pushed_at   = CASE WHEN ${reopen} THEN NULL ELSE pushed_at END,
                   accepted_at = CASE WHEN ${reopen} THEN NULL ELSE accepted_at END,
                   updated_by  = ${actor.id}, updated_at = now()
             WHERE id = ${id}::uuid
        `);
        // #15 — KYC disbursed ≤ KYC submitted, checked after the edit.
        const kyc = (await tx.execute(sql`
            SELECT metric, (ceo_target + admin_addon)::float8 AS f FROM sales_targets
             WHERE user_id = ${cur[0].user_id} AND month = ${cur[0].month}::date
               AND metric IN ('kyc_submitted', 'kyc_disbursed')
        `)) as unknown as Array<{ metric: string; f: number }>;
        const sub = kyc.find((k) => k.metric === "kyc_submitted")?.f ?? null;
        const dis = kyc.find((k) => k.metric === "kyc_disbursed")?.f ?? null;
        const bad = validateKycPair(sub, dis);
        if (bad) throw new TargetError(bad);
    });
}

/** Draft → pending approval, for the given rows (CEO or admin). */
export async function submitTargets(ids: string[], actor: Actor) {
    if (!has(TARGET_ADD_PERSON_ROLES, actor)) throw new TargetError("Only the CEO or an admin can submit targets.");
    if (!ids.length) return { changed: 0 };
    const r = (await db.execute(sql`
        UPDATE sales_targets SET status = 'pending_approval', updated_by = ${actor.id}, updated_at = now()
         WHERE id IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}) AND status = 'draft'
        RETURNING id
    `)) as unknown as unknown[];
    return { changed: r.length };
}

/** Pending approval → pushed (admin / sales head). Starts the 48-hour clock. */
export async function approveAndPush(ids: string[], actor: Actor) {
    if (!has(TARGET_APPROVER_ROLES, actor)) throw new TargetError("Only an admin or the sales head can approve targets.");
    if (!ids.length) return { changed: 0 };
    const r = (await db.execute(sql`
        UPDATE sales_targets
           SET status = 'pushed', approved_by = ${actor.id}, approved_at = now(),
               pushed_at = now(), reminded_at = NULL, updated_by = ${actor.id}, updated_at = now()
         WHERE id IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}) AND status = 'pending_approval'
        RETURNING id
    `)) as unknown as unknown[];
    return { changed: r.length };
}

/** Pushed → accepted, by the person the targets belong to — and nobody else. */
export async function acceptTargets(ids: string[], actor: Actor) {
    if (!ids.length) return { changed: 0 };
    const r = (await db.execute(sql`
        UPDATE sales_targets SET status = 'accepted', accepted_at = now(), updated_at = now()
         WHERE id IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})
           AND status = 'pushed' AND user_id = ${actor.id}
        RETURNING id
    `)) as unknown as unknown[];
    return { changed: r.length };
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

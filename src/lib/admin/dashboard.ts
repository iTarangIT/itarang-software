// Module 3 — Admin Dashboard data layer (BRD §0.11). Four zones:
//   Zone 1  KPI strip          fetchKpis()
//   Zone 2  Team performance   fetchTeamPerformance()
//   Zone 3  Alert panels       fetchAlertCounts() + fetchAlertPanel()
//   Zone 4  Filters            applied via leadFilter()
//
// Raw SQL via db.execute() — same approach as the Module 1/2 query builders.
//
// Working-day note: stale thresholds count Mon–Sat (Sundays excluded) but NOT
// holidays — the precise holiday-aware count lives in
// src/lib/inside-sales/staleness.ts for the rep queue. Holidays are rare; for
// an alert dashboard the Sunday-only approximation is acceptable. Avg-time-to-
// first-touch is plain elapsed hours (BRD's "excluding non-working hours" is a
// V1.1 refinement).

import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { OPEN_STATUSES } from "@/lib/lifecycle/transitions";
import type {
    AdminKpis,
    AlertPanelKey,
    AlertPanelRow,
    DashboardFilters,
    TeamPerfRow,
} from "./types";
import { ALERT_PANELS } from "./types";
import { countOnboardingDropouts } from "./listQueries";

const OPEN_LIST = sql.raw(OPEN_STATUSES.map((s) => `'${s}'`).join(", "));

// Working days (Mon–Sat) elapsed since a timestamp expression, as a SQL scalar.
function workingDaysSince(expr: string): SQL {
    return sql.raw(`(
        SELECT COUNT(*) FROM generate_series(
            ((${expr})::date + 1), CURRENT_DATE, INTERVAL '1 day'
        ) gs WHERE EXTRACT(DOW FROM gs) <> 0
    )`);
}

const LAST_TOUCH = "COALESCE(dl.last_touchpoint_at, dl.assigned_at, dl.created_at)";

// Lead-scoped filter fragment (Zone 4). AND-prefixed; empty when no filters.
function leadFilter(f: DashboardFilters): SQL {
    const parts: SQL[] = [];
    if (f.owner_id) parts.push(sql`dl.current_owner_id = ${f.owner_id}`);
    if (f.status) parts.push(sql`dl.lead_status = ${f.status}`);
    if (f.source) parts.push(sql`dl.source = ${f.source}`);
    if (f.city) parts.push(sql`dl.city ILIKE ${f.city}`);
    if (f.state) parts.push(sql`dl.state ILIKE ${f.state}`);
    if (f.segment) {
        parts.push(sql`dl.segments @> ${JSON.stringify([f.segment])}::jsonb`);
    }
    if (f.reactivated_only) parts.push(sql`dl.previous_lost_reason IS NOT NULL`);
    if (f.follow_up_due_today) {
        parts.push(sql`dl.next_follow_up_at::date <= CURRENT_DATE`);
    }
    if (parts.length === 0) return sql``;
    return sql` AND ${sql.join(parts, sql` AND `)}`;
}

// ─────────────────────────────── Zone 1 — KPIs ────────────────────────────

export async function fetchKpis(f: DashboardFilters): Promise<AdminKpis> {
    const lf = leadFilter(f);

    const [counts, firstTouch, conv7, conv30, staleConv, compliance, dropouts] =
        await Promise.all([
            db.execute<{
                unassigned_queue: string;
                leads_worked_today: string;
                pending_escalations: string;
            }>(sql`
                SELECT
                    (SELECT COUNT(*) FROM dealer_leads dl
                       WHERE dl.lead_status = 'New_Unassigned'
                         AND dl.is_active IS NOT FALSE ${lf}) AS unassigned_queue,
                    (SELECT COUNT(DISTINCT t.dealer_lead_id) FROM lead_touchpoints t
                       WHERE t.performed_at::date = CURRENT_DATE) AS leads_worked_today,
                    (SELECT COUNT(*) FROM lead_escalations
                       WHERE status = 'pending_review') AS pending_escalations
            `),
            db.execute<{ hrs: string | null }>(sql`
                SELECT AVG(EXTRACT(EPOCH FROM (ft.first_touch - dl.assigned_at)) / 3600) AS hrs
                FROM dealer_leads dl
                JOIN LATERAL (
                    SELECT MIN(t.performed_at) AS first_touch
                    FROM lead_touchpoints t
                    WHERE t.dealer_lead_id = dl.id
                      AND t.touchpoint_type = 'inside_sales_call'
                      AND t.call_status = 'connected'
                ) ft ON TRUE
                WHERE dl.assigned_at >= NOW() - INTERVAL '7 days'
                  AND ft.first_touch IS NOT NULL ${lf}
            `),
            convRate(7, lf),
            convRate(30, lf),
            db.execute<{ c: string }>(sql`
                SELECT COUNT(*)::text AS c
                FROM dealer_leads dl
                JOIN dealer_onboarding_applications oa
                    ON oa.id = dl.dealer_onboarding_application_id
                WHERE dl.lead_status = 'Converted'
                  AND COALESCE(oa.last_action_at, oa.updated_at)
                      < NOW() - INTERVAL '3 days' ${lf}
            `),
            db.execute<{ c: string }>(sql`
                SELECT COUNT(*)::text AS c
                FROM dealer_lead_status_history h
                WHERE h.changed_at >= NOW() - INTERVAL '30 days'
                  AND NOT EXISTS (
                    SELECT 1 FROM lead_touchpoints t
                    WHERE t.dealer_lead_id = h.dealer_lead_id
                      AND t.performed_at BETWEEN h.changed_at - INTERVAL '1 hour'
                                             AND h.changed_at + INTERVAL '1 hour'
                  )
            `),
            countOnboardingDropouts(),
        ]);

    return {
        unassigned_queue: Number(counts[0]?.unassigned_queue ?? 0),
        avg_time_to_first_touch_hours:
            firstTouch[0]?.hrs != null ? Number(firstTouch[0].hrs) : null,
        leads_worked_today: Number(counts[0]?.leads_worked_today ?? 0),
        conversion_rate_7d: conv7,
        conversion_rate_30d: conv30,
        pending_escalations: Number(counts[0]?.pending_escalations ?? 0),
        onboarding_dropouts_pending: dropouts,
        stale_converted: Number(staleConv[0]?.c ?? 0),
        compliance_status_without_touchpoint: Number(compliance[0]?.c ?? 0),
    };
}

async function convRate(days: number, lf: SQL): Promise<number | null> {
    const rows = await db.execute<{ conv: string; closed: string }>(sql`
        SELECT
            COUNT(*) FILTER (WHERE dl.lead_status = 'Converted')::text AS conv,
            COUNT(*) FILTER (WHERE dl.lead_status IN ('Converted', 'Lost'))::text AS closed
        FROM dealer_leads dl
        WHERE dl.closed_at >= NOW() - (${String(days)} || ' days')::interval ${lf}
    `);
    const conv = Number(rows[0]?.conv ?? 0);
    const closed = Number(rows[0]?.closed ?? 0);
    return closed > 0 ? conv / closed : null;
}

// ──────────────────────────── Zone 2 — Team perf ──────────────────────────

export async function fetchTeamPerformance(
    f: DashboardFilters,
): Promise<TeamPerfRow[]> {
    // Team perf is per-user; only the location/source/segment filters apply
    // cleanly (owner/status would zero out the table).
    const tf = leadFilter({
        city: f.city,
        state: f.state,
        source: f.source,
        segment: f.segment,
    });

    const rows = await db.execute<TeamPerfRow>(sql`
        SELECT
            u.id::text AS user_id,
            u.name AS user_name,
            u.role,
            (SELECT COUNT(*) FROM dealer_leads dl
               WHERE dl.current_owner_id = u.id::text
                 AND dl.lead_status IN (${OPEN_LIST})
                 AND dl.is_active IS NOT FALSE ${tf}) AS open_leads,
            (SELECT COUNT(*) FROM lead_touchpoints t
               WHERE t.performed_by = u.id::text
                 AND t.performed_at::date = CURRENT_DATE) AS touchpoints_today,
            (SELECT COUNT(*) FROM lead_touchpoints t
               WHERE t.performed_by = u.id::text
                 AND t.performed_at >= NOW() - INTERVAL '7 days') AS touchpoints_week,
            (SELECT ROUND(
                COUNT(*)::numeric
                / NULLIF(COUNT(DISTINCT t.dealer_lead_id), 0), 2)
               FROM lead_touchpoints t
               WHERE t.performed_by = u.id::text) AS avg_touchpoints_per_lead,
            (SELECT ROUND(AVG(
                EXTRACT(EPOCH FROM (ft.first_touch - dl.assigned_at)) / 3600)::numeric, 1)
               FROM dealer_leads dl
               JOIN LATERAL (
                   SELECT MIN(t.performed_at) AS first_touch
                   FROM lead_touchpoints t
                   WHERE t.dealer_lead_id = dl.id
                     AND t.touchpoint_type = 'inside_sales_call'
                     AND t.call_status = 'connected'
               ) ft ON TRUE
               WHERE dl.originator_id = u.id::text
                 AND ft.first_touch IS NOT NULL) AS avg_time_to_first_touch_hours,
            (SELECT ROUND(
                COUNT(*) FILTER (WHERE dl.lead_status = 'Converted')::numeric
                / NULLIF(COUNT(*) FILTER (WHERE dl.lead_status IN ('Converted','Lost')), 0), 3)
               FROM dealer_leads dl
               WHERE dl.closing_owner_id = u.id::text
                 AND dl.closed_at >= NOW() - INTERVAL '30 days') AS conversion_rate_30d,
            (SELECT COUNT(*) FROM dealer_leads dl
               WHERE dl.current_owner_id = u.id::text
                 AND dl.lead_status IN (${OPEN_LIST})
                 AND dl.is_active IS NOT FALSE
                 AND ${workingDaysSince(LAST_TOUCH)} > 5) AS stale_leads,
            (SELECT COUNT(*) FROM dealer_leads dl
               WHERE dl.current_owner_id = u.id::text
                 AND dl.lead_status IN (${OPEN_LIST})
                 AND dl.is_active IS NOT FALSE
                 AND ${workingDaysSince(LAST_TOUCH)} > 10) AS critical_stale,
            (SELECT up.pref_value->>'status' FROM user_preferences up
               WHERE up.user_id = u.id::text
                 AND up.pref_key = 'ooo_status') AS ooo_status
        FROM users u
        WHERE u.role IN ('inside_sales_rep', 'asm')
          AND u.is_active IS NOT FALSE
        ORDER BY critical_stale DESC, stale_leads DESC, u.name ASC
    `);

    return (rows as unknown as TeamPerfRow[]).map((r) => ({
        ...r,
        open_leads: Number(r.open_leads ?? 0),
        touchpoints_today: Number(r.touchpoints_today ?? 0),
        touchpoints_week: Number(r.touchpoints_week ?? 0),
        avg_touchpoints_per_lead:
            r.avg_touchpoints_per_lead != null
                ? Number(r.avg_touchpoints_per_lead)
                : null,
        avg_time_to_first_touch_hours:
            r.avg_time_to_first_touch_hours != null
                ? Number(r.avg_time_to_first_touch_hours)
                : null,
        conversion_rate_30d:
            r.conversion_rate_30d != null ? Number(r.conversion_rate_30d) : null,
        stale_leads: Number(r.stale_leads ?? 0),
        critical_stale: Number(r.critical_stale ?? 0),
    }));
}

// ─────────────────────────── Zone 3 — Alert panels ────────────────────────

// Each panel's COUNT(*) query. The drill-down query (fetchAlertPanel) reuses
// the same FROM/WHERE and just selects display columns.
function panelCountSql(key: AlertPanelKey, lf: SQL): SQL {
    switch (key) {
        case "no_touch_5d":
            return sql`SELECT COUNT(*)::text AS c FROM dealer_leads dl
                WHERE dl.lead_status IN (${OPEN_LIST}) AND dl.is_active IS NOT FALSE
                  AND ${workingDaysSince(LAST_TOUCH)} > 5 ${lf}`;
        case "no_touch_10d":
            return sql`SELECT COUNT(*)::text AS c FROM dealer_leads dl
                WHERE dl.lead_status IN (${OPEN_LIST}) AND dl.is_active IS NOT FALSE
                  AND ${workingDaysSince(LAST_TOUCH)} > 10 ${lf}`;
        case "awaiting_decision_14d":
            return sql`SELECT COUNT(*)::text AS c FROM dealer_leads dl
                WHERE dl.lead_status = 'Awaiting_Customer_Decision'
                  AND dl.is_active IS NOT FALSE
                  AND ${workingDaysSince(LAST_TOUCH)} > 14 ${lf}`;
        case "pending_escalations":
            return sql`SELECT COUNT(*)::text AS c FROM lead_escalations
                WHERE status = 'pending_review'`;
        case "onboarding_dropouts":
            return sql`SELECT COUNT(*)::text AS c FROM dealer_leads dl
                JOIN dealer_onboarding_applications oa
                    ON oa.id = dl.dealer_onboarding_application_id
                WHERE dl.lead_status = 'Converted' AND dl.is_active IS NOT FALSE
                  AND dl.onboarding_dropout_reason IS NULL
                  AND (oa.onboarding_status IN ('rejected','withdrawn')
                       OR (oa.onboarding_status IN ('draft','submitted','correction_requested')
                           AND COALESCE(oa.last_action_at, oa.updated_at) < NOW() - INTERVAL '30 days'))`;
        case "stale_converted":
            return sql`SELECT COUNT(*)::text AS c FROM dealer_leads dl
                JOIN dealer_onboarding_applications oa
                    ON oa.id = dl.dealer_onboarding_application_id
                WHERE dl.lead_status = 'Converted'
                  AND COALESCE(oa.last_action_at, oa.updated_at) < NOW() - INTERVAL '3 days' ${lf}`;
        case "onboarding_stalled":
            return sql`SELECT COUNT(*)::text AS c FROM dealer_onboarding_applications oa
                WHERE oa.onboarding_status IN ('draft','submitted','correction_requested')
                  AND COALESCE(oa.last_action_at, oa.updated_at) < NOW() - INTERVAL '30 days'`;
        case "asm_no_activity":
            return sql`SELECT COUNT(*)::text AS c FROM dealer_leads dl
                WHERE dl.lead_status = 'Transferred_to_ASM' AND dl.asm_id IS NOT NULL
                  AND dl.assigned_at < NOW() - INTERVAL '1 day'
                  AND NOT EXISTS (SELECT 1 FROM lead_touchpoints t
                      WHERE t.dealer_lead_id = dl.id
                        AND t.performed_by = dl.asm_id
                        AND t.performed_at >= dl.assigned_at) ${lf}`;
        case "address_mismatch":
            return sql`SELECT COUNT(*)::text AS c FROM duplicate_merge_requests
                WHERE status = 'pending' AND request_type LIKE 'address_mismatch%'`;
        case "duplicate_merge_requests":
            return sql`SELECT COUNT(*)::text AS c FROM duplicate_merge_requests
                WHERE status = 'pending' AND request_type = 'phone_collision_manual_edit'`;
        case "out_of_territory_handoffs":
            return sql`SELECT COUNT(*)::text AS c FROM dealer_leads dl
                WHERE dl.lead_status = 'Transferred_to_ASM' AND dl.asm_id IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM asm_territories at
                      WHERE at.asm_id = dl.asm_id
                        AND at.state ILIKE dl.state
                        AND (at.city IS NULL OR at.city ILIKE dl.city)
                        AND (at.active_from IS NULL OR at.active_from <= CURRENT_DATE)
                        AND (at.active_to IS NULL OR at.active_to >= CURRENT_DATE)) ${lf}`;
    }
}

export async function fetchAlertCounts(
    f: DashboardFilters,
): Promise<Record<AlertPanelKey, number>> {
    const lf = leadFilter(f);
    const results = await Promise.all(
        ALERT_PANELS.map((key) => db.execute<{ c: string }>(panelCountSql(key, lf))),
    );
    const out = {} as Record<AlertPanelKey, number>;
    ALERT_PANELS.forEach((key, i) => {
        out[key] = Number(results[i][0]?.c ?? 0);
    });
    return out;
}

export async function fetchAlertPanel(
    key: AlertPanelKey,
    f: DashboardFilters,
    limit = 50,
): Promise<AlertPanelRow[]> {
    const lf = leadFilter(f);

    // Lead-based panels share one SELECT shape.
    const leadPanel = (where: SQL, meta: SQL, order: SQL) =>
        db.execute<AlertPanelRow>(sql`
            SELECT dl.id,
                   COALESCE(dl.dealer_name, dl.shop_name, '(unnamed)') AS primary,
                   CONCAT_WS(', ', dl.city, dl.state) AS secondary,
                   ${meta} AS meta,
                   CONCAT('/inside-sales/lead/', dl.id) AS href
            FROM dealer_leads dl
            WHERE ${where}
            ORDER BY ${order}
            LIMIT ${limit}
        `);

    switch (key) {
        case "no_touch_5d":
        case "no_touch_10d":
        case "awaiting_decision_14d": {
            const threshold =
                key === "no_touch_5d" ? 5 : key === "no_touch_10d" ? 10 : 14;
            const statusFilter =
                key === "awaiting_decision_14d"
                    ? sql`dl.lead_status = 'Awaiting_Customer_Decision'`
                    : sql`dl.lead_status IN (${OPEN_LIST})`;
            const rows = await leadPanel(
                sql`${statusFilter} AND dl.is_active IS NOT FALSE
                    AND ${workingDaysSince(LAST_TOUCH)} > ${sql.raw(String(threshold))} ${lf}`,
                sql`CONCAT(${workingDaysSince(LAST_TOUCH)}, ' working days idle')`,
                sql`${workingDaysSince(LAST_TOUCH)} DESC`,
            );
            return rows as unknown as AlertPanelRow[];
        }
        case "asm_no_activity": {
            const rows = await leadPanel(
                sql`dl.lead_status = 'Transferred_to_ASM' AND dl.asm_id IS NOT NULL
                    AND dl.assigned_at < NOW() - INTERVAL '1 day'
                    AND NOT EXISTS (SELECT 1 FROM lead_touchpoints t
                        WHERE t.dealer_lead_id = dl.id AND t.performed_by = dl.asm_id
                          AND t.performed_at >= dl.assigned_at) ${lf}`,
                sql`CONCAT('handed off ', TO_CHAR(dl.assigned_at, 'DD Mon'))`,
                sql`dl.assigned_at ASC`,
            );
            return rows as unknown as AlertPanelRow[];
        }
        case "out_of_territory_handoffs": {
            const rows = await leadPanel(
                sql`dl.lead_status = 'Transferred_to_ASM' AND dl.asm_id IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM asm_territories at
                        WHERE at.asm_id = dl.asm_id AND at.state ILIKE dl.state
                          AND (at.city IS NULL OR at.city ILIKE dl.city)
                          AND (at.active_from IS NULL OR at.active_from <= CURRENT_DATE)
                          AND (at.active_to IS NULL OR at.active_to >= CURRENT_DATE)) ${lf}`,
                sql`'out of ASM territory'`,
                sql`dl.assigned_at DESC NULLS LAST`,
            );
            return rows as unknown as AlertPanelRow[];
        }
        case "stale_converted": {
            const rows = await db.execute<AlertPanelRow>(sql`
                SELECT dl.id,
                       COALESCE(dl.dealer_name, dl.shop_name, '(unnamed)') AS primary,
                       CONCAT_WS(', ', dl.city, dl.state) AS secondary,
                       CONCAT('onboarding idle since ',
                           TO_CHAR(COALESCE(oa.last_action_at, oa.updated_at), 'DD Mon')) AS meta,
                       CONCAT('/inside-sales/lead/', dl.id) AS href
                FROM dealer_leads dl
                JOIN dealer_onboarding_applications oa
                    ON oa.id = dl.dealer_onboarding_application_id
                WHERE dl.lead_status = 'Converted'
                  AND COALESCE(oa.last_action_at, oa.updated_at) < NOW() - INTERVAL '3 days' ${lf}
                ORDER BY COALESCE(oa.last_action_at, oa.updated_at) ASC
                LIMIT ${limit}
            `);
            return rows as unknown as AlertPanelRow[];
        }
        case "onboarding_dropouts": {
            const rows = await db.execute<AlertPanelRow>(sql`
                SELECT dl.id,
                       COALESCE(dl.dealer_name, dl.shop_name, '(unnamed)') AS primary,
                       CONCAT_WS(', ', dl.city, dl.state) AS secondary,
                       oa.onboarding_status AS meta,
                       '/admin/onboarding-dropouts' AS href
                FROM dealer_leads dl
                JOIN dealer_onboarding_applications oa
                    ON oa.id = dl.dealer_onboarding_application_id
                WHERE dl.lead_status = 'Converted' AND dl.is_active IS NOT FALSE
                  AND dl.onboarding_dropout_reason IS NULL
                  AND (oa.onboarding_status IN ('rejected','withdrawn')
                       OR (oa.onboarding_status IN ('draft','submitted','correction_requested')
                           AND COALESCE(oa.last_action_at, oa.updated_at) < NOW() - INTERVAL '30 days'))
                ORDER BY dl.closed_at ASC NULLS LAST
                LIMIT ${limit}
            `);
            return rows as unknown as AlertPanelRow[];
        }
        case "onboarding_stalled": {
            const rows = await db.execute<AlertPanelRow>(sql`
                SELECT oa.id,
                       COALESCE(oa.company_name, '(unnamed application)') AS primary,
                       CONCAT_WS(', ', oa.city, oa.state) AS secondary,
                       CONCAT(oa.onboarding_status, ' — idle since ',
                           TO_CHAR(COALESCE(oa.last_action_at, oa.updated_at), 'DD Mon')) AS meta,
                       '/admin/onboarding-dropouts' AS href
                FROM dealer_onboarding_applications oa
                WHERE oa.onboarding_status IN ('draft','submitted','correction_requested')
                  AND COALESCE(oa.last_action_at, oa.updated_at) < NOW() - INTERVAL '30 days'
                ORDER BY COALESCE(oa.last_action_at, oa.updated_at) ASC
                LIMIT ${limit}
            `);
            return rows as unknown as AlertPanelRow[];
        }
        case "pending_escalations": {
            const rows = await db.execute<AlertPanelRow>(sql`
                SELECT e.escalation_id AS id,
                       COALESCE(dl.dealer_name, dl.shop_name, '(unnamed)') AS primary,
                       e.escalation_reason AS secondary,
                       UPPER(e.urgency) AS meta,
                       CONCAT('/admin/escalations/', e.escalation_id) AS href
                FROM lead_escalations e
                JOIN dealer_leads dl ON dl.id = e.dealer_lead_id
                WHERE e.status = 'pending_review'
                ORDER BY CASE e.urgency WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
                         e.raised_at ASC
                LIMIT ${limit}
            `);
            return rows as unknown as AlertPanelRow[];
        }
        case "address_mismatch":
        case "duplicate_merge_requests": {
            const typeFilter =
                key === "address_mismatch"
                    ? sql`m.request_type LIKE 'address_mismatch%'`
                    : sql`m.request_type = 'phone_collision_manual_edit'`;
            const rows = await db.execute<AlertPanelRow>(sql`
                SELECT m.id,
                       COALESCE(tl.dealer_name, '(unknown lead)') AS primary,
                       tl.phone AS secondary,
                       m.request_type AS meta,
                       '/admin/merge-requests' AS href
                FROM duplicate_merge_requests m
                LEFT JOIN dealer_leads tl ON tl.id = m.target_lead_id
                WHERE m.status = 'pending' AND ${typeFilter}
                ORDER BY m.created_at ASC
                LIMIT ${limit}
            `);
            return rows as unknown as AlertPanelRow[];
        }
    }
}

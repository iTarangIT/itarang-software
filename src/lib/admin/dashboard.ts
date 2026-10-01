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
import { OPEN_STATUSES, WORKABLE_STATUSES } from "@/lib/lifecycle/transitions";
import type {
    AdminKpis,
    AlertPanelKey,
    AlertPanelRow,
    DashboardFilters,
    TeamPerfRow,
} from "./types";
import { ALERT_PANELS } from "./types";
import { countOnboardingDropouts } from "./listQueries";
import { nonResponsiveSql } from "@/lib/leads/nonResponsive";
import {
    TRANSFER_AT_EXPR,
    TRANSFER_VISIT_OVERDUE_SQL,
    TRANSFER_WORKING_DAYS_SQL,
} from "@/lib/asm/transferVisitLimit";
import {
    AGREEMENT_AWAITING_DEALER,
    DEALER_ONBOARDING_STATUSES,
    STALL_DEALER_DAYS,
    STALL_US_WORKING_DAYS,
} from "@/lib/onboarding/stall";

const OPEN_LIST = sql.raw(OPEN_STATUSES.map((s) => `'${s}'`).join(", "));
// ID 74 — the idle / no-touch lists count only leads the rep can still work;
// a Won lead is waiting on onboarding (see WORKABLE_STATUSES).
const WORKABLE_LIST = sql.raw(WORKABLE_STATUSES.map((s) => `'${s}'`).join(", "));

// ID 74 — Mark Won with no dealer-approved quote: allowed, and flagged. The
// flag (E-314, read through to_jsonb so a DB without it counts 0) only means
// something while the lead is Won / Converted; a re-opened lead keeps the old
// value until its next Mark Won.
const WON_WITHOUT_QUOTE = sql`dl.lead_status IN ('Won', 'Converted')
    AND dl.is_active IS NOT FALSE
    AND (to_jsonb(dl) ->> 'won_without_approved_quote')::boolean IS TRUE`;

// Working days (Mon–Sat) elapsed since a timestamp expression, as a SQL scalar.
function workingDaysSince(expr: string): SQL {
    return sql.raw(`(
        SELECT COUNT(*) FROM generate_series(
            ((${expr})::date + 1), CURRENT_DATE, INTERVAL '1 day'
        ) gs WHERE EXTRACT(DOW FROM gs) <> 0
    )`);
}

// ID 84.3 — onboarding stalled, the same rule as the lead page (src/lib/
// onboarding/stall.ts): waiting on the DEALER (draft / correction requested /
// agreement sent, unsigned) 7+ calendar days, or on US (submitted for review,
// agreement to initiate, re-send or approve) 2+ working days. The "us" clock
// skips holiday_calendar too, like the lead page — a short threshold is where a
// holiday matters. Only leads still open (Won included); a lead already in the
// 21-day drop-out review is listed there instead.
const sqlList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(", ");
const ONB_LAST = "COALESCE(oa.last_action_at, oa.updated_at)";
const ONB_WAITING_ON = sql.raw(`(CASE
    WHEN oa.onboarding_status IN (${sqlList(DEALER_ONBOARDING_STATUSES)}) THEN 'dealer'
    WHEN oa.onboarding_status = 'submitted'
         AND COALESCE(oa.agreement_status, '') IN (${sqlList(AGREEMENT_AWAITING_DEALER)}) THEN 'dealer'
    WHEN oa.onboarding_status = 'submitted' THEN 'us'
END)`);
const ONB_US_WORKING_DAYS = sql.raw(`(
    SELECT COUNT(*) FROM generate_series(
        ((${ONB_LAST})::date + 1), CURRENT_DATE, INTERVAL '1 day'
    ) gs
    WHERE EXTRACT(DOW FROM gs) <> 0
      AND gs::date NOT IN (SELECT hc.holiday_date FROM holiday_calendar hc
                            WHERE hc.is_active IS NOT FALSE AND hc.holiday_date IS NOT NULL)
)`);
// Same predicate as the onboarding_dropouts panel, so a lead is in one or the other.
const IN_DROPOUT_REVIEW = sql`(dl.lead_status IN ('Won', 'Converted')
    AND dl.onboarding_dropout_reason IS NULL
    AND (oa.onboarding_status IN ('rejected','withdrawn')
         OR (oa.onboarding_status IN ('draft','submitted','correction_requested')
             AND ${sql.raw(ONB_LAST)} < NOW() - INTERVAL '21 days'))
    AND COALESCE((to_jsonb(dl) ->> 'onboarding_stalled_at')::timestamptz, 'epoch'::timestamptz)
        < NOW() - INTERVAL '21 days')`;
const ONBOARDING_STALLED = sql`dl.lead_status IN (${OPEN_LIST}) AND dl.is_active IS NOT FALSE
    AND oa.onboarding_status IN ('draft','submitted','correction_requested')
    AND (
        (${ONB_WAITING_ON} = 'dealer'
            AND ${sql.raw(ONB_LAST)} < NOW() - INTERVAL '${sql.raw(String(STALL_DEALER_DAYS))} days')
        OR (${ONB_WAITING_ON} = 'us' AND ${ONB_US_WORKING_DAYS} >= ${sql.raw(String(STALL_US_WORKING_DAYS))})
    )
    AND NOT ${IN_DROPOUT_REVIEW}`;

// ID 75.4 — the dealer approved the quote 2+ days ago and the lead still sits
// at Commercials finalised: nobody pressed Mark Won.
const FINALISED_NOT_WON = sql`dl.lead_status = 'Commercials_Finalised'
    AND dl.is_active IS NOT FALSE
    AND EXISTS (SELECT 1 FROM dealer_lead_commercials c
        WHERE c.dealer_lead_id = dl.id
          AND c.dealer_decision = 'approved'
          AND COALESCE(c.approval_status, 'approved') = 'approved'
          AND c.withdrawn_at IS NULL
          AND c.dealer_decision_at < NOW() - INTERVAL '2 days')`;
const FINALISED_APPROVED_AT = sql`(SELECT MAX(c.dealer_decision_at) FROM dealer_lead_commercials c
    WHERE c.dealer_lead_id = dl.id AND c.dealer_decision = 'approved' AND c.withdrawn_at IS NULL)`;

// The idle clock (E-300, review R-04): last call / visit / status change only.
// last_touchpoint_at also moves on assignment, claims, dial requests and
// comments, so reading it here let a hand-off hide a neglected lead. A lead
// never worked falls back to when its holder got it, then to creation.
const LAST_TOUCH = "COALESCE(dl.last_worked_at, dl.assigned_at, dl.created_at)";

// R-16 — a lead whose number never answers (6 unanswered call days in 45) is not
// "idle": nobody can work it. It is counted in its own panel and kept OUT of
// every stale / no-touch count, which it would otherwise inflate forever.
// ID 36: a lead flagged dead_number / non_responsive (contactability, E-314) is
// out of idle too — it sits in Number Repair. to_jsonb so a DB without E-314
// reads NULL instead of erroring.
const NON_RESPONSIVE = sql`(${nonResponsiveSql(sql`dl.id`)} OR (to_jsonb(dl) ->> 'contactability') IS NOT NULL)`;
const NOT_NON_RESPONSIVE = sql`NOT ${NON_RESPONSIVE}`;

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

    const [counts, firstTouch, conv7, conv30, staleConv, compliance, dropouts, cohort] =
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
                    -- performed_by IS NOT NULL keeps this a HUMAN-activity
                    -- figure. The AI dialer now writes ai_call touchpoints with
                    -- a null performer; without this filter the card would
                    -- silently start counting "worked by a human OR the robot"
                    -- while still sitting in a team-activity block.
                    (SELECT COUNT(DISTINCT t.dealer_lead_id) FROM lead_touchpoints t
                       WHERE t.performed_at::date = CURRENT_DATE
                         AND t.performed_by IS NOT NULL) AS leads_worked_today,
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
                      AND t.performed_at >= dl.assigned_at
                ) ft ON TRUE
                WHERE dl.assigned_at >= NOW() - INTERVAL '7 days'
                  AND ft.first_touch IS NOT NULL ${lf}
            `),
            closedWinRate(7, lf),
            closedWinRate(30, lf),
            db.execute<{ c: string }>(sql`
                SELECT COUNT(*)::text AS c
                FROM dealer_leads dl
                JOIN dealer_onboarding_applications oa
                    ON oa.id = dl.dealer_onboarding_application_id
                -- Won + Converted, the same rows the stale_converted panel lists.
                WHERE dl.lead_status IN ('Won', 'Converted')
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
                      -- Only a HUMAN touchpoint discharges a human's logging
                      -- duty. This KPI is the stated reason the single-writer
                      -- invariant exists (see touchpoints/write.ts); letting an
                      -- AI call that happened to land within the hour satisfy a
                      -- rep's hygiene check would quietly weaken it.
                      AND t.performed_by IS NOT NULL
                      AND t.performed_at BETWEEN h.changed_at - INTERVAL '1 hour'
                                             AND h.changed_at + INTERVAL '1 hour'
                  )
            `),
            countOnboardingDropouts(),
            conversionMeasures(lf),
        ]);

    return {
        unassigned_queue: Number(counts[0]?.unassigned_queue ?? 0),
        avg_time_to_first_touch_hours:
            firstTouch[0]?.hrs != null ? Number(firstTouch[0].hrs) : null,
        leads_worked_today: Number(counts[0]?.leads_worked_today ?? 0),
        ...cohort,
        closed_win_rate_7d: conv7,
        closed_win_rate_30d: conv30,
        pending_escalations: Number(counts[0]?.pending_escalations ?? 0),
        onboarding_dropouts_pending: dropouts,
        stale_converted: Number(staleConv[0]?.c ?? 0),
        compliance_status_without_touchpoint: Number(compliance[0]?.c ?? 0),
    };
}

/**
 * Closed-win rate: Converted ÷ (Converted + Lost) among leads CLOSED in the
 * window. It says how often a decided lead goes our way — not how much of the
 * lead base converts, which is a small fraction of this. It used to be called
 * conversion_rate_7d / _30d and read as the latter (review R-08).
 */
async function closedWinRate(days: number, lf: SQL): Promise<number | null> {
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

/**
 * The three cohort conversion measures (review R-08, metric M27, Change Spec
 * v2.1 §4.3 / §5.6). A cohort is active leads CREATED in a window; every lead
 * counts, including the AI-dialable pool nobody has worked yet — that is the
 * "lead base" the closed-win rate was being mistaken for.
 *
 *   cohort_conversion_to_date   created in the last 30 days, converted so far.
 *                               Always shown as "to date": a young cohort has
 *                               had less time to convert.
 *   conversion_30d_rate         created 31–60 days ago, converted within 30
 *                               days of creation — a full, fixed observation
 *                               window, so months compare fairly.
 *   engaged_to_conversion_rate  created in the last 30 days AND had at least
 *                               one engaged touchpoint (connected call /
 *                               productive visit), converted so far — sales
 *                               effectiveness on leads we actually worked.
 */
async function conversionMeasures(lf: SQL): Promise<{
    cohort_conversion_to_date: number | null;
    conversion_30d_rate: number | null;
    engaged_to_conversion_rate: number | null;
}> {
    const rows = await db.execute<{
        td_cohort: string;
        td_conv: string;
        c30_cohort: string;
        c30_conv: string;
        eng_cohort: string;
        eng_conv: string;
    }>(sql`
        WITH l AS (
            SELECT dl.created_at >= NOW() - INTERVAL '30 days' AS recent,
                   dl.created_at <  NOW() - INTERVAL '30 days' AS mature,
                   dl.lead_status = 'Converted' AS converted,
                   dl.lead_status = 'Converted'
                       AND dl.closed_at <= dl.created_at + INTERVAL '30 days' AS converted_in_30d,
                   EXISTS (SELECT 1 FROM lead_touchpoints t
                            WHERE t.dealer_lead_id = dl.id
                              AND t.is_engaged IS TRUE) AS engaged
            FROM dealer_leads dl
            WHERE dl.is_active IS NOT FALSE
              AND dl.created_at >= NOW() - INTERVAL '60 days' ${lf}
        )
        SELECT
            COUNT(*) FILTER (WHERE recent)::text                          AS td_cohort,
            COUNT(*) FILTER (WHERE recent AND converted)::text            AS td_conv,
            COUNT(*) FILTER (WHERE mature)::text                          AS c30_cohort,
            COUNT(*) FILTER (WHERE mature AND converted_in_30d)::text     AS c30_conv,
            COUNT(*) FILTER (WHERE recent AND engaged)::text              AS eng_cohort,
            COUNT(*) FILTER (WHERE recent AND engaged AND converted)::text AS eng_conv
        FROM l
    `);
    const r = rows[0];
    const rate = (a: unknown, b: unknown): number | null =>
        Number(b ?? 0) > 0 ? Number(a ?? 0) / Number(b) : null;
    return {
        cohort_conversion_to_date: rate(r?.td_conv, r?.td_cohort),
        conversion_30d_rate: rate(r?.c30_conv, r?.c30_cohort),
        engaged_to_conversion_rate: rate(r?.eng_conv, r?.eng_cohort),
    };
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
                     AND t.performed_at >= dl.assigned_at
               ) ft ON TRUE
               WHERE dl.originator_id = u.id::text
                 AND ft.first_touch IS NOT NULL) AS avg_time_to_first_touch_hours,
            (SELECT ROUND(
                COUNT(*) FILTER (WHERE dl.lead_status = 'Converted')::numeric
                / NULLIF(COUNT(*) FILTER (WHERE dl.lead_status IN ('Converted','Lost')), 0), 3)
               FROM dealer_leads dl
               WHERE dl.closing_owner_id = u.id::text
                 AND dl.closed_at >= NOW() - INTERVAL '30 days') AS closed_win_rate_30d,
            (SELECT COUNT(*) FROM dealer_leads dl
               WHERE dl.current_owner_id = u.id::text
                 AND dl.lead_status IN (${WORKABLE_LIST})
                 AND dl.is_active IS NOT FALSE
                 AND ${workingDaysSince(LAST_TOUCH)} > 5
                 AND ${NOT_NON_RESPONSIVE}) AS stale_leads,
            (SELECT COUNT(*) FROM dealer_leads dl
               WHERE dl.current_owner_id = u.id::text
                 AND dl.lead_status IN (${WORKABLE_LIST})
                 AND dl.is_active IS NOT FALSE
                 AND ${workingDaysSince(LAST_TOUCH)} > 10
                 AND ${NOT_NON_RESPONSIVE}) AS critical_stale,
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
        closed_win_rate_30d:
            r.closed_win_rate_30d != null ? Number(r.closed_win_rate_30d) : null,
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
                WHERE dl.lead_status IN (${WORKABLE_LIST}) AND dl.is_active IS NOT FALSE
                  AND ${workingDaysSince(LAST_TOUCH)} > 5 AND ${NOT_NON_RESPONSIVE} ${lf}`;
        case "no_touch_10d":
            return sql`SELECT COUNT(*)::text AS c FROM dealer_leads dl
                WHERE dl.lead_status IN (${WORKABLE_LIST}) AND dl.is_active IS NOT FALSE
                  AND ${workingDaysSince(LAST_TOUCH)} > 10 AND ${NOT_NON_RESPONSIVE} ${lf}`;
        case "non_responsive":
            return sql`SELECT COUNT(*)::text AS c FROM dealer_leads dl
                WHERE dl.lead_status IN (${OPEN_LIST}) AND dl.is_active IS NOT FALSE
                  AND ${NON_RESPONSIVE} ${lf}`;
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
                WHERE dl.lead_status IN ('Won', 'Converted') AND dl.is_active IS NOT FALSE
                  AND dl.onboarding_dropout_reason IS NULL
                  AND (oa.onboarding_status IN ('rejected','withdrawn')
                       OR (oa.onboarding_status IN ('draft','submitted','correction_requested')
                           AND COALESCE(oa.last_action_at, oa.updated_at) < NOW() - INTERVAL '21 days'))
                  AND COALESCE((to_jsonb(dl) ->> 'onboarding_stalled_at')::timestamptz, 'epoch'::timestamptz)
                      < NOW() - INTERVAL '21 days'`;
        case "won_without_quote":
            return sql`SELECT COUNT(*)::text AS c FROM dealer_leads dl
                WHERE ${WON_WITHOUT_QUOTE} ${lf}`;
        case "stale_converted":
            return sql`SELECT COUNT(*)::text AS c FROM dealer_leads dl
                JOIN dealer_onboarding_applications oa
                    ON oa.id = dl.dealer_onboarding_application_id
                WHERE dl.lead_status IN ('Won', 'Converted')
                  AND COALESCE(oa.last_action_at, oa.updated_at) < NOW() - INTERVAL '3 days' ${lf}`;
        case "onboarding_stalled":
            return sql`SELECT COUNT(*)::text AS c FROM dealer_leads dl
                JOIN dealer_onboarding_applications oa
                    ON oa.id = dl.dealer_onboarding_application_id
                WHERE ${ONBOARDING_STALLED} ${lf}`;
        case "transfer_visit_overdue":
            return sql`SELECT COUNT(*)::text AS c FROM dealer_leads dl
                WHERE ${TRANSFER_VISIT_OVERDUE_SQL} ${lf}`;
        case "finalised_not_won":
            return sql`SELECT COUNT(*)::text AS c FROM dealer_leads dl
                WHERE ${FINALISED_NOT_WON} ${lf}`;
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
                    : sql`dl.lead_status IN (${WORKABLE_LIST})`;
            const rows = await leadPanel(
                sql`${statusFilter} AND dl.is_active IS NOT FALSE
                    AND ${workingDaysSince(LAST_TOUCH)} > ${sql.raw(String(threshold))}
                    ${key === "awaiting_decision_14d" ? sql`` : sql`AND ${NOT_NON_RESPONSIVE}`} ${lf}`,
                sql`CONCAT(${workingDaysSince(LAST_TOUCH)}, ' working days idle')`,
                sql`${workingDaysSince(LAST_TOUCH)} DESC`,
            );
            return rows as unknown as AlertPanelRow[];
        }
        case "non_responsive": {
            const rows = await leadPanel(
                sql`dl.lead_status IN (${OPEN_LIST}) AND dl.is_active IS NOT FALSE
                    AND ${NON_RESPONSIVE} ${lf}`,
                sql`CONCAT(${workingDaysSince(LAST_TOUCH)}, ' working days since last worked · no call answered in 45 days')`,
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
        case "won_without_quote": {
            const rows = await leadPanel(
                sql`${WON_WITHOUT_QUOTE} ${lf}`,
                sql`CONCAT(REPLACE(dl.lead_status, '_', ' '), ' on ',
                        TO_CHAR((to_jsonb(dl) ->> 'won_at')::timestamptz AT TIME ZONE 'Asia/Kolkata', 'DD Mon'),
                        ' · no dealer-approved quote')`,
                sql`(to_jsonb(dl) ->> 'won_at')::timestamptz DESC NULLS LAST`,
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
                WHERE dl.lead_status IN ('Won', 'Converted')
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
                WHERE dl.lead_status IN ('Won', 'Converted') AND dl.is_active IS NOT FALSE
                  AND dl.onboarding_dropout_reason IS NULL
                  AND (oa.onboarding_status IN ('rejected','withdrawn')
                       OR (oa.onboarding_status IN ('draft','submitted','correction_requested')
                           AND COALESCE(oa.last_action_at, oa.updated_at) < NOW() - INTERVAL '21 days'))
                  AND COALESCE((to_jsonb(dl) ->> 'onboarding_stalled_at')::timestamptz, 'epoch'::timestamptz)
                      < NOW() - INTERVAL '21 days'
                ORDER BY dl.closed_at ASC NULLS LAST
                LIMIT ${limit}
            `);
            return rows as unknown as AlertPanelRow[];
        }
        case "onboarding_stalled": {
            const rows = await db.execute<AlertPanelRow>(sql`
                SELECT dl.id,
                       COALESCE(dl.dealer_name, dl.shop_name, oa.company_name, '(unnamed)') AS primary,
                       CONCAT_WS(', ', dl.city, dl.state) AS secondary,
                       CONCAT(
                           CASE ${ONB_WAITING_ON} WHEN 'dealer' THEN 'Stalled · waiting on dealer'
                                                  ELSE 'Stalled · waiting on us' END,
                           ' · ', REPLACE(oa.onboarding_status, '_', ' '),
                           ' · idle since ', TO_CHAR(${sql.raw(ONB_LAST)}, 'DD Mon')) AS meta,
                       CONCAT('/inside-sales/lead/', dl.id) AS href
                FROM dealer_leads dl
                JOIN dealer_onboarding_applications oa
                    ON oa.id = dl.dealer_onboarding_application_id
                WHERE ${ONBOARDING_STALLED} ${lf}
                ORDER BY ${sql.raw(ONB_LAST)} ASC
                LIMIT ${limit}
            `);
            return rows as unknown as AlertPanelRow[];
        }
        case "transfer_visit_overdue": {
            const rows = await leadPanel(
                sql`${TRANSFER_VISIT_OVERDUE_SQL} ${lf}`,
                sql`CONCAT('transferred ',
                        TO_CHAR((${sql.raw(TRANSFER_AT_EXPR)}) AT TIME ZONE 'Asia/Kolkata', 'DD Mon'),
                        ' · ', ${TRANSFER_WORKING_DAYS_SQL}, ' working days, no visit')`,
                sql`${TRANSFER_WORKING_DAYS_SQL} DESC`,
            );
            return rows as unknown as AlertPanelRow[];
        }
        case "finalised_not_won": {
            const rows = await leadPanel(
                sql`${FINALISED_NOT_WON} ${lf}`,
                sql`CONCAT('dealer approved ',
                        TO_CHAR(${FINALISED_APPROVED_AT} AT TIME ZONE 'Asia/Kolkata', 'DD Mon'),
                        ' · not marked Won')`,
                sql`${FINALISED_APPROVED_AT} ASC NULLS LAST`,
            );
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

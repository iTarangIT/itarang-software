/**
 * Tracker ID 88 #2 / #4 — the Sales dashboard (SalesHeadOpsView) figures that
 * used to read "not tracked yet". Every one is read from rows the CRM already
 * writes; nothing here adds a table.
 *
 *   speed        Handoffs card. sales-ready → first owner (lead_clocks: the
 *                lead clock's start, sales_ready_at, to the first owner clock
 *                that started at or after it), owner → first attempt (owner
 *                clock) and transfer → first visit (transfer clock), all in
 *                working hours (Mon–Sat 10–19 IST, holidays off) — the same
 *                clocks as the Response time card (ID 86, E-337).
 *   stuck        "Where open leads are sitting" › Stuck over 7 days. Open leads
 *                (OPEN_STATUSES, active) per current owner and stage, in that
 *                stage for more than 7 calendar days: since the latest
 *                status-history row that moved the lead INTO its current
 *                status, else since assignment / creation.
 *   calling      Calling card. Per person who did it, in the period: human
 *                calls, engaged calls (engagedCall — a connected call) and
 *                WhatsApp contacts that count (dealer replied + a fresh
 *                screenshot, ID 79: touchpoint_type 'whatsapp', is_engaged).
 *   field        Field card. Per ASM, visits marked visited in the period:
 *                verified (a shop photo AND a location pin on the visit) and
 *                productive (outcome productive / commercials progressed —
 *                ENGAGED_OUTCOMES).
 *   quotes       Quotes card boxes. Each lead's latest quote (quote_issue /
 *                quote_revision) created in the period, by where it stands:
 *                waiting for CEO approval, refused by us, approved but not
 *                delivered, delivered with no answer, dealer said yes, dealer
 *                declined, withdrawn.
 *   lost_stage   "Why we lost" › the stage a lead was lost at: the status it
 *                left when it moved to Lost (dealer_lead_status_history),
 *                for the same leads the Lost report counts as "Sales lost".
 *   batteries    Scorecard fallback when invoices carry no item lines (ID 88
 *                #4): battery units on the dealer-approved quote of each lead
 *                behind a line-less invoice in the period, credited like
 *                revenue (account owner on the invoice date). An estimate,
 *                labelled as such — never added into the invoice count.
 *
 * Each block is built on its own and is `null` when its source is missing on
 * this database, so one failure never blanks the others.
 */
import { sql, type SQL } from "drizzle-orm";
import { businessTypeFilterParam } from "@/lib/leads/businessType";

import { db } from "@/lib/db";
import { OPEN_STATUSES, LOST_REASON } from "@/lib/lifecycle/transitions";
import { engagedCall, humanCall } from "@/lib/reports/metricDefinitions";
import { leadScopeSql, type LeadScopeFilters } from "@/lib/leads/leadScopeSql";
import { clockStats, hasLeadClocks, type ClockStats } from "@/lib/leads/clocks";
import { medianAndP90 } from "@/lib/leads/clockRules";
import { workingMinutesBetween } from "@/lib/leads/workingHours";
import { loadOfficeCalendar } from "@/lib/calendar/holidays";
import { matchedLinesUnion, matchedUnion, REVENUE_NOT_VOID } from "@/lib/dashboard/revenueSource";
import { ENGAGED_OUTCOMES } from "@/lib/asm/types";
import { dealerLeadByGstin, GSTIN_KEY } from "@/lib/leads/gstinMatch";
import { STUCK_DAYS } from "@/lib/dashboard/salesHeadMeasureFormat";

export type MeasureFilters = LeadScopeFilters & {
    /** IST days, inclusive. */
    from: string;
    to: string;
    /** One person (the screen's Person filter). */
    spoc_id?: string | null;
};

export type SpeedMeasures = {
    /** Sales-ready → first owner, over leads that became sales-ready in the period. */
    ready_to_assigned: { median_h: number | null; p90_h: number | null; assigned: number; waiting: number };
    /** Each assignment → that owner's first call or visit (owner clock). */
    assigned_to_attempt: { median_h: number | null; p90_h: number | null; started: number };
    /** Transfer to ASM → first visit marked visited (transfer clock). */
    transfer_to_visit: { median_h: number | null; p90_h: number | null; started: number };
};

export type StuckRow = { owner_id: string; owner: string; role: string | null; by_stage: Record<string, number>; total: number };
export type CallingRow = { user_id: string; calls: number; engaged: number; whatsapp: number };
export type FieldRow = { user_id: string; visited: number; verified: number; productive: number };
export type QuoteBoxes = {
    waiting_approval: number;
    refused_by_us: number;
    approved_not_sent: number;
    delivered_no_answer: number;
    dealer_yes: number;
    dealer_declined: number;
    withdrawn: number;
    total: number;
};
export type LostStageRow = { stage: string; n: number };
export type BatteryFallback = { spoc: string; leads: number; units: number };

export type SalesHeadMeasures = {
    speed: SpeedMeasures | null;
    stuck: StuckRow[] | null;
    calling: CallingRow[] | null;
    field: FieldRow[] | null;
    quotes: QuoteBoxes | null;
    lost_stage: LostStageRow[] | null;
    /** Keyed by the person the revenue is credited to. */
    batteries: BatteryFallback[] | null;
};

const IST = "Asia/Kolkata";
type Raw = Record<string, unknown>;
const run = async (q: SQL) => (await db.execute(q)) as unknown as Raw[];
const n = (v: unknown) => Number(v ?? 0);
const onIstDays = (ts: SQL, f: MeasureFilters) => sql`(${ts} AT TIME ZONE ${IST})::date BETWEEN ${f.from}::date AND ${f.to}::date`;
const hours = (m: number | null) => (m == null ? null : Math.round((m / 60) * 10) / 10);
const list = (values: readonly string[]) => sql.raw(values.map((s) => `'${s.replace(/'/g, "''")}'`).join(", "));
/** `AND col = spoc` when one person is picked. */
const person = (col: SQL, f: MeasureFilters) => (f.spoc_id ? sql` AND (${col})::text = ${f.spoc_id}` : sql``);

// ── Speed ────────────────────────────────────────────────────────────────────

async function speed(f: MeasureFilters): Promise<SpeedMeasures | null> {
    if (!(await hasLeadClocks())) return null;
    // A person picked: assignments TO that person; the waiting count is a team
    // figure (nobody owns those leads), so it stays whole-team.
    const pairs = await run(sql`
        SELECT l.dealer_lead_id, l.started_at AS ready_at, o.started_at AS assigned_at
          FROM lead_clocks l
          JOIN dealer_leads dl ON dl.id = l.dealer_lead_id
          LEFT JOIN LATERAL (
              SELECT oc.started_at, oc.owner_id FROM lead_clocks oc
               WHERE oc.dealer_lead_id = l.dealer_lead_id AND oc.clock = 'owner' AND oc.started_at >= l.started_at
               ORDER BY oc.started_at
               LIMIT 1
          ) o ON TRUE
         WHERE l.clock = 'lead' AND l.start_inferred IS NOT TRUE
           AND ${onIstDays(sql`l.started_at`, f)} ${leadScopeSql(f)}
           ${f.spoc_id ? sql` AND (o.owner_id IS NULL OR o.owner_id = ${f.spoc_id})` : sql``}`);
    const { holidays, hours: officeHours } = await loadOfficeCalendar();
    const assignedRows = pairs.filter((p) => p.assigned_at != null);
    const minutes = assignedRows.map((p) =>
        workingMinutesBetween(new Date(String(p.ready_at)), new Date(String(p.assigned_at)), holidays, officeHours),
    );
    const ready = medianAndP90(minutes);
    const owners = f.spoc_id ? { ownerIds: [f.spoc_id] } : {};
    const [owner, transfer] = await Promise.all([
        clockStats("owner", f.from, f.to, owners),
        clockStats("transfer", f.from, f.to, owners),
    ]);
    const asSpeed = (s: ClockStats | null) => ({ median_h: s?.attempt_median_h ?? null, p90_h: s?.attempt_p90_h ?? null, started: s?.started ?? 0 });
    return {
        ready_to_assigned: {
            median_h: hours(ready.median),
            p90_h: hours(ready.p90),
            assigned: assignedRows.length,
            waiting: f.spoc_id ? 0 : pairs.filter((p) => p.assigned_at == null).length,
        },
        assigned_to_attempt: asSpeed(owner),
        transfer_to_visit: asSpeed(transfer),
    };
}

// ── Stuck over 7 days ────────────────────────────────────────────────────────

async function stuck(f: MeasureFilters): Promise<StuckRow[]> {
    const rows = await run(sql`
        SELECT dl.current_owner_id::text AS owner_id, COALESCE(u.name, u.email, '(unknown)') AS owner, u.role,
               dl.lead_status AS stage, COUNT(*)::int AS n
          FROM dealer_leads dl
          LEFT JOIN users u ON u.id::text = dl.current_owner_id::text
          LEFT JOIN LATERAL (
              SELECT MAX(h.changed_at) AS at FROM dealer_lead_status_history h
               WHERE h.dealer_lead_id = dl.id AND h.to_status = dl.lead_status
          ) s ON TRUE
         WHERE dl.current_owner_id IS NOT NULL
           AND dl.is_active IS NOT FALSE
           AND dl.lead_status IN (${list(OPEN_STATUSES)})
           AND COALESCE(s.at, dl.assigned_at, dl.created_at AT TIME ZONE 'UTC') < NOW() - make_interval(days => ${STUCK_DAYS})
           ${leadScopeSql(f)} ${person(sql`dl.current_owner_id`, f)}
         GROUP BY 1, 2, 3, 4`);
    const byOwner = new Map<string, StuckRow>();
    for (const r of rows) {
        const id = String(r.owner_id);
        const row = byOwner.get(id) ?? { owner_id: id, owner: String(r.owner), role: r.role == null ? null : String(r.role), by_stage: {}, total: 0 };
        row.by_stage[String(r.stage)] = n(r.n);
        row.total += n(r.n);
        byOwner.set(id, row);
    }
    return [...byOwner.values()].sort((a, b) => b.total - a.total);
}

// ── Calling: engaged and WhatsApp ────────────────────────────────────────────

async function calling(f: MeasureFilters): Promise<CallingRow[]> {
    const rows = await run(sql`
        SELECT t.performed_by AS u,
               COUNT(*) FILTER (WHERE t.touchpoint_type = 'inside_sales_call' AND ${humanCall()})::int AS calls,
               COUNT(*) FILTER (WHERE t.touchpoint_type = 'inside_sales_call' AND ${engagedCall()})::int AS engaged,
               COUNT(*) FILTER (WHERE t.touchpoint_type = 'whatsapp' AND t.is_engaged IS TRUE)::int AS whatsapp
          FROM lead_touchpoints t
          JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
         WHERE t.touchpoint_type IN ('inside_sales_call', 'whatsapp') AND t.performed_by IS NOT NULL
           AND ${onIstDays(sql`t.performed_at`, f)} ${leadScopeSql(f)} ${person(sql`t.performed_by`, f)}
         GROUP BY 1`);
    return rows.map((r) => ({ user_id: String(r.u), calls: n(r.calls), engaged: n(r.engaged), whatsapp: n(r.whatsapp) }));
}

// ── Field: verified and productive visits ────────────────────────────────────

async function field(f: MeasureFilters): Promise<FieldRow[]> {
    const rows = await run(sql`
        SELECT v.asm_id AS u,
               COUNT(*)::int AS visited,
               COUNT(*) FILTER (WHERE jsonb_typeof(v.photos) = 'array' AND jsonb_array_length(v.photos) > 0
                                  AND v.gps_check_in_lat IS NOT NULL AND v.gps_check_in_lng IS NOT NULL)::int AS verified,
               COUNT(*) FILTER (WHERE v.visit_outcome IN (${list(ENGAGED_OUTCOMES)}))::int AS productive
          FROM lead_visits v
          JOIN dealer_leads dl ON dl.id = v.dealer_lead_id
         WHERE v.visit_status = 'visited'
           AND COALESCE(v.actual_visit_date, (v.updated_at AT TIME ZONE ${IST})::date) BETWEEN ${f.from}::date AND ${f.to}::date
           ${leadScopeSql(f)} ${person(sql`v.asm_id`, f)}
         GROUP BY 1`);
    return rows.map((r) => ({ user_id: String(r.u), visited: n(r.visited), verified: n(r.verified), productive: n(r.productive) }));
}

// ── Quote boxes ──────────────────────────────────────────────────────────────

async function quotes(f: MeasureFilters): Promise<QuoteBoxes> {
    const [r] = await run(sql`
        WITH latest AS (
            SELECT DISTINCT ON (c.dealer_lead_id) c.*
              FROM dealer_lead_commercials c
              JOIN dealer_leads dl ON dl.id = c.dealer_lead_id
             WHERE c.event_type IN ('quote_issue', 'quote_revision') ${leadScopeSql(f)}
             ORDER BY c.dealer_lead_id, c.version_no DESC
        ),
        q AS (
            SELECT l.*, EXISTS (SELECT 1 FROM quotation_dispatches x
                                 WHERE x.commercial_id = l.commercial_id AND x.status = 'sent') AS sent
              FROM latest l
             WHERE ${onIstDays(sql`l.created_at`, f)} ${person(sql`l.created_by`, f)}
        )
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE withdrawn_at IS NOT NULL)::int AS withdrawn,
               COUNT(*) FILTER (WHERE withdrawn_at IS NULL AND approval_status = 'pending')::int AS waiting_approval,
               COUNT(*) FILTER (WHERE withdrawn_at IS NULL AND approval_status = 'rejected')::int AS refused_by_us,
               COUNT(*) FILTER (WHERE withdrawn_at IS NULL AND dealer_decision = 'approved')::int AS dealer_yes,
               COUNT(*) FILTER (WHERE withdrawn_at IS NULL AND dealer_decision = 'declined')::int AS dealer_declined,
               COUNT(*) FILTER (WHERE withdrawn_at IS NULL AND dealer_decision IS NULL
                                  AND COALESCE(approval_status, 'approved') = 'approved' AND sent)::int AS delivered_no_answer,
               COUNT(*) FILTER (WHERE withdrawn_at IS NULL AND dealer_decision IS NULL
                                  AND COALESCE(approval_status, 'approved') = 'approved' AND NOT sent)::int AS approved_not_sent
          FROM q`);
    return {
        waiting_approval: n(r?.waiting_approval),
        refused_by_us: n(r?.refused_by_us),
        approved_not_sent: n(r?.approved_not_sent),
        delivered_no_answer: n(r?.delivered_no_answer),
        dealer_yes: n(r?.dealer_yes),
        dealer_declined: n(r?.dealer_declined),
        withdrawn: n(r?.withdrawn),
        total: n(r?.total),
    };
}

// ── Stage lost at ────────────────────────────────────────────────────────────

async function lostStage(f: MeasureFilters): Promise<LostStageRow[]> {
    // The Lost report's "Sales lost" population (admin/reports.ts lostAnalysis):
    // lead_status Lost, closed in the period, a sales lost reason.
    const reasons = LOST_REASON.filter((r) => r !== "onboarding_dropout");
    const rows = await run(sql`
        SELECT COALESCE(h.from_status, 'Unknown') AS stage, COUNT(*)::int AS n
          FROM dealer_leads dl
          LEFT JOIN LATERAL (
              SELECT x.from_status FROM dealer_lead_status_history x
               WHERE x.dealer_lead_id = dl.id AND x.to_status = 'Lost'
                 AND x.from_status IS DISTINCT FROM 'Lost'
               ORDER BY x.changed_at DESC
               LIMIT 1
          ) h ON TRUE
         WHERE dl.lead_status = 'Lost'
           AND dl.lost_reason IN (${list(reasons)})
           AND dl.closed_at IS NOT NULL AND ${onIstDays(sql`dl.closed_at`, f)}
           ${leadScopeSql(f)}
         GROUP BY 1
         ORDER BY 2 DESC`);
    return rows.map((r) => ({ stage: String(r.stage), n: n(r.n) }));
}

// ── Batteries when invoice lines are missing ─────────────────────────────────

async function batteries(f: MeasureFilters): Promise<BatteryFallback[] | null> {
    // Only meaningful where invoice item lines exist as a source at all (E-322).
    if (!(await matchedLinesUnion())) return null;
    const invoices = await matchedUnion();
    const owner = sql`r.dealer_owner_id`;
    const rows = await run(sql`
        WITH lineless AS (
            -- An invoice matched to a dealer ACCOUNT (E-321) carries no lead;
            -- the account's GSTIN finds it, the same rule the invoice match uses.
            SELECT DISTINCT ${owner}::text AS spoc, COALESCE(r.dealer_lead_id, m.dealer_lead_id) AS dealer_lead_id
              FROM ${invoices} AS r
              LEFT JOIN accounts a ON a.id::text = r.account_id::text
              LEFT JOIN ${dealerLeadByGstin(GSTIN_KEY(sql`a.gstin`))} m ON r.dealer_lead_id IS NULL
              LEFT JOIN dealer_leads dl ON dl.id = COALESCE(r.dealer_lead_id, m.dealer_lead_id)
             WHERE ${REVENUE_NOT_VOID}
               AND COALESCE(r.dealer_lead_id, m.dealer_lead_id) IS NOT NULL AND ${owner} IS NOT NULL
               AND r.invoice_date >= ${f.from}::date AND r.invoice_date <= ${f.to}::date
               AND NOT EXISTS (
                   SELECT 1 FROM invoice_line_items li
                    WHERE li.invoice_id = r.id
                      AND (li.source = r.source OR (r.source = 'drive' AND li.source IN ('vyapar', 'drive'))))
               ${leadScopeSql(f)} ${person(owner, f)}
        )
        SELECT x.spoc, COUNT(*)::int AS leads, COALESCE(SUM(q.units), 0)::int AS units
          FROM lineless x
          CROSS JOIN LATERAL (
              SELECT COALESCE(SUM(CASE WHEN (pl ->> 'quantity') ~ '^[0-9]+(\\.[0-9]+)?$'
                                       THEN (pl ->> 'quantity')::numeric ELSE 0 END), 0) AS units
                FROM (
                    SELECT c.product_lines FROM dealer_lead_commercials c
                     WHERE c.dealer_lead_id = x.dealer_lead_id
                       AND c.event_type IN ('quote_issue', 'quote_revision')
                       AND c.dealer_decision = 'approved' AND c.withdrawn_at IS NULL
                     ORDER BY c.version_no DESC
                     LIMIT 1
                ) c
                CROSS JOIN LATERAL jsonb_array_elements(
                    CASE WHEN jsonb_typeof(c.product_lines) = 'array' THEN c.product_lines ELSE '[]'::jsonb END) pl
               WHERE pl ->> 'asset_type' = 'battery'
          ) q
         GROUP BY 1`);
    return rows.map((r) => ({ spoc: String(r.spoc), leads: n(r.leads), units: n(r.units) }));
}

// ── Assembly ─────────────────────────────────────────────────────────────────

async function safe<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    try {
        return await fn();
    } catch (e) {
        console.warn(`[salesHeadMeasures] ${label} skipped:`, e instanceof Error ? e.message : e);
        return null;
    }
}

export const MEASURE_BUILDERS = { speed, stuck, calling, field, quotes, lost_stage: lostStage, batteries } as const;

export async function salesHeadMeasures(f: MeasureFilters): Promise<SalesHeadMeasures> {
    const [s, st, c, fi, q, l, b] = await Promise.all([
        safe("speed", () => speed(f)),
        safe("stuck", () => stuck(f)),
        safe("calling", () => calling(f)),
        safe("field", () => field(f)),
        safe("quotes", () => quotes(f)),
        safe("lost_stage", () => lostStage(f)),
        safe("batteries", () => batteries(f)),
    ]);
    return { speed: s, stuck: st, calling: c, field: fi, quotes: q, lost_stage: l, batteries: b };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** The screen's URL filters; null when the dates are missing or malformed. */
export function measureFiltersFrom(p: URLSearchParams): MeasureFilters | null {
    const from = p.get("from") ?? "";
    const to = p.get("to") ?? "";
    if (!ISO.test(from) || !ISO.test(to) || from > to) return null;
    const opt = (k: string) => p.get(k)?.trim() || null;
    // ID 11: an old link's "finance" reads as Battery sale, as on the dashboard.
    const bt = opt("business_type");
    return { from, to, state: opt("state"), city: opt("city"), business_type: businessTypeFilterParam(bt) ?? bt, spoc_id: opt("spoc_id") };
}

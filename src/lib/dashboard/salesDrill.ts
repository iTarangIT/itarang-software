/**
 * The rows behind a number on the Sales dashboard (SalesHeadOpsView) — every
 * card other than "Needs action now" (salesHeadActions.ts) and "Where open
 * leads are sitting" (admin/reports.ts ownerMetricLeads), which have their own.
 *
 * ONE RULE: each kind repeats the WHERE of the query that counts it, so the
 * list behind a cell has exactly as many rows as the cell says:
 *
 *   Calling (inside sales)   calls / dealers_called / new_hot / converted —
 *                            salesDashboard.ts queryTotals; engaged / whatsapp —
 *                            salesHeadMeasures.ts calling()
 *   Field (ASM)              visits / dealers_visited / new_dealers —
 *                            queryTotals; verified / productive — field();
 *                            planned_today — querySnapshot; kyc_submitted —
 *                            queryOutcome
 *   Handoffs to field        handoffs / handoff_converted — reports.ts asmHandoff
 *   Quotes in progress       quotes_issued / quote_revisions — queryOutcome;
 *                            waiting_approval … dealer_declined — quotes()
 *   Why we lost              lost_reason — reports.ts lostAnalysis; lost_stage —
 *                            lostStage()
 *   Ecofy leads              ecofy_all / ecofy_open / ecofy_queue / ecofy_stage —
 *                            api/ecofy/stage-summary
 *
 * Accounts by owner reads rows the page already holds (listDealerHealth), so it
 * has no kind here. scripts/verify-sales-drill.ts checks every count.
 */
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { leadScopeSql } from "@/lib/leads/leadScopeSql";
import { engagedCall, humanCall, isFirstQuote } from "@/lib/reports/metricDefinitions";
import { asmTransferRecipientFromVisitSql } from "@/lib/leads/closingOwner";
import { accountOwnerOn, dealerLeadByGstin, GSTIN_KEY } from "@/lib/leads/gstinMatch";
import { hasAccountOwnershipTables } from "@/lib/accounts/tables";
import { ENGAGED_OUTCOMES } from "@/lib/asm/types";
import { LOST_REASON } from "@/lib/lifecycle/transitions";

export const DRILL_KINDS = [
    // Calling (inside sales) — per person
    "calls",
    "dealers_called",
    "engaged",
    "whatsapp",
    "new_hot",
    "converted",
    // Field (ASM) — per person
    "visits",
    // ID 185 — visits split on the person's basis.
    "fresh_visits",
    "repeat_visits",
    "dealers_visited",
    "new_dealers",
    "verified",
    "productive",
    "planned_today",
    "kyc_submitted",
    // Handoffs to field — per ASM
    "handoffs",
    "handoff_converted",
    // Quotes in progress — whole screen (Person filter applies)
    "quotes_issued",
    "quote_revisions",
    "waiting_approval",
    "delivered_no_answer",
    "dealer_yes",
    "dealer_declined",
    // Why we lost — by reason / stage
    "lost_reason",
    "lost_stage",
    // Ecofy (separate pipeline)
    "ecofy_all",
    "ecofy_open",
    "ecofy_queue",
    "ecofy_stage",
] as const;
export type DrillKind = (typeof DRILL_KINDS)[number];

export const ECOFY_DRILL_KINDS: readonly DrillKind[] = ["ecofy_all", "ecofy_open", "ecofy_queue", "ecofy_stage"];

export const DRILL_TITLES: Record<DrillKind, string> = {
    calls: "Calls",
    dealers_called: "Dealers called",
    engaged: "Engaged calls",
    whatsapp: "WhatsApp contacts",
    new_hot: "New Hot leads",
    converted: "Converted",
    visits: "Visits",
    dealers_visited: "Dealers visited",
    new_dealers: "New dealers visited",
    fresh_visits: "Fresh visits (first visit by this person to the dealer)",
    repeat_visits: "Repeat visits (this person had visited the dealer before)",
    verified: "Verified visits",
    productive: "Productive visits",
    planned_today: "Visits planned today",
    kyc_submitted: "KYC submitted",
    handoffs: "Handoffs",
    handoff_converted: "Handoffs converted",
    quotes_issued: "Quotes issued",
    quote_revisions: "Revised quotes",
    waiting_approval: "Quotes waiting for approval",
    delivered_no_answer: "Quotes delivered, no answer",
    dealer_yes: "Quotes the dealer said yes to",
    dealer_declined: "Quotes the dealer declined",
    lost_reason: "Lost",
    lost_stage: "Lost at stage",
    ecofy_all: "Ecofy leads — all",
    ecofy_open: "Ecofy leads — open",
    ecofy_queue: "Ecofy leads — pickup queue",
    ecofy_stage: "Ecofy leads — stage",
};

export type DrillFilters = {
    /** IST days, inclusive. */
    from: string;
    to: string;
    state?: string | null;
    city?: string | null;
    business_type?: string | null;
    /** The screen's Person filter. */
    spoc_id?: string | null;
};

export type DrillRow = {
    /** dealer_leads.id (or the customer lead / Ecofy lead id for those kinds). */
    id: string;
    /** Where the name links to. */
    href: string | null;
    name: string;
    phone: string | null;
    city: string | null;
    state: string | null;
    status: string | null;
    rating: string | null;
    /** Whose number the row counts toward. */
    person_id: string | null;
    person_name: string | null;
    owner_name: string | null;
    /** When the counted event happened (call, visit, quote, close …). */
    at: string | null;
    detail: string | null;
};

/** Sentinel for "no person" rows, e.g. the Unassigned line of Handoffs. */
export const NO_PERSON = "__none__";

const IST = "Asia/Kolkata";
const onIstDays = (ts: SQL, f: DrillFilters) => sql`((${ts}) AT TIME ZONE ${IST})::date BETWEEN ${f.from}::date AND ${f.to}::date`;
const list = (values: readonly string[]) => sql.raw(values.map((s) => `'${s.replace(/'/g, "''")}'`).join(", "));

/**
 * Who the rows are for: the people asked for (a cell = one, a column = many),
 * else the screen's Person filter, else everyone. `col` is the count's own rep
 * column. "__none__" asks for the rows nobody is credited with.
 */
function who(col: SQL, f: DrillFilters, persons: string[] | null): SQL {
    const ids = persons?.filter(Boolean) ?? [];
    if (ids.length) {
        const named = ids.filter((i) => i !== NO_PERSON);
        const parts: SQL[] = [];
        if (named.length) parts.push(sql`(${col})::text IN (${sql.join(named.map((i) => sql`${i}`), sql`, `)})`);
        if (ids.includes(NO_PERSON)) parts.push(sql`${col} IS NULL`);
        return sql` AND (${sql.join(parts, sql` OR `)})`;
    }
    return f.spoc_id ? sql` AND (${col})::text = ${f.spoc_id}` : sql``;
}

/**
 * Lead-keyed kinds: each returns ev(lead_id, person, at, detail); the outer
 * select adds the lead and the names. One row per counted thing — a call, a
 * visit, a quote, a lead — so the rows add up to the cell.
 */
async function leadEvents(kind: DrillKind, f: DrillFilters, persons: string[] | null, key: string | null): Promise<SQL | null> {
    const scope = leadScopeSql(f);
    switch (kind) {
        case "calls":
            return sql`SELECT t.dealer_lead_id AS lead_id, t.performed_by::text AS person, t.performed_at AS at,
                              concat_ws(' · ', replace(t.touchpoint_type, '_', ' '), t.call_status, left(t.remarks, 140)) AS detail
                         FROM lead_touchpoints t JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
                        WHERE ${humanCall()} AND ${onIstDays(sql`t.performed_at`, f)} ${scope} ${who(sql`t.performed_by`, f, persons)}`;
        case "dealers_called":
            return sql`SELECT DISTINCT ON (t.performed_by, t.dealer_lead_id)
                              t.dealer_lead_id AS lead_id, t.performed_by::text AS person, t.performed_at AS at,
                              concat('Last call · ', COALESCE(t.call_status, '—')) AS detail
                         FROM lead_touchpoints t JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
                        WHERE ${humanCall()} AND ${onIstDays(sql`t.performed_at`, f)} ${scope} ${who(sql`t.performed_by`, f, persons)}
                        ORDER BY t.performed_by, t.dealer_lead_id, t.performed_at DESC`;
        case "engaged":
            return sql`SELECT t.dealer_lead_id AS lead_id, t.performed_by::text AS person, t.performed_at AS at,
                              concat_ws(' · ', t.call_status, left(t.remarks, 140)) AS detail
                         FROM lead_touchpoints t JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
                        WHERE t.touchpoint_type = 'inside_sales_call' AND ${engagedCall()} AND t.performed_by IS NOT NULL
                          AND ${onIstDays(sql`t.performed_at`, f)} ${scope} ${who(sql`t.performed_by`, f, persons)}`;
        case "whatsapp":
            return sql`SELECT t.dealer_lead_id AS lead_id, t.performed_by::text AS person, t.performed_at AS at,
                              left(t.remarks, 160) AS detail
                         FROM lead_touchpoints t JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
                        WHERE t.touchpoint_type = 'whatsapp' AND t.is_engaged IS TRUE AND t.performed_by IS NOT NULL
                          AND ${onIstDays(sql`t.performed_at`, f)} ${scope} ${who(sql`t.performed_by`, f, persons)}`;
        case "new_hot":
            return sql`SELECT dl.id AS lead_id, dl.current_owner_id::text AS person, dl.interest_changed_at AS at,
                              'Became Hot' AS detail
                         FROM dealer_leads dl
                        WHERE lower(dl.interest_level) = 'hot' AND dl.is_active IS NOT FALSE AND dl.interest_changed_at IS NOT NULL
                          AND ${onIstDays(sql`dl.interest_changed_at`, f)} ${scope} ${who(sql`dl.current_owner_id`, f, persons)}`;
        case "converted":
            return sql`SELECT dl.id AS lead_id, dl.closing_owner_id::text AS person, dl.closed_at AS at,
                              concat('Converted', CASE WHEN lower(dl.interest_level) = 'hot' THEN ' · was Hot' END) AS detail
                         FROM dealer_leads dl
                        WHERE dl.lead_status = 'Converted' AND dl.closed_at IS NOT NULL
                          AND ${onIstDays(sql`dl.closed_at`, f)} ${scope} ${who(sql`dl.closing_owner_id`, f, persons)}`;
        case "visits":
        case "fresh_visits":
        case "repeat_visits":
        case "dealers_visited":
        case "new_dealers": {
            // queryTotals' vis: a visit = one person, one dealer, one IST day.
            const perVisit = kind === "visits" || kind === "fresh_visits" || kind === "repeat_visits";
            const distinct = perVisit ? sql`v.asm_id, v.dealer_lead_id, v.actual_visit_date` : sql`v.asm_id, v.dealer_lead_id`;
            // ID 185: fresh = this person's first visit to the dealer; repeat = any later one.
            const rvJoin = sql`LEFT JOIN (SELECT asm_id, dealer_lead_id, MIN(actual_visit_date) AS first_d FROM lead_visits
                                           WHERE actual_visit_date IS NOT NULL GROUP BY asm_id, dealer_lead_id) rv
                                     ON rv.dealer_lead_id = v.dealer_lead_id AND rv.asm_id IS NOT DISTINCT FROM v.asm_id`;
            const freshCond =
                kind === "fresh_visits"
                    ? sql`AND v.actual_visit_date = rv.first_d`
                    : kind === "repeat_visits"
                      ? sql`AND v.actual_visit_date > rv.first_d`
                      : sql``;
            return sql`SELECT DISTINCT ON (${distinct})
                              v.dealer_lead_id AS lead_id, v.asm_id::text AS person, v.actual_visit_date::timestamp AS at,
                              concat_ws(' · ', replace(v.visit_status, '_', ' '), replace(v.visit_outcome, '_', ' '),
                                        CASE WHEN v.actual_visit_date = fv.first_d THEN 'new to iTarang'
                                             WHEN v.actual_visit_date = rv.first_d THEN 'fresh (first visit by this person)'
                                             ELSE 'repeat' END, left(v.visit_remarks, 120)) AS detail
                         FROM lead_visits v
                         JOIN dealer_leads dl ON dl.id = v.dealer_lead_id
                         LEFT JOIN (SELECT dealer_lead_id, MIN(actual_visit_date) AS first_d FROM lead_visits
                                     WHERE actual_visit_date IS NOT NULL GROUP BY dealer_lead_id) fv ON fv.dealer_lead_id = v.dealer_lead_id
                         ${rvJoin}
                        WHERE v.actual_visit_date >= ${f.from}::date AND v.actual_visit_date <= ${f.to}::date
                          ${kind === "new_dealers" ? sql`AND v.actual_visit_date = fv.first_d` : sql``}
                          ${freshCond}
                          ${scope} ${who(sql`v.asm_id`, f, persons)}
                        ORDER BY ${distinct}, v.actual_visit_date DESC`;
        }
        case "verified":
        case "productive": {
            const extra =
                kind === "verified"
                    ? sql`jsonb_typeof(v.photos) = 'array' AND jsonb_array_length(v.photos) > 0
                          AND v.gps_check_in_lat IS NOT NULL AND v.gps_check_in_lng IS NOT NULL`
                    : sql`v.visit_outcome IN (${list(ENGAGED_OUTCOMES)})`;
            return sql`SELECT v.dealer_lead_id AS lead_id, v.asm_id::text AS person,
                              COALESCE(v.actual_visit_date::timestamp, v.updated_at) AS at,
                              concat_ws(' · ', replace(v.visit_outcome, '_', ' '), left(v.visit_remarks, 140)) AS detail
                         FROM lead_visits v JOIN dealer_leads dl ON dl.id = v.dealer_lead_id
                        WHERE v.visit_status = 'visited' AND ${extra}
                          AND COALESCE(v.actual_visit_date, (v.updated_at AT TIME ZONE ${IST})::date) BETWEEN ${f.from}::date AND ${f.to}::date
                          ${scope} ${who(sql`v.asm_id`, f, persons)}`;
        }
        case "planned_today":
            return sql`SELECT v.dealer_lead_id AS lead_id, v.asm_id::text AS person, v.scheduled_date::timestamp AS at,
                              concat_ws(' · ', replace(v.visit_status, '_', ' '), left(v.visit_remarks, 140)) AS detail
                         FROM lead_visits v JOIN dealer_leads dl ON dl.id = v.dealer_lead_id
                        WHERE v.scheduled_date = (now() AT TIME ZONE ${IST})::date
                          AND v.visit_status NOT IN ('visited', 'cancelled', 'no_show')
                          ${scope} ${who(sql`v.asm_id`, f, persons)}`;
        case "handoffs":
        case "handoff_converted": {
            // reports.ts asmHandoff (report filters: dates + lead scope, no Person filter).
            const asm = sql.raw(`COALESCE(to_jsonb(t) ->> 'to_owner_id', ${asmTransferRecipientFromVisitSql("t")}, dl.asm_id)`);
            const pf: DrillFilters = { ...f, spoc_id: null };
            if (kind === "handoffs") {
                return sql`SELECT t.dealer_lead_id AS lead_id, (${asm})::text AS person, t.performed_at AS at,
                                  left(t.remarks, 160) AS detail
                             FROM lead_touchpoints t JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
                            WHERE t.touchpoint_type = 'asm_transfer' AND ${onIstDays(sql`t.performed_at`, f)} ${scope}
                              ${who(asm, pf, persons)}`;
            }
            return sql`SELECT x.dealer_lead_id AS lead_id, x.asm_id AS person, x.closed_at AS at,
                              concat('Converted · first handed over ', to_char(x.first_at AT TIME ZONE ${IST}, 'DD Mon')) AS detail
                         FROM (SELECT t.dealer_lead_id, (${asm})::text AS asm_id, MIN(t.performed_at) AS first_at,
                                      BOOL_OR(dl.closing_owner_id = (${asm})) AS by_asm, MAX(dl.lead_status) AS st, MAX(dl.closed_at) AS closed_at
                                 FROM lead_touchpoints t JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
                                WHERE t.touchpoint_type = 'asm_transfer' AND ${onIstDays(sql`t.performed_at`, f)} ${scope}
                                GROUP BY 1, 2) x
                        WHERE x.by_asm AND x.st = 'Converted' ${who(sql`x.asm_id`, pf, persons)}`;
        }
        case "quotes_issued":
        case "quote_revisions":
            return sql`SELECT c.dealer_lead_id AS lead_id, c.created_by::text AS person, c.created_at AS at,
                              concat_ws(' · ', c.quote_number, 'v' || c.version_no, replace(c.approval_status, '_', ' '),
                                        CASE WHEN c.dealer_decision IS NOT NULL THEN 'dealer ' || c.dealer_decision END) AS detail
                         FROM dealer_lead_commercials c JOIN dealer_leads dl ON dl.id = c.dealer_lead_id
                        WHERE c.event_type IN ('quote_issue', 'quote_revision')
                          AND ${kind === "quotes_issued" ? isFirstQuote() : sql`NOT ${isFirstQuote()}`}
                          AND ${onIstDays(sql`c.created_at`, f)} ${scope} ${who(sql`c.created_by`, f, persons)}`;
        case "waiting_approval":
        case "delivered_no_answer":
        case "dealer_yes":
        case "dealer_declined": {
            // salesHeadMeasures.ts quotes(): each lead's latest quote created in the period.
            const bucket = {
                waiting_approval: sql`q.withdrawn_at IS NULL AND q.approval_status = 'pending'`,
                dealer_yes: sql`q.withdrawn_at IS NULL AND q.dealer_decision = 'approved'`,
                dealer_declined: sql`q.withdrawn_at IS NULL AND q.dealer_decision = 'declined'`,
                delivered_no_answer: sql`q.withdrawn_at IS NULL AND q.dealer_decision IS NULL
                                         AND COALESCE(q.approval_status, 'approved') = 'approved' AND q.sent`,
            }[kind];
            return sql`SELECT q.dealer_lead_id AS lead_id, q.created_by::text AS person, q.created_at AS at,
                              concat_ws(' · ', q.quote_number, 'v' || q.version_no) AS detail
                         FROM (SELECT l.*, EXISTS (SELECT 1 FROM quotation_dispatches x
                                                   WHERE x.commercial_id = l.commercial_id AND x.status = 'sent') AS sent
                                 FROM (SELECT DISTINCT ON (c.dealer_lead_id) c.*
                                         FROM dealer_lead_commercials c JOIN dealer_leads dl ON dl.id = c.dealer_lead_id
                                        WHERE c.event_type IN ('quote_issue', 'quote_revision') ${scope}
                                        ORDER BY c.dealer_lead_id, c.version_no DESC) l
                                WHERE ${onIstDays(sql`l.created_at`, f)} ${who(sql`l.created_by`, f, persons)}) q
                        WHERE ${bucket}`;
        }
        case "lost_reason":
            // reports.ts lostAnalysis "Sales lost" (no Person filter).
            return sql`SELECT dl.id AS lead_id, dl.closing_owner_id::text AS person, dl.closed_at AS at,
                              concat_ws(' · ', replace(dl.lost_reason, '_', ' '), left(dl.lost_reason_notes, 140)) AS detail
                         FROM dealer_leads dl
                        WHERE dl.lead_status = 'Lost' AND dl.lost_reason = ${key ?? ""}
                          AND ${onIstDays(sql`dl.closed_at`, f)} ${scope}`;
        case "lost_stage":
            return sql`SELECT dl.id AS lead_id, dl.closing_owner_id::text AS person, dl.closed_at AS at,
                              concat_ws(' · ', 'from ' || replace(COALESCE(h.from_status, 'Unknown'), '_', ' '),
                                        replace(dl.lost_reason, '_', ' '), left(dl.lost_reason_notes, 120)) AS detail
                         FROM dealer_leads dl
                         LEFT JOIN LATERAL (
                             SELECT x.from_status FROM dealer_lead_status_history x
                              WHERE x.dealer_lead_id = dl.id AND x.to_status = 'Lost' AND x.from_status IS DISTINCT FROM 'Lost'
                              ORDER BY x.changed_at DESC LIMIT 1) h ON TRUE
                        WHERE dl.lead_status = 'Lost'
                          AND dl.lost_reason IN (${list(LOST_REASON.filter((r) => r !== "onboarding_dropout"))})
                          AND dl.closed_at IS NOT NULL AND ${onIstDays(sql`dl.closed_at`, f)}
                          AND COALESCE(h.from_status, 'Unknown') = ${key ?? ""} ${scope}`;
        default:
            return null;
    }
}

const leadHref = (id: string) => `/inside-sales/lead/${encodeURIComponent(id)}`;

/** The rows behind one number. `persons` = the cell's person (or a column's people). */
export async function salesDrillRows(
    kind: DrillKind,
    f: DrillFilters,
    opts: { persons?: string[] | null; key?: string | null; limit?: number } = {},
): Promise<DrillRow[]> {
    const limit = Math.min(Math.max(opts.limit ?? 500, 1), 20000);
    const persons = opts.persons ?? null;
    const key = opts.key ?? null;

    if (kind === "kyc_submitted") return kycRows(f, persons, limit);
    if (ECOFY_DRILL_KINDS.includes(kind)) return ecofyRows(kind, key, limit);

    const ev = await leadEvents(kind, f, persons, key);
    if (!ev) return [];
    const rows = (await db.execute(sql`
        SELECT dl.id, COALESCE(NULLIF(dl.shop_name, ''), dl.dealer_name, dl.id) AS name, dl.phone, dl.city, dl.state,
               dl.lead_status AS status, dl.interest_level AS rating,
               ev.person AS person_id, pu.name AS person_name, ou.name AS owner_name,
               ev.at::text AS at, ev.detail
          FROM (${ev}) ev
          JOIN dealer_leads dl ON dl.id = ev.lead_id
          LEFT JOIN users pu ON pu.id::text = ev.person
          LEFT JOIN users ou ON ou.id::text = dl.current_owner_id
         ORDER BY pu.name NULLS LAST, ev.at DESC NULLS LAST, dl.id
         LIMIT ${limit}
    `)) as unknown as Array<Omit<DrillRow, "href">>;
    return rows.map((r) => ({ ...r, href: leadHref(r.id) }));
}

/** queryOutcome's kyc CTE: one customer file per lead, credited to the dealer account's owner. */
async function kycRows(f: DrillFilters, persons: string[] | null, limit: number): Promise<DrillRow[]> {
    const accountsOn = await hasAccountOwnershipTables();
    const owner = accountsOn ? accountOwnerOn(sql`a.id`, sql`(q.first_at AT TIME ZONE ${IST})::date`) : sql`dl.current_owner_id`;
    const join = accountsOn
        ? sql`LEFT JOIN ${dealerLeadByGstin(GSTIN_KEY(sql`a.gstin`))} m ON TRUE
              LEFT JOIN dealer_leads dl ON dl.id = m.dealer_lead_id`
        : sql`JOIN ${dealerLeadByGstin(GSTIN_KEY(sql`a.gstin`))} m ON TRUE
              JOIN dealer_leads dl ON dl.id = m.dealer_lead_id`;
    const rows = (await db.execute(sql`
        SELECT x.*, pu.name AS person_name FROM (
            SELECT l.id::text AS id, COALESCE(l.owner_name, l.id::text) AS name, COALESCE(l.mobile, l.phone) AS phone,
                   a.city, a.state, l.kyc_status AS status, l.interest_level AS rating,
                   (${owner})::text AS person_id, a.business_entity_name AS owner_name,
                   q.first_at::text AS at, concat('Dealer: ', a.business_entity_name) AS detail
              FROM (SELECT lead_id, MIN(created_at) AS first_at FROM admin_verification_queue GROUP BY lead_id) q
              JOIN leads l ON l.id::text = q.lead_id
              JOIN accounts a ON a.id = l.dealer_id
              ${join}
             WHERE ${onIstDays(sql`q.first_at`, f)} ${leadScopeSql(f)} ${who(owner, f, persons)}
        ) x
        LEFT JOIN users pu ON pu.id::text = x.person_id
        ORDER BY pu.name NULLS LAST, x.at DESC
        LIMIT ${limit}
    `)) as unknown as Array<Omit<DrillRow, "href">>;
    return rows.map((r) => ({ ...r, href: `/admin/kyc-review/${encodeURIComponent(r.id)}` }));
}

/** api/ecofy/stage-summary: every Ecofy lead the CRM holds, by current stage. */
async function ecofyRows(kind: DrillKind, key: string | null, limit: number): Promise<DrillRow[]> {
    const where =
        kind === "ecofy_open"
            ? sql`(e.stage IS NULL OR e.stage NOT IN ('S0', 'CLOSED'))`
            : kind === "ecofy_queue"
              ? sql`e.stage = 'S1' AND e.assigned_to_user_id IS NULL`
              : kind === "ecofy_stage"
                ? key === "UNKNOWN"
                    ? sql`NULLIF(btrim(e.stage), '') IS NULL`
                    : sql`btrim(e.stage) = ${key ?? ""}`
                : sql`TRUE`;
    const rows = (await db.execute(sql`
        SELECT e.id::text AS id, COALESCE(NULLIF(e.business_name, ''), e.customer_name, e.case_no, e.id::text) AS name,
               e.customer_mobile AS phone, e.city, e.state, concat_ws(' · ', e.stage, e.sub_status) AS status,
               e.temperature AS rating, e.assigned_to_user_id::text AS person_id, u.name AS person_name,
               e.owner AS owner_name, COALESCE(e.last_event_at, e.queue_entered_at)::text AS at,
               concat_ws(' · ', e.case_no, e.product_interest, e.lead_source) AS detail
          FROM ecofy_leads e LEFT JOIN users u ON u.id::text = e.assigned_to_user_id::text
         WHERE ${where}
         ORDER BY COALESCE(e.last_event_at, e.queue_entered_at) DESC NULLS LAST
         LIMIT ${limit}
    `)) as unknown as Array<Omit<DrillRow, "href">>;
    return rows.map((r) => ({ ...r, href: `/sales-head/ecofy/leads/${encodeURIComponent(r.id)}` }));
}

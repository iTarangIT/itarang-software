// AI Analyst golden suite — 20 real CEO / Sales Head questions with the reference SQL that the
// CRM's agreed definitions give (src/lib/reports/metricDefinitions.ts ANALYST_RULES). Run before
// every release: `npm run analyst:golden` (scripts/verify-analyst-golden.ts).
//
// Drawn from the questions actually asked on the analyst (run history, 14 Nov: visits by a
// named person, leads by status, lost by reason, dealer visits last week, the October revenue
// target, lithium battery sales) and the CEO dashboard's daily figures (leads in, calls,
// quotes, conversions, revenue, live dealers).
//
// Each `sql` runs as the analyst's own read-only login (ANALYST_CRM_READONLY_DSN, analyst_ro),
// so it can only read what the agent can. It returns one or more rows with a numeric column
// `n` — every `n` must appear in the agent's answer (src/lib/analyst/golden.ts). Periods are
// IST calendar periods, as the rules say.

export type GoldenCase = {
    id: string;
    question: string;
    /** Rows with a numeric `n` (and a `label` for reading the report). */
    sql: string;
    /** Allowed relative difference (money rounding); 0 = exact. */
    tolerance?: number;
    /** Who asks it. */
    asker: "CEO" | "Sales Head";
};

// IST helpers, written out in every query so each can be pasted into a SQL editor as-is.
const TODAY = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;
const MONTH_START = `date_trunc('month', ${TODAY})::date`;
const LAST_MONTH_START = `(date_trunc('month', ${TODAY}) - interval '1 month')::date`;
const WEEK_START = `date_trunc('week', ${TODAY})::date`; // Monday
/** dealer_leads.created_at is a naive UTC timestamp. */
const LEAD_DAY = `((dl.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date`;
const IST_DAY = (col: string) => `(${col} AT TIME ZONE 'Asia/Kolkata')::date`;
const ACTIVE_LEAD = `dl.is_active IS NOT FALSE AND dl.deleted_at IS NULL`;

/** Visits = one per (asm_id, dealer_lead_id, actual_visit_date), visited only. */
const VISITS = `SELECT DISTINCT asm_id, dealer_lead_id, actual_visit_date FROM lead_visits WHERE visit_status = 'visited'`;

/** Human calls, a NeoDove re-disposition within 3 minutes on the same lead by the same agent folded in. */
const CALLS = `
    SELECT t.touchpoint_id, t.performed_at, t.call_status, t.is_engaged FROM lead_touchpoints t
     WHERE t.touchpoint_type = 'inside_sales_call'
       AND NOT EXISTS (
           SELECT 1 FROM lead_touchpoints p
            WHERE p.touchpoint_type = 'inside_sales_call'
              AND p.dealer_lead_id = t.dealer_lead_id
              AND p.performed_by IS NOT DISTINCT FROM t.performed_by
              AND t.external_system = 'neodove'
              AND p.performed_at < t.performed_at
              AND p.performed_at >= t.performed_at - interval '3 minutes')`;

/** Invoices (Zoho + Drive) and credit notes (negative), voids left out — revenueSource.ts. */
const MONEY = `
    SELECT zi.invoice_date AS day, zi.total AS amount
      FROM zoho_invoices zi
     WHERE zi.status IS DISTINCT FROM 'void'
       AND NOT EXISTS (SELECT 1 FROM invoice_voids v WHERE v.source = 'zoho' AND v.invoice_id = zi.id::text)
    UNION ALL
    SELECT si.invoice_date, si.total
      FROM sales_invoices si
     WHERE si.status IS DISTINCT FROM 'void'
       AND NOT EXISTS (SELECT 1 FROM invoice_voids v WHERE v.source = 'drive' AND v.invoice_id = si.id::text)
    UNION ALL
    SELECT cn.issue_date, -COALESCE(cn.total, 0)
      FROM credit_notes cn
     WHERE NOT EXISTS (SELECT 1 FROM invoice_voids v WHERE v.source = 'credit' AND v.invoice_id = cn.id::text)`;

/** Battery lines with their document's date, voids left out; credit lines are already negative. */
const BATTERY_LINES = `
    SELECT l.quantity, COALESCE(zi.invoice_date, si.invoice_date, cn.issue_date) AS day
      FROM invoice_line_items l
      LEFT JOIN zoho_invoices zi  ON l.source = 'zoho'   AND zi.id::text = l.invoice_id
      LEFT JOIN sales_invoices si ON l.source = 'drive'  AND si.id::text = l.invoice_id
      LEFT JOIN credit_notes cn   ON l.source = 'credit' AND cn.id::text = l.invoice_id
     WHERE l.product_class = 'battery'
       AND COALESCE(zi.status, si.status, '') IS DISTINCT FROM 'void'
       AND NOT EXISTS (SELECT 1 FROM invoice_voids v WHERE v.source = l.source AND v.invoice_id = l.invoice_id)`;

export const GOLDEN_CASES: GoldenCase[] = [
    {
        id: "G01",
        asker: "CEO",
        question: "How many leads came in this month?",
        sql: `SELECT 'leads in' AS label, count(*)::int AS n FROM dealer_leads dl
               WHERE ${ACTIVE_LEAD} AND ${LEAD_DAY} >= ${MONTH_START}
                 AND COALESCE(dl.source_door, '') <> 'direct_onboarding'`,
    },
    {
        id: "G02",
        asker: "Sales Head",
        question: "How many leads were created this month, by status?",
        sql: `SELECT COALESCE(dl.lead_status, 'none') AS label, count(*)::int AS n FROM dealer_leads dl
               WHERE ${ACTIVE_LEAD} AND ${LEAD_DAY} >= ${MONTH_START}
                 AND COALESCE(dl.source_door, '') <> 'direct_onboarding'
               GROUP BY 1 ORDER BY 2 DESC`,
    },
    {
        id: "G03",
        asker: "CEO",
        question: "How many leads were lost by reason, all time?",
        sql: `SELECT COALESCE(dl.lost_reason, 'no reason') AS label, count(*)::int AS n FROM dealer_leads dl
               WHERE dl.lead_status = 'Lost' AND ${ACTIVE_LEAD}
               GROUP BY 1 ORDER BY 2 DESC`,
    },
    {
        id: "G04",
        asker: "Sales Head",
        question: "How many dealer visits were done last week?",
        sql: `SELECT 'visits' AS label, count(*)::int AS n FROM (${VISITS}) v
               WHERE v.actual_visit_date >= ${WEEK_START} - 7 AND v.actual_visit_date < ${WEEK_START}`,
    },
    {
        id: "G05",
        asker: "CEO",
        question: "How many visits did each ASM make this month?",
        sql: `SELECT s.name AS label, count(*)::int AS n FROM (${VISITS}) v
                JOIN analyst_staff s ON s.user_id = v.asm_id
               WHERE v.actual_visit_date >= ${MONTH_START}
               GROUP BY 1 ORDER BY 2 DESC`,
    },
    {
        id: "G06",
        asker: "CEO",
        question: "How many visits did Biplabh Ghosh do this month?",
        sql: `SELECT max(s.name) AS label, count(v.*)::int AS n
                FROM analyst_staff s
                LEFT JOIN (${VISITS}) v ON v.asm_id = s.user_id AND v.actual_visit_date >= ${MONTH_START}
               WHERE s.name ILIKE '%biplab%' AND s.name ILIKE '%ghosh%'
               GROUP BY s.user_id`,
    },
    {
        id: "G07",
        asker: "CEO",
        question: "How many dealers were converted last month?",
        sql: `SELECT 'converted' AS label, count(*)::int AS n FROM dealer_leads dl
               WHERE dl.lead_status = 'Converted'
                 AND ${IST_DAY("dl.closed_at")} >= ${LAST_MONTH_START} AND ${IST_DAY("dl.closed_at")} < ${MONTH_START}`,
    },
    {
        id: "G08",
        asker: "Sales Head",
        question: "How many leads were marked Won this month?",
        sql: `SELECT 'marked won' AS label, count(DISTINCT h.dealer_lead_id)::int AS n
                FROM dealer_lead_status_history h
               WHERE h.to_status = 'Won' AND h.won_undone_at IS NULL
                 AND h.changed_by IS DISTINCT FROM 'system'
                 AND ${IST_DAY("h.changed_at")} >= ${MONTH_START}`,
    },
    {
        id: "G09",
        asker: "Sales Head",
        question: "How many calls did the team make this month?",
        sql: `SELECT 'calls' AS label, count(*)::int AS n FROM (${CALLS}) c
               WHERE ${IST_DAY("c.performed_at")} >= ${MONTH_START}`,
    },
    {
        id: "G10",
        asker: "Sales Head",
        question: "How many engaged calls were there this month?",
        sql: `SELECT 'engaged calls' AS label, count(*)::int AS n FROM (${CALLS}) c
               WHERE ${IST_DAY("c.performed_at")} >= ${MONTH_START}
                 AND (c.call_status = 'connected' OR c.is_engaged IS TRUE)`,
    },
    {
        id: "G11",
        asker: "CEO",
        question: "How many quotes were created this month?",
        sql: `SELECT 'quotes' AS label, count(*)::int AS n FROM (
                SELECT dealer_lead_id, min(created_at) AS first_at
                  FROM dealer_lead_commercials WHERE event_type = 'quote_issue'
                 GROUP BY dealer_lead_id) q
               WHERE ${IST_DAY("q.first_at")} >= ${MONTH_START}`,
    },
    {
        id: "G12",
        asker: "Sales Head",
        question: "How many ready leads have no owner right now?",
        sql: `SELECT 'ready, no owner' AS label, count(*)::int AS n FROM dealer_leads dl
               WHERE dl.sales_ready_at IS NOT NULL AND dl.current_owner_id IS NULL
                 AND dl.is_active IS NOT FALSE
                 AND COALESCE(dl.lead_status, '') NOT IN ('Won', 'Converted', 'Lost')
                 AND dl.contactability IS NULL`,
    },
    {
        id: "G13",
        asker: "CEO",
        question: "How many live dealers do we have?",
        sql: `SELECT 'live dealers' AS label, count(*)::int AS n FROM analyst_account_flags f
               WHERE f.is_dealer AND NOT EXISTS (SELECT 1 FROM account_closures c WHERE c.account_id = f.account_id)`,
    },
    {
        id: "G14",
        asker: "CEO",
        question: "How many live dealers have their GSTIN missing?",
        sql: `SELECT 'GSTIN missing' AS label, count(*)::int AS n FROM analyst_account_flags f
               WHERE f.is_dealer AND f.gstin_missing
                 AND NOT EXISTS (SELECT 1 FROM account_closures c WHERE c.account_id = f.account_id)`,
    },
    {
        id: "G15",
        asker: "CEO",
        question: "What was our revenue last month?",
        tolerance: 0.005,
        sql: `SELECT 'revenue' AS label, round(COALESCE(sum(m.amount), 0), 2)::float AS n FROM (${MONEY}) m
               WHERE m.day >= ${LAST_MONTH_START} AND m.day < ${MONTH_START}`,
    },
    {
        id: "G16",
        asker: "CEO",
        question: "What is our revenue this month so far?",
        tolerance: 0.005,
        sql: `SELECT 'revenue' AS label, round(COALESCE(sum(m.amount), 0), 2)::float AS n FROM (${MONEY}) m
               WHERE m.day >= ${MONTH_START} AND m.day <= ${TODAY}`,
    },
    {
        id: "G17",
        asker: "CEO",
        question: "How many batteries did we sell last month?",
        sql: `SELECT 'batteries' AS label, COALESCE(sum(b.quantity), 0)::float AS n FROM (${BATTERY_LINES}) b
               WHERE b.day >= ${LAST_MONTH_START} AND b.day < ${MONTH_START}`,
    },
    {
        id: "G18",
        asker: "CEO",
        question: "What was the company revenue target for October 2026?",
        tolerance: 0.005,
        sql: `SELECT 'revenue target' AS label, COALESCE(sum(t.ceo_target), 0)::float AS n FROM sales_targets t
               WHERE t.month = DATE '2026-10-01' AND t.metric = 'revenue' AND t.status IN ('pushed', 'accepted')`,
    },
    {
        id: "G19",
        asker: "Sales Head",
        question: "How many Hot leads are open right now?",
        sql: `SELECT 'hot open' AS label, count(*)::int AS n FROM dealer_leads dl
               WHERE ${ACTIVE_LEAD} AND dl.interest_level = 'hot'
                 AND COALESCE(dl.lead_status, '') NOT IN ('Won', 'Converted', 'Lost')`,
    },
    {
        id: "G20",
        asker: "CEO",
        question: "How many leads came in last month, by source?",
        sql: `SELECT COALESCE(dl.source, 'unknown') AS label, count(*)::int AS n FROM dealer_leads dl
               WHERE ${ACTIVE_LEAD} AND ${LEAD_DAY} >= ${LAST_MONTH_START} AND ${LEAD_DAY} < ${MONTH_START}
                 AND COALESCE(dl.source_door, '') <> 'direct_onboarding'
               GROUP BY 1 ORDER BY 2 DESC`,
    },
];

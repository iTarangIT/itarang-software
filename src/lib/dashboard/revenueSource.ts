/**
 * E-280 — the single definition of "revenue".
 *
 * Sales invoices now arrive from two places: `zoho_invoices`, filled by the
 * hourly Zoho API sync up to the move onto Vyapar, and `sales_invoices`, read
 * out of Google Drive from then on. Six endpoints report revenue — the CEO
 * overview card and chart, /api/dashboard/[role], the Business Snapshot
 * summary, two drill-downs and the Sales Invoices page — and before this module
 * each of them wrote its own `zoho_invoices` predicate inline.
 *
 * Unioning in six places would mean six chances to disagree about which rows
 * count, which is the exact failure the CEO overview route already guards
 * against in its header ("all resolved against ONE window so the cards, the
 * drill-down and the chart cannot disagree"). So every reader goes through here
 * instead, and the rules below are stated once.
 *
 * WHY THIS IS NOT A DATABASE VIEW
 *   A view would be tidier, but migrations in this repo are applied by hand per
 *   environment and are known to drift — E-185 sat unapplied on production long
 *   enough that the CEO overview had to grow a 42P01 guard for it. A missing
 *   view would take the whole dashboard down. A TS union degrades instead: the
 *   probe below notices `sales_invoices` is absent and falls back to Zoho-only
 *   figures, which is exactly what the dashboard showed before this feature.
 *
 * WHAT COUNTS (lifted verbatim from the routes this replaces, so nothing moved)
 *   revenue     — void excluded, DRAFTS COUNTED. The rule the CEO signed off on.
 *   outstanding — status not in (paid, void, draft) AND balance > 0.
 *
 * BALANCE IS DERIVED, NOT STORED
 *   Zoho maintains its own `balance`. For Drive rows there is no such column:
 *   a PDF carries no live payment status, so balance is total minus whatever
 *   finance has recorded as paid, computed here. One definition, no drift.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accountOwnerOn,
  accountsByGstinKey,
  GSTIN_KEY,
  leadsByGstinKey,
} from "@/lib/leads/gstinMatch";
import { hasAccountOwnershipTables } from "@/lib/accounts/tables";
import { hasInvoiceLedgerTables } from "@/lib/sales/ledgerTables";

/**
 * 'credit' (E-322, tracker ID 71) is a credit note: a NEGATIVE amount dated on
 * the day it was issued, so it reduces revenue in the month it is issued.
 */
export type RevenueInvoiceSource = "zoho" | "drive" | "credit";

export interface RevenueInvoiceRow {
  source: RevenueInvoiceSource;
  id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  /**
   * Carried because the Outstanding drill-down renders a "Due" column AND
   * derives its "Overdue" days from this. Dropping it blanked both.
   */
  due_date: string | null;
  customer_name: string | null;
  total: string | null;
  balance: string | null;
  status: string | null;
  organization_id: string | null;
  /** Where to view the document — a Zoho PDF passthrough or a stored copy. */
  document_url: string | null;
  payment_reference: string | null;
  needs_attention: boolean;
  attention_reason: string | null;
  /** Customer GSTIN, upper-cased with spaces removed. NULL when the invoice has none. */
  gstin_key: string | null;
  /**
   * The CRM dealer this invoice was matched to on GSTIN (review R-11), on the
   * list / export / summary rows only — see matchedUnion(). NULL = not linked.
   */
  dealer_lead_id?: string | null;
  /** The matched lead's name, else the matched account's. */
  dealer_name?: string | null;
  dealer_owner_id?: string | null;
  /**
   * The activated dealer ACCOUNT with this GSTIN, when there is one — most
   * dealers are onboarded with no lead behind them. NULL = no such account.
   */
  acct_id?: string | null;
  acct_city?: string | null;
  /** Linked to a CRM dealer: a lead OR an account matched. */
  dealer_linked?: boolean;
  /** E-321: the dealer account the invoice matched (accounts.id), if any. */
  account_id?: string | null;
  /** E-321: 'linked' | 'not_dealer' when decided by hand. */
  link_kind?: string | null;
  /** E-321 work-list status — see matchedUnion(). */
  match_status?: InvoiceMatchStatus;
}

export type InvoiceMatchStatus = "credited" | "no_owner" | "unknown" | "not_dealer";

/**
 * Whether `sales_invoices` exists, cached so the probe is not one extra round
 * trip per dashboard load.
 *
 * Re-checked periodically rather than once per process so that applying E-280
 * to a running environment starts working on its own — without the TTL, the
 * dashboard would keep reporting Zoho-only revenue until somebody restarted
 * pm2, and "the migration is applied but the number has not moved" is a
 * genuinely hard thing to debug.
 */
const PROBE_TTL_MS = 5 * 60_000;
let salesTablePresent: boolean | null = null;
let salesTableProbedAt = 0;

async function hasSalesInvoicesTable(): Promise<boolean> {
  const now = Date.now();
  if (salesTablePresent !== null && now - salesTableProbedAt < PROBE_TTL_MS) {
    return salesTablePresent;
  }
  try {
    const res = await db.execute<{ present: boolean }>(
      sql`SELECT to_regclass('public.sales_invoices') IS NOT NULL AS present`,
    );
    salesTablePresent = Boolean(
      (res as unknown as Array<{ present: boolean }>)[0]?.present,
    );
  } catch {
    // A failed probe must not take the dashboard with it.
    salesTablePresent = false;
  }
  salesTableProbedAt = now;
  if (!salesTablePresent) {
    console.warn(
      "[revenueSource] sales_invoices is absent — reporting Zoho-only revenue. " +
        "Apply drizzle/E-280_drive_sales_invoices.sql to include Drive invoices.",
    );
  }
  return salesTablePresent;
}

/** Exposed so a caller can tell the user WHY Drive revenue is missing. */
export async function isDriveRevenueAvailable(): Promise<boolean> {
  return hasSalesInvoicesTable();
}

/**
 * The unioned invoice set, as a SQL fragment to be used as a subquery.
 *
 * Column list is fixed and identical on both branches — a UNION ALL matches by
 * position, so a column added to one side and not the other silently shifts
 * every value after it.
 */
async function revenueUnion(): Promise<SQL> {
  // E-322 (IDs 70, 71): GSTIN backfill, voids and credit notes. Without it the
  // union is exactly the pre-E-322 shape.
  const ledger = await hasInvoiceLedgerTables();
  const zoho = sql`
    SELECT
      'zoho'::text                                                   AS source,
      zi.id::text                                                    AS id,
      zi.invoice_number                                              AS invoice_number,
      zi.invoice_date                                                AS invoice_date,
      zi.due_date                                                    AS due_date,
      zi.customer_name                                               AS customer_name,
      zi.total                                                       AS total,
      zi.balance                                                     AS balance,
      ${ledger ? sql`CASE WHEN zv.invoice_id IS NOT NULL THEN 'void' ELSE zi.status END` : sql`zi.status`} AS status,
      zi.organization_id                                             AS organization_id,
      ('/api/admin/zoho/invoices/' || zi.zoho_invoice_id || '/pdf')  AS document_url,
      zi.payment_reference                                           AS payment_reference,
      false                                                          AS needs_attention,
      NULL::text                                                     AS attention_reason,
      -- Zoho's invoice LIST payload (what the sync stores) carries no GSTIN.
      -- E-322 (ID 70): the one-time backfill's zoho_customer_gstins first,
      -- then raw_json's gst_no in case a richer sync ever stores it.
      ${GSTIN_KEY(ledger ? sql`COALESCE(zcg.gstin, zi.raw_json->>'gst_no')` : sql`zi.raw_json->>'gst_no'`)} AS gstin_key
    FROM zoho_invoices zi
    ${ledger
      ? sql`LEFT JOIN zoho_customer_gstins zcg
                   ON zcg.organization_id = COALESCE(zi.organization_id, '')
                  AND zcg.customer_id = zi.customer_id
            LEFT JOIN invoice_voids zv
                   ON zv.source = 'zoho' AND zv.invoice_id = zi.id::text`
      : sql``}
  `;

  if (!(await hasSalesInvoicesTable())) {
    return sql`(${zoho})`;
  }

  const drive = sql`
    SELECT
      'drive'::text                                                  AS source,
      si.id::text                                                    AS id,
      si.invoice_number                                              AS invoice_number,
      si.invoice_date                                                AS invoice_date,
      si.due_date                                                    AS due_date,
      si.customer_name                                               AS customer_name,
      si.total                                                       AS total,
      (COALESCE(si.total, 0) - si.amount_paid)                       AS balance,
      ${ledger ? sql`CASE WHEN dv.invoice_id IS NOT NULL THEN 'void' ELSE si.status END` : sql`si.status`} AS status,
      si.organization_id                                             AS organization_id,
      si.document_url                                                AS document_url,
      si.payment_reference                                           AS payment_reference,
      si.needs_attention                                             AS needs_attention,
      si.attention_reason                                            AS attention_reason,
      ${GSTIN_KEY(sql`si.customer_gstin`)}                           AS gstin_key
    FROM sales_invoices si
    ${ledger
      ? sql`LEFT JOIN invoice_voids dv ON dv.source = 'drive' AND dv.invoice_id = si.id::text`
      : sql``}
  `;

  if (!ledger) return sql`(${zoho} UNION ALL ${drive})`;

  // E-322 (ID 71): credit notes reduce revenue in the month they are issued —
  // a negative amount on the issue date, matched to a dealer like an invoice.
  // Status 'credit_note' keeps them out of the outstanding rule (balance 0).
  const credit = sql`
    SELECT
      'credit'::text                                                 AS source,
      cn.id::text                                                    AS id,
      cn.note_number                                                 AS invoice_number,
      cn.issue_date                                                  AS invoice_date,
      NULL::date                                                     AS due_date,
      cn.customer_name                                               AS customer_name,
      -(COALESCE(cn.total, 0))                                       AS total,
      0::numeric                                                     AS balance,
      CASE WHEN cv.invoice_id IS NOT NULL THEN 'void' ELSE 'credit_note' END AS status,
      cn.organization_id                                             AS organization_id,
      cn.document_url                                                AS document_url,
      NULL::text                                                     AS payment_reference,
      cn.needs_attention                                             AS needs_attention,
      cn.attention_reason                                            AS attention_reason,
      ${GSTIN_KEY(sql`cn.customer_gstin`)}                           AS gstin_key
    FROM credit_notes cn
    LEFT JOIN invoice_voids cv ON cv.source = 'credit' AND cv.invoice_id = cn.id::text
  `;

  return sql`(${zoho} UNION ALL ${drive} UNION ALL ${credit})`;
}

/**
 * The union with each invoice linked to a CRM dealer (review R-11, E-321).
 *
 * An invoice carries only a typed customer name, which cannot be joined to
 * anything reliably; the GSTIN can. Two matchers, in order (tracker ID 68 /
 * handover P1-5):
 *   1. the dealer ACCOUNT — a hand link (invoice_account_links), else the
 *      account's GSTIN or one of its account_gstins aliases. Credit goes to the
 *      account owner ON THE INVOICE DATE (account_owner_history), so
 *      reassigning a dealer never moves revenue already reported.
 *   2. only when no account matches: the lead / onboarding GSTIN rule in
 *      src/lib/leads/gstinMatch.ts, credited to that lead's current owner.
 *
 * match_status (tracker ID 69 / P1-6 work list):
 *   credited    — matched, and someone owned it on the invoice date
 *   no_owner    — matched to a dealer account / lead that had no owner
 *   unknown     — has a GSTIN that matches no account and no lead
 *   not_dealer  — marked "not a dealer sale" by hand, or carries no GSTIN
 *
 * Without E-321 applied the account matcher is skipped and the result is the
 * pre-E-321 lead-only match. Kept separate from revenueUnion(): company totals
 * and the chart never need the match, and must not move because of it.
 */
/**
 * The names the account-management side (d949ccc7) reads off a matched row —
 * acct_id, acct_city, dealer_linked — derived from the E-321 match above so
 * both read the same answer.
 */
function withAccountAliases(q: SQL): SQL {
  return sql`(
    SELECT mu.*,
           mu.account_id                                                  AS acct_id,
           (SELECT NULLIF(btrim(aa.city), '') FROM accounts aa WHERE aa.id = mu.account_id) AS acct_city,
           (mu.dealer_lead_id IS NOT NULL OR mu.account_id IS NOT NULL)  AS dealer_linked
      FROM ${q} AS mu
  )`;
}

export async function matchedUnion(): Promise<SQL> {
  return withAccountAliases(await matchedUnionCore());
}

async function matchedUnionCore(): Promise<SQL> {
  const src = await revenueUnion();
  // Both matchers are keyed sets built once and hash-joined (see
  // gstinMatch.ts) — not a search per invoice.
  if (!(await hasAccountOwnershipTables())) {
    return sql`(
      WITH lead_keys AS (${leadsByGstinKey()})
      SELECT u.*,
             m.dealer_lead_id,
             m.dealer_name,
             m.dealer_owner_id,
             NULL::text AS account_id,
             NULL::text AS link_kind,
             CASE WHEN m.dealer_lead_id IS NOT NULL AND m.dealer_owner_id IS NOT NULL THEN 'credited'
                  WHEN m.dealer_lead_id IS NOT NULL THEN 'no_owner'
                  WHEN u.gstin_key IS NULL THEN 'not_dealer'
                  ELSE 'unknown' END AS match_status
        FROM ${src} AS u
        LEFT JOIN lead_keys m ON m.k = u.gstin_key
    )`;
  }
  return sql`(
    WITH lead_keys AS (${leadsByGstinKey()}),
         account_keys AS (${accountsByGstinKey()}),
         matched AS (
           SELECT u.*,
                  lk.kind AS link_kind,
                  -- A hand link wins; otherwise the account owning the GSTIN.
                  CASE WHEN lk.kind = 'linked' THEN la.id ELSE ak.account_id END AS m_account_id,
                  CASE WHEN lk.kind = 'linked' THEN la.business_entity_name ELSE ak.account_name END AS m_account_name
             FROM ${src} AS u
             LEFT JOIN invoice_account_links lk ON lk.source = u.source AND lk.invoice_id = u.id
             LEFT JOIN accounts la ON lk.kind = 'linked' AND la.id = lk.account_id
             LEFT JOIN account_keys ak ON lk.kind IS NULL AND ak.k = u.gstin_key
         ),
         credited AS (
           SELECT mt.*,
                  -- Past revenue never moves: the owner whose window holds the
                  -- invoice date (IST day), not today's owner.
                  ${accountOwnerOn(sql`mt.m_account_id`, sql`mt.invoice_date`)} AS m_account_owner_id
             FROM matched mt
         )
    SELECT x.*,
           CASE WHEN x.link_kind = 'not_dealer'
                  OR (x.gstin_key IS NULL AND x.account_id IS NULL) THEN 'not_dealer'
                WHEN x.account_id IS NULL AND x.dealer_lead_id IS NULL THEN 'unknown'
                WHEN x.dealer_owner_id IS NULL THEN 'no_owner'
                ELSE 'credited' END AS match_status
      FROM (
        SELECT c.source, c.id, c.invoice_number, c.invoice_date, c.due_date, c.customer_name,
               c.total, c.balance, c.status, c.organization_id, c.document_url,
               c.payment_reference, c.needs_attention, c.attention_reason, c.gstin_key,
               CASE WHEN c.link_kind = 'not_dealer' THEN NULL
                    ELSE COALESCE(ao.source_dealer_lead_id, m.dealer_lead_id) END AS dealer_lead_id,
               CASE WHEN c.link_kind = 'not_dealer' THEN NULL
                    ELSE COALESCE(c.m_account_name, m.dealer_name) END          AS dealer_name,
               CASE WHEN c.link_kind = 'not_dealer' THEN NULL
                    WHEN c.m_account_id IS NOT NULL THEN c.m_account_owner_id
                    ELSE m.dealer_owner_id::text END                            AS dealer_owner_id,
               CASE WHEN c.link_kind = 'not_dealer' THEN NULL
                    ELSE c.m_account_id END                                     AS account_id,
               c.link_kind                                                      AS link_kind
          FROM credited c
          LEFT JOIN account_ownership ao ON ao.account_id = c.m_account_id
          -- The lead / onboarding GSTIN only when no account matched.
          LEFT JOIN lead_keys m ON c.m_account_id IS NULL AND c.link_kind IS NULL AND m.k = c.gstin_key
      ) x
  )`;
}

export type InvoiceDealerMatch = "linked" | "unlinked";

/**
 * Revenue rule: void excluded, drafts counted.
 * Kept identical to what /api/dashboard/ceo/overview used inline, so the
 * cutover moved no numbers.
 */
export const REVENUE_NOT_VOID = sql`(r.status IS NULL OR r.status NOT IN ('void'))`;

/** Outstanding rule: still owed, and actually has a balance. */
export const REVENUE_OUTSTANDING = sql`(
  (r.status IS NULL OR r.status NOT IN ('paid', 'void', 'draft'))
  AND COALESCE(r.balance, 0) > 0
)`;

/** `invoice_date >= start AND invoice_date < end`, either bound optional. */
function windowClause(startStr?: string | null, endStr?: string | null): SQL {
  const parts: SQL[] = [];
  if (startStr) parts.push(sql`r.invoice_date >= ${startStr}::date`);
  if (endStr) parts.push(sql`r.invoice_date < ${endStr}::date`);
  if (parts.length === 0) return sql`TRUE`;
  return sql.join(parts, sql` AND `);
}

function rowsOf<T>(res: unknown): T[] {
  // The pg driver returns an array; some paths wrap it in { rows }.
  if (Array.isArray(res)) return res as T[];
  return ((res as { rows?: T[] })?.rows ?? []) as T[];
}

/** Total invoiced in the window. Void excluded, drafts counted. */
export async function revenueTotal(
  startStr?: string | null,
  endStr?: string | null,
): Promise<number> {
  const src = await revenueUnion();
  const res = await db.execute<{ total: string }>(sql`
    SELECT COALESCE(SUM(r.total), 0) AS total
    FROM ${src} AS r
    WHERE ${REVENUE_NOT_VOID} AND ${windowClause(startStr, endStr)}
  `);
  return Number(rowsOf<{ total: string }>(res)[0]?.total ?? 0);
}

/**
 * Receivables. Pass no window for the all-time snapshot the standalone
 * Outstanding Credits card uses; pass one for the windowed figure that sits
 * inside the Realization drill-down beside a windowed revenue and expense.
 */
export async function outstandingTotal(
  startStr?: string | null,
  endStr?: string | null,
): Promise<number> {
  const src = await revenueUnion();
  const res = await db.execute<{ total: string }>(sql`
    SELECT COALESCE(SUM(r.balance), 0) AS total
    FROM ${src} AS r
    WHERE ${REVENUE_OUTSTANDING} AND ${windowClause(startStr, endStr)}
  `);
  return Number(rowsOf<{ total: string }>(res)[0]?.total ?? 0);
}

/**
 * Revenue split by what the CEO card treats as countable vs not.
 *
 * `base` is the headline figure (void excluded, drafts counted); `voided` and
 * `draft` are the two amounts sitting either side of that decision, reported so
 * a reader can see what the rule included and excluded rather than having to
 * trust it. One query rather than three because the three must describe the
 * same rows.
 */
export async function revenueBreakdown(
  startStr?: string | null,
  endStr?: string | null,
): Promise<{ base: number; voided: number; draft: number }> {
  const src = await revenueUnion();
  const res = await db.execute<{ base: string; voided: string; draft: string }>(sql`
    SELECT
      COALESCE(SUM(r.total) FILTER (
        WHERE r.status IS NULL OR r.status NOT IN ('void')), 0)   AS base,
      COALESCE(SUM(r.total) FILTER (WHERE r.status = 'void'), 0)  AS voided,
      COALESCE(SUM(r.total) FILTER (WHERE r.status = 'draft'), 0) AS draft
    FROM ${src} AS r
    WHERE ${windowClause(startStr, endStr)}
  `);
  const row = rowsOf<{ base: string; voided: string; draft: string }>(res)[0];
  return {
    base: Number(row?.base ?? 0),
    voided: Number(row?.voided ?? 0),
    draft: Number(row?.draft ?? 0),
  };
}

export type TrendGranularity = "day" | "week" | "month";

/** Revenue bucketed over time, for the CEO chart. */
export async function revenueSeries(
  granularity: TrendGranularity,
  labelFormat: string,
  startStr?: string | null,
  endStr?: string | null,
): Promise<Array<{ bucket: string; name: string; revenue: number }>> {
  // `granularity` is whitelisted by the caller before it gets here; nothing
  // user-supplied reaches sql.raw. The bucket text is inlined so the SAME
  // expression appears in SELECT, GROUP BY and ORDER BY — a bound parameter
  // emits different placeholders and Postgres then rejects the column as
  // "not grouped".
  const bucket = sql.raw(`date_trunc('${granularity}', r.invoice_date)`);
  const src = await revenueUnion();
  const res = await db.execute<{ bucket: string; name: string; revenue: string }>(sql`
    SELECT
      ${bucket}                          AS bucket,
      to_char(${bucket}, ${labelFormat}) AS name,
      COALESCE(SUM(r.total), 0)          AS revenue
    FROM ${src} AS r
    WHERE ${REVENUE_NOT_VOID} AND ${windowClause(startStr, endStr)}
    GROUP BY ${bucket}
    ORDER BY ${bucket}
  `);
  // date_trunc comes back as a Date from the pg driver but as a string over
  // some paths, and the caller merges these buckets with the expense series by
  // this key — so both sides must stringify the same way or a month with both
  // revenue and expense would render as two separate bars.
  return rowsOf<{ bucket: unknown; name: string; revenue: string }>(res).map((r) => ({
    bucket: r.bucket instanceof Date ? r.bucket.toISOString() : String(r.bucket),
    name: r.name,
    revenue: Number(r.revenue || 0),
  }));
}

/** The most recently issued invoices, for the Business Snapshot rail. */
export async function recentRevenueInvoices(limit = 5): Promise<RevenueInvoiceRow[]> {
  const src = await revenueUnion();
  const res = await db.execute(sql`
    SELECT * FROM ${src} AS r
    WHERE ${REVENUE_NOT_VOID}
    ORDER BY r.invoice_date DESC NULLS LAST
    LIMIT ${limit}
  `);
  return rowsOf<RevenueInvoiceRow>(res);
}

export interface RevenueListFilters {
  from?: string | null;
  to?: string | null;
  /** Explicit status set. When absent, everything except void is returned. */
  statuses?: string[] | null;
  customer?: string | null;
  source?: RevenueInvoiceSource | null;
  /** R-11 reconciliation: only invoices linked / not linked to a CRM dealer. */
  dealerMatch?: InvoiceDealerMatch | null;
  /**
   * E-321 work list (tracker ID 69): restrict to these match statuses, e.g.
   * everything not 'credited' for the unmatched-invoices list.
   */
  matchStatuses?: InvoiceMatchStatus[] | null;
  limit?: number;
  offset?: number;
}

/** Matched to a dealer account or lead (on a matchedUnion() row `r`). */
const MATCHED_TO_DEALER = sql`(r.account_id IS NOT NULL OR r.dealer_lead_id IS NOT NULL)`;

function listWhere(f: RevenueListFilters): SQL {
  const parts: SQL[] = [];
  // NOTE the inclusive `to` here: the Sales Invoices page has always used an
  // inclusive range (gte/lte on the raw dates), unlike the dashboard's
  // half-open window. Kept as it was so the page's totals do not shift.
  if (f.from) parts.push(sql`r.invoice_date >= ${f.from}::date`);
  if (f.to) parts.push(sql`r.invoice_date <= ${f.to}::date`);

  if (f.statuses && f.statuses.length > 0) {
    parts.push(sql`r.status IN (${sql.join(f.statuses.map((s) => sql`${s}`), sql`, `)})`);
  } else {
    parts.push(REVENUE_NOT_VOID);
  }
  if (f.customer?.trim()) {
    parts.push(sql`r.customer_name ILIKE ${"%" + f.customer.trim() + "%"}`);
  }
  if (f.source) parts.push(sql`r.source = ${f.source}`);
  if (f.dealerMatch === "linked") parts.push(MATCHED_TO_DEALER);
  if (f.dealerMatch === "unlinked") parts.push(sql`NOT ${MATCHED_TO_DEALER}`);
  if (f.matchStatuses && f.matchStatuses.length > 0) {
    parts.push(
      sql`r.match_status IN (${sql.join(f.matchStatuses.map((s) => sql`${s}`), sql`, `)})`,
    );
  }

  if (parts.length === 0) return sql`TRUE`;
  return sql.join(parts, sql` AND `);
}

/** One page of invoices for the Sales Invoices table. */
export async function listRevenueInvoices(
  f: RevenueListFilters,
): Promise<RevenueInvoiceRow[]> {
  const src = await matchedUnion();
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 500);
  const offset = Math.max(f.offset ?? 0, 0);
  const res = await db.execute(sql`
    SELECT * FROM ${src} AS r
    WHERE ${listWhere(f)}
    ORDER BY r.invoice_date DESC NULLS LAST, r.invoice_number DESC
    LIMIT ${limit} OFFSET ${offset}
  `);
  return rowsOf<RevenueInvoiceRow>(res);
}

/** Count / total / balance over the FULL filtered set, not just the page. */
export async function revenueSummary(f: RevenueListFilters): Promise<{
  count: number;
  total: number;
  balance: number;
  /** Of `count` / `total`, invoices NOT linked to a CRM dealer (R-11). */
  unlinked_count: number;
  unlinked_total: number;
}> {
  const src = await matchedUnion();
  type Row = {
    count: string;
    total: string;
    balance: string;
    unlinked_count: string;
    unlinked_total: string;
  };
  const res = await db.execute<Row>(sql`
    SELECT
      COUNT(*)                    AS count,
      COALESCE(SUM(r.total), 0)   AS total,
      COALESCE(SUM(r.balance), 0) AS balance,
      COUNT(*) FILTER (WHERE NOT ${MATCHED_TO_DEALER})                  AS unlinked_count,
      COALESCE(SUM(r.total) FILTER (WHERE NOT ${MATCHED_TO_DEALER}), 0) AS unlinked_total
    FROM ${src} AS r
    WHERE ${listWhere(f)}
  `);
  const row = rowsOf<Row>(res)[0];
  return {
    count: Number(row?.count ?? 0),
    total: Number(row?.total ?? 0),
    balance: Number(row?.balance ?? 0),
    unlinked_count: Number(row?.unlinked_count ?? 0),
    unlinked_total: Number(row?.unlinked_total ?? 0),
  };
}

/** Every matching row, for CSV export. Capped by the caller. */
export async function listRevenueInvoicesForExport(
  f: RevenueListFilters,
  cap = 10_000,
): Promise<RevenueInvoiceRow[]> {
  const src = await matchedUnion();
  const res = await db.execute(sql`
    SELECT * FROM ${src} AS r
    WHERE ${listWhere(f)}
    ORDER BY r.invoice_date DESC NULLS LAST
    LIMIT ${cap}
  `);
  return rowsOf<RevenueInvoiceRow>(res);
}

/** Rows behind the "Sales to Dealer" / Outstanding drill-downs. */
export async function drillDownRows(
  kind: "sales" | "outstanding",
  startStr?: string | null,
  endStr?: string | null,
  cap = 500,
): Promise<RevenueInvoiceRow[]> {
  const src = await revenueUnion();
  const where =
    kind === "sales"
      ? sql`${REVENUE_NOT_VOID} AND ${windowClause(startStr, endStr)}`
      : // Outstanding is an all-time snapshot in the drill-down, matching what
        // /api/dashboard/ceo and drill-down/outstanding did before.
        REVENUE_OUTSTANDING;
  const order =
    kind === "sales"
      ? sql`r.invoice_date DESC NULLS LAST`
      : sql`r.balance DESC NULLS LAST`;
  const res = await db.execute(sql`
    SELECT * FROM ${src} AS r
    WHERE ${where}
    ORDER BY ${order}
    LIMIT ${cap}
  `);
  return rowsOf<RevenueInvoiceRow>(res);
}


/**
 * E-322 (tracker ID 39) — invoice LINES joined to their matched invoice, as a
 * SQL fragment: every column of matchedUnion() (`r`) plus the line's
 * product_class, product_id, asset_type, item_name, hsn, quantity and
 * amount_excl_gst. Sales-invoice lines come from the Vyapar register (source
 * 'vyapar'), Zoho lines from the one-time backfill. NULL when E-322 is not
 * applied — callers then have no line data and must say so.
 *
 * Batteries sold are counted from these lines only (Kartik, 26 Sep), never
 * from stock allocation.
 */
export async function matchedLinesUnion(): Promise<SQL | null> {
  if (!(await hasInvoiceLedgerTables())) return null;
  const src = await matchedUnion();
  return sql`(
    SELECT r.*,
           l.product_class, l.product_id, l.asset_type, l.item_name, l.hsn,
           l.quantity, l.amount_excl_gst
      FROM ${src} AS r
      JOIN invoice_line_items l
        ON l.invoice_id = r.id
       AND (l.source = r.source OR (r.source = 'drive' AND l.source IN ('vyapar', 'drive')))
  )`;
}

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

export type RevenueInvoiceSource = "zoho" | "drive";

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
}

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
      zi.status                                                      AS status,
      zi.organization_id                                             AS organization_id,
      ('/api/admin/zoho/invoices/' || zi.zoho_invoice_id || '/pdf')  AS document_url,
      zi.payment_reference                                           AS payment_reference,
      false                                                          AS needs_attention,
      NULL::text                                                     AS attention_reason
    FROM zoho_invoices zi
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
      si.status                                                      AS status,
      si.organization_id                                             AS organization_id,
      si.document_url                                                AS document_url,
      si.payment_reference                                           AS payment_reference,
      si.needs_attention                                             AS needs_attention,
      si.attention_reason                                            AS attention_reason
    FROM sales_invoices si
  `;

  return sql`(${zoho} UNION ALL ${drive})`;
}

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
  limit?: number;
  offset?: number;
}

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

  if (parts.length === 0) return sql`TRUE`;
  return sql.join(parts, sql` AND `);
}

/** One page of invoices for the Sales Invoices table. */
export async function listRevenueInvoices(
  f: RevenueListFilters,
): Promise<RevenueInvoiceRow[]> {
  const src = await revenueUnion();
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
}> {
  const src = await revenueUnion();
  const res = await db.execute<{ count: string; total: string; balance: string }>(sql`
    SELECT
      COUNT(*)                    AS count,
      COALESCE(SUM(r.total), 0)   AS total,
      COALESCE(SUM(r.balance), 0) AS balance
    FROM ${src} AS r
    WHERE ${listWhere(f)}
  `);
  const row = rowsOf<{ count: string; total: string; balance: string }>(res)[0];
  return {
    count: Number(row?.count ?? 0),
    total: Number(row?.total ?? 0),
    balance: Number(row?.balance ?? 0),
  };
}

/** Every matching row, for CSV export. Capped by the caller. */
export async function listRevenueInvoicesForExport(
  f: RevenueListFilters,
  cap = 10_000,
): Promise<RevenueInvoiceRow[]> {
  const src = await revenueUnion();
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

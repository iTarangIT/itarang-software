/**
 * Gross margin by month and business type (tracker ID 72, handover P1-10).
 *
 *   gross margin = invoice line value before GST
 *                − quantity × average OEM cost of that product
 *
 * Both sides are before GST. The OEM cost of a product, in order:
 *   1. the average inventory.inventory_amount of the units whose OEM invoice
 *      is dated in the RECENT_COST_DAYS up to the sale ("recent OEM invoices");
 *   2. the average over every costed unit of that product;
 *   3. the OEM price book (oem_reference_prices) line in force on the sale
 *      date, else the latest one.
 * Each inventory row is one unit, so a plain average IS quantity-weighted.
 *
 * What is NOT guessed:
 *   * Lines are used only when they add up to the invoice's taxable value
 *     (the SQL twin of linesAddUp() in src/lib/sales/salesInvoiceLines.ts).
 *   * A line whose item is not mapped to a product, or whose product has no
 *     cost anywhere, has no margin. Its revenue is reported as "not costed",
 *     never as 100% margin.
 *   * Void invoices are out — the voids register (invoice_voids) — and credit
 *     notes come off the month's revenue, as everywhere else revenue is counted
 *     (revenueSource REVENUE_NOT_VOID).
 *
 * ONE line store and ONE mapping (ID 147): the lines are invoice_line_items —
 * the Vyapar register, Drive invoices and the Zoho backfill — read through
 * revenueSource.matchedLinesUnion(), exactly as Invoice Ledger › By SKU reads
 * them, and an item's product is the one set in Invoice Ledger › Item mapping
 * (vyapar_item_map → the line's asset_type + product_id, product_master_*).
 * Stock cost is joined to that product by its model id (inventory.model_type).
 * The older E-326 store (sales_invoice_lines + sales_invoice_item_products) is
 * no longer read.
 */

import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { matchedLinesUnion, matchedUnion, REVENUE_NOT_VOID } from "@/lib/dashboard/revenueSource";
import { hasInvoiceLedgerTables } from "@/lib/sales/ledgerTables";
import { LINE_TYPES, type LineType } from "@/lib/sales/salesInvoiceLines";

export const RECENT_COST_DAYS = 180;

export type CostSource = "recent_invoices" | "all_invoices" | "price_book";

export type MarginCell = {
  /** Line value before GST of the lines that could be costed. */
  revenue: number;
  cost: number;
  margin: number;
  /** margin / revenue, null when nothing was costed. */
  margin_pct: number | null;
  quantity: number;
  /** Line value before GST with no product or no cost — excluded from margin. */
  not_costed: number;
};

export type MarginMonth = {
  month: string; // YYYY-MM
  /**
   * Revenue before GST of every non-void invoice in the month, less credit
   * notes — the base margin is compared with. An invoice with lines counts its
   * lines; one without counts its taxable value (Drive / Vyapar), or its total
   * where nothing smaller is known (Zoho stores no tax split).
   */
  invoice_revenue: number;
  invoices: number;
  /** Invoices with no lines in the ledger. */
  invoices_without_lines: number;
  revenue_without_lines: number;
  /** ID 71 — credit notes issued in the month, before GST; already off invoice_revenue. */
  credit_notes: number;
  total: MarginCell;
  by_type: Record<LineType, MarginCell>;
};

export type GrossMarginReport = {
  available: boolean; // false when the invoice ledger (E-322) is not on this database
  months: MarginMonth[];
  cost_sources: Record<CostSource, number>; // costed line value by where the cost came from
  /** Item names on lines in the range with no product — map them in Invoice Ledger › Item mapping. */
  unmapped_items: number;
};

const emptyCell = (): MarginCell => ({ revenue: 0, cost: 0, margin: 0, margin_pct: null, quantity: 0, not_costed: 0 });

function finish(cell: MarginCell): MarginCell {
  cell.margin = cell.revenue - cell.cost;
  cell.margin_pct = cell.revenue > 0 ? cell.margin / cell.revenue : null;
  return cell;
}

/** The OLD E-326 store (scripts/backfill-sales-invoice-lines.ts still fills it). */
export async function grossMarginTablesPresent(): Promise<boolean> {
  try {
    const res = (await db.execute<{ present: boolean }>(sql`
      SELECT (to_regclass('public.sales_invoice_lines') IS NOT NULL
          AND to_regclass('public.sales_invoice_item_products') IS NOT NULL
          AND to_regclass('public.sales_invoices') IS NOT NULL) AS present
    `)) as unknown as { present: boolean }[];
    return Boolean(res[0]?.present);
  } catch {
    return false;
  }
}

/** The line's type: its HSN (as invoiceLines.classifyHsn, plus scrap), else the mapped asset type. */
const LINE_TYPE: SQL = sql`CASE
    WHEN r.hsn LIKE '850790%' THEN 'other'
    WHEN r.hsn LIKE '8507%' THEN 'battery'
    WHEN r.hsn LIKE '850440%' THEN 'charger'
    WHEN r.hsn LIKE '8548%' OR r.hsn LIKE '8549%' THEN 'scrap'
    WHEN r.hsn IS NOT NULL THEN 'other'
    WHEN r.asset_type = 'battery' THEN 'battery'
    WHEN r.asset_type = 'charger' THEN 'charger'
    ELSE 'other' END`;

/** The mapped product's model id, which is what stock rows carry (inventory.model_type). */
const MODEL_ID: SQL = sql`CASE r.asset_type
    WHEN 'battery' THEN (SELECT b.model_id FROM product_master_batteries b WHERE b.id::text = r.product_id)
    WHEN 'charger' THEN (SELECT c.model_id FROM product_master_chargers c WHERE c.id::text = r.product_id)
    WHEN 'paraphernalia' THEN (SELECT pp.item_type_code FROM product_master_paraphernalia pp WHERE pp.id::text = r.product_id)
  END`;

type LineRow = {
  month: string;
  line_type: LineType;
  cost_source: CostSource | null;
  amount: string;
  quantity: string;
  cost: string | null;
};

type MonthRow = {
  month: string;
  invoices: number;
  line_revenue: string;
  invoices_without_lines: number;
  revenue_without_lines: string;
  credit_notes: string;
};

/**
 * `from` / `to` are inclusive YYYY-MM-DD bounds on the invoice date; omit
 * either for an open end.
 */
export async function grossMarginByMonth(
  opts: { from?: string | null; to?: string | null; runner?: Pick<typeof db, "execute"> } = {},
): Promise<GrossMarginReport> {
  const run = opts.runner ?? db;
  const report: GrossMarginReport = {
    available: await hasInvoiceLedgerTables(),
    months: [],
    cost_sources: { recent_invoices: 0, all_invoices: 0, price_book: 0 },
    unmapped_items: 0,
  };
  const lines = report.available ? await matchedLinesUnion() : null;
  if (!lines) return { ...report, available: false };
  const invoices = await matchedUnion();

  const range = sql.join(
    [
      REVENUE_NOT_VOID,
      sql`r.invoice_date IS NOT NULL`,
      ...(opts.from ? [sql`r.invoice_date >= ${opts.from}::date`] : []),
      ...(opts.to ? [sql`r.invoice_date <= ${opts.to}::date`] : []),
    ],
    sql` AND `,
  );

  // One row per month: invoices (with / without ledger lines) and credit notes.
  const monthRows = (await run.execute<MonthRow>(sql`
    WITH inv AS (
      SELECT r.source, to_char(r.invoice_date, 'YYYY-MM') AS month,
             (SELECT SUM(l.amount_excl_gst) FROM invoice_line_items l
               WHERE l.invoice_id = r.id
                 AND (l.source = r.source OR (r.source = 'drive' AND l.source IN ('vyapar', 'drive')))) AS line_total,
             CASE r.source
               WHEN 'drive'  THEN (SELECT si.sub_total FROM sales_invoices si WHERE si.id::text = r.id)
               WHEN 'credit' THEN (SELECT cn.sub_total FROM credit_notes cn WHERE cn.id::text = r.id)
             END AS taxable,
             r.total
        FROM ${invoices} AS r
       WHERE ${range}
    )
    SELECT month,
           COUNT(*) FILTER (WHERE source <> 'credit')::int                                    AS invoices,
           COALESCE(SUM(line_total) FILTER (WHERE source <> 'credit'), 0)                     AS line_revenue,
           COUNT(*) FILTER (WHERE source <> 'credit' AND line_total IS NULL)::int             AS invoices_without_lines,
           COALESCE(SUM(COALESCE(taxable, total)) FILTER (WHERE source <> 'credit' AND line_total IS NULL), 0) AS revenue_without_lines,
           COALESCE(SUM(COALESCE(taxable, ABS(total))) FILTER (WHERE source = 'credit'), 0)   AS credit_notes
      FROM inv
     GROUP BY 1
     ORDER BY 1
  `)) as unknown as MonthRow[];

  // Cost per line: recent stock cost, all stock cost, then the OEM price book —
  // all keyed on the product the Item mapping gave the line.
  const lineRows = (await run.execute<LineRow>(sql`
    SELECT to_char(r.invoice_date, 'YYYY-MM') AS month,
           ${LINE_TYPE}                       AS line_type,
           c.cost_source,
           SUM(r.amount_excl_gst)             AS amount,
           SUM(r.quantity)                    AS quantity,
           SUM(r.quantity * c.unit_cost)      AS cost
      FROM ${lines} AS r
      LEFT JOIN LATERAL (SELECT ${MODEL_ID} AS model_id) pm ON TRUE
      LEFT JOIN LATERAL (
        SELECT x.unit_cost, x.cost_source
          FROM (
            SELECT AVG(i.inventory_amount) AS unit_cost, 'recent_invoices'::text AS cost_source, 1 AS rank
              FROM inventory i
             WHERE i.asset_type = r.asset_type AND i.model_type = pm.model_id AND i.inventory_amount > 0
               AND i.oem_invoice_date::date <= r.invoice_date
               AND i.oem_invoice_date::date > r.invoice_date - ${RECENT_COST_DAYS}::int
            UNION ALL
            SELECT AVG(i.inventory_amount), 'all_invoices', 2
              FROM inventory i
             WHERE i.asset_type = r.asset_type AND i.model_type = pm.model_id AND i.inventory_amount > 0
            UNION ALL
            SELECT (SELECT o.oem_price
                      FROM oem_reference_prices o
                     WHERE o.asset_type = r.asset_type AND o.product_id = r.product_id
                     ORDER BY (o.effective_from::date <= r.invoice_date
                               AND (o.effective_to IS NULL OR o.effective_to::date > r.invoice_date)) DESC,
                              o.effective_from DESC
                     LIMIT 1), 'price_book', 3
          ) x
         WHERE x.unit_cost IS NOT NULL AND r.product_id IS NOT NULL
         ORDER BY x.rank
         LIMIT 1
      ) c ON TRUE
     WHERE ${range}
     GROUP BY 1, 2, 3
  `)) as unknown as LineRow[];

  const [unmapped] = (await run.execute<{ n: number }>(sql`
    SELECT COUNT(DISTINCT lower(btrim(r.item_name)))::int AS n
      FROM ${lines} AS r
     WHERE ${range} AND r.product_id IS NULL AND r.item_name IS NOT NULL
  `)) as unknown as Array<{ n: number }>;
  report.unmapped_items = unmapped?.n ?? 0;

  const months = new Map<string, MarginMonth>();
  for (const r of monthRows) {
    const credit = Number(r.credit_notes);
    months.set(r.month, {
      month: r.month,
      invoice_revenue: Number(r.line_revenue) + Number(r.revenue_without_lines) - credit,
      invoices: r.invoices,
      invoices_without_lines: r.invoices_without_lines,
      revenue_without_lines: Number(r.revenue_without_lines),
      credit_notes: credit,
      total: emptyCell(),
      by_type: Object.fromEntries(LINE_TYPES.map((t) => [t, emptyCell()])) as Record<LineType, MarginCell>,
    });
  }

  for (const r of lineRows) {
    const m = months.get(r.month);
    if (!m) continue;
    const cell = m.by_type[r.line_type] ?? m.by_type.other;
    const amount = Number(r.amount);
    if (r.cost_source && r.cost != null) {
      for (const c of [cell, m.total]) {
        c.revenue += amount;
        c.cost += Number(r.cost);
        c.quantity += Number(r.quantity);
      }
      report.cost_sources[r.cost_source] += amount;
    } else {
      cell.not_costed += amount;
      m.total.not_costed += amount;
    }
  }

  for (const m of months.values()) {
    finish(m.total);
    for (const t of LINE_TYPES) finish(m.by_type[t]);
  }
  report.months = [...months.values()];
  return report;
}

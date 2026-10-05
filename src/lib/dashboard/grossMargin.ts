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
 *   * Void invoices are out, as everywhere else revenue is counted.
 *
 * Source today is Drive sales invoices (sales_invoices + sales_invoice_lines,
 * E-326). Zoho-era invoices carry no line items until the ID 70 backfill.
 */

import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { LINES_TOLERANCE_MIN, LINES_TOLERANCE_PCT, LINE_TYPES, type LineType } from "@/lib/sales/salesInvoiceLines";

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
  /** Taxable value of every non-void invoice in the month — the base margin is compared with. */
  invoice_revenue: number;
  invoices: number;
  /** Invoices with no stored lines, or lines that do not add up. */
  invoices_without_lines: number;
  revenue_without_lines: number;
  total: MarginCell;
  by_type: Record<LineType, MarginCell>;
};

export type GrossMarginReport = {
  available: boolean; // false when E-326 is not applied on this database
  months: MarginMonth[];
  cost_sources: Record<CostSource, number>; // costed line value by where the cost came from
};

const emptyCell = (): MarginCell => ({ revenue: 0, cost: 0, margin: 0, margin_pct: null, quantity: 0, not_costed: 0 });

function finish(cell: MarginCell): MarginCell {
  cell.margin = cell.revenue - cell.cost;
  cell.margin_pct = cell.revenue > 0 ? cell.margin / cell.revenue : null;
  return cell;
}

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

/** Invoices that count: not void, with a taxable value. Alias `si`. */
const COUNTED_INVOICE = sql`si.status IS DISTINCT FROM 'void' AND si.invoice_date IS NOT NULL`;

/** Invoice ids whose stored lines add up to the taxable value. */
const TRUSTED_LINES = sql`(
  SELECT l.sales_invoice_id
    FROM sales_invoice_lines l
    JOIN sales_invoices s ON s.id = l.sales_invoice_id
   WHERE s.sub_total > 0
   GROUP BY l.sales_invoice_id, s.sub_total
  HAVING ABS(SUM(l.amount) - s.sub_total)
         <= GREATEST(${LINES_TOLERANCE_MIN}::numeric, s.sub_total * ${LINES_TOLERANCE_PCT}::numeric / 100)
)`;

/** The line's type: its HSN, else the mapped product's asset type. */
const LINE_TYPE: SQL = sql`CASE
    WHEN l.hsn_code LIKE '8507%' THEN 'battery'
    WHEN l.hsn_code LIKE '850440%' THEN 'charger'
    WHEN l.hsn_code LIKE '8548%' OR l.hsn_code LIKE '8549%' THEN 'scrap'
    WHEN l.hsn_code IS NOT NULL THEN 'other'
    WHEN lower(p.asset_type) LIKE '%batter%' THEN 'battery'
    WHEN lower(p.asset_type) LIKE '%charger%' THEN 'charger'
    ELSE 'other' END`;

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
  invoice_revenue: string;
  invoices_without_lines: number;
  revenue_without_lines: string;
};

/**
 * `from` / `to` are inclusive YYYY-MM-DD bounds on the invoice date; omit
 * either for an open end.
 */
export async function grossMarginByMonth(
  opts: { from?: string | null; to?: string | null; runner?: Pick<typeof db, "execute"> } = {},
): Promise<GrossMarginReport> {
  // `runner` lets scripts/verify-id72-gross-margin.ts read inside its own transaction.
  const run = opts.runner ?? db;
  const report: GrossMarginReport = {
    available: await grossMarginTablesPresent(),
    months: [],
    cost_sources: { recent_invoices: 0, all_invoices: 0, price_book: 0 },
  };
  if (!report.available) return report;

  const range = sql.join(
    [
      COUNTED_INVOICE,
      ...(opts.from ? [sql`si.invoice_date >= ${opts.from}::date`] : []),
      ...(opts.to ? [sql`si.invoice_date <= ${opts.to}::date`] : []),
    ],
    sql` AND `,
  );

  const monthRows = (await run.execute<MonthRow>(sql`
    SELECT to_char(si.invoice_date, 'YYYY-MM')                                  AS month,
           COUNT(*)::int                                                        AS invoices,
           COALESCE(SUM(si.sub_total), 0)                                       AS invoice_revenue,
           COUNT(*) FILTER (WHERE tl.sales_invoice_id IS NULL)::int             AS invoices_without_lines,
           COALESCE(SUM(si.sub_total) FILTER (WHERE tl.sales_invoice_id IS NULL), 0) AS revenue_without_lines
      FROM sales_invoices si
      LEFT JOIN ${TRUSTED_LINES} tl ON tl.sales_invoice_id = si.id
     WHERE ${range}
     GROUP BY 1
     ORDER BY 1
  `)) as unknown as MonthRow[];

  const lineRows = (await run.execute<LineRow>(sql`
    SELECT to_char(si.invoice_date, 'YYYY-MM') AS month,
           ${LINE_TYPE}                        AS line_type,
           c.cost_source,
           SUM(l.amount)                       AS amount,
           SUM(l.quantity)                     AS quantity,
           SUM(l.quantity * c.unit_cost)       AS cost
      FROM sales_invoice_lines l
      JOIN sales_invoices si ON si.id = l.sales_invoice_id
      JOIN ${TRUSTED_LINES} tl ON tl.sales_invoice_id = si.id
      LEFT JOIN sales_invoice_item_products m ON m.item_key = l.item_key
      LEFT JOIN products p ON p.id = m.product_id
      LEFT JOIN LATERAL (
        SELECT x.unit_cost, x.cost_source
          FROM (
            SELECT AVG(i.inventory_amount) AS unit_cost, 'recent_invoices'::text AS cost_source, 1 AS rank
              FROM inventory i
             WHERE i.product_id = m.product_id AND i.inventory_amount > 0
               AND i.oem_invoice_date::date <= si.invoice_date
               AND i.oem_invoice_date::date > si.invoice_date - ${RECENT_COST_DAYS}::int
            UNION ALL
            SELECT AVG(i.inventory_amount), 'all_invoices', 2
              FROM inventory i
             WHERE i.product_id = m.product_id AND i.inventory_amount > 0
            UNION ALL
            SELECT (SELECT r.oem_price
                      FROM oem_reference_prices r
                     WHERE r.product_id = m.product_id::text
                     ORDER BY (r.effective_from::date <= si.invoice_date
                               AND (r.effective_to IS NULL OR r.effective_to::date > si.invoice_date)) DESC,
                              r.effective_from DESC
                     LIMIT 1), 'price_book', 3
          ) x
         WHERE x.unit_cost IS NOT NULL AND m.product_id IS NOT NULL
         ORDER BY x.rank
         LIMIT 1
      ) c ON TRUE
     WHERE ${range}
     GROUP BY 1, 2, 3
  `)) as unknown as LineRow[];

  const months = new Map<string, MarginMonth>();
  for (const r of monthRows) {
    months.set(r.month, {
      month: r.month,
      invoice_revenue: Number(r.invoice_revenue),
      invoices: r.invoices,
      invoices_without_lines: r.invoices_without_lines,
      revenue_without_lines: Number(r.revenue_without_lines),
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

// ── Item → product mapping ────────────────────────────────────────────────

export type ItemMapping = {
  item_key: string;
  item_name: string;
  product_id: string | null;
  product_name: string | null;
  auto_matched: boolean;
  lines: number;
  amount: number;
};

export type ProductOption = { id: string; name: string; asset_type: string | null; has_cost: boolean };

/** Every invoice item, unmapped first, then by the line value riding on it. */
export async function listItemMappings(): Promise<ItemMapping[]> {
  const rows = (await db.execute<Omit<ItemMapping, "amount"> & { amount: string }>(sql`
    SELECT m.item_key, m.item_name, m.product_id, p.name AS product_name, m.auto_matched,
           COUNT(l.id)::int AS lines, COALESCE(SUM(l.amount), 0) AS amount
      FROM sales_invoice_item_products m
      LEFT JOIN products p ON p.id = m.product_id
      LEFT JOIN sales_invoice_lines l ON l.item_key = m.item_key
     GROUP BY m.item_key, m.item_name, m.product_id, p.name, m.auto_matched
     ORDER BY (m.product_id IS NULL) DESC, m.auto_matched DESC, COALESCE(SUM(l.amount), 0) DESC
  `)) as unknown as Array<Omit<ItemMapping, "amount"> & { amount: string }>;
  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}

/** Products an item can be mapped to; has_cost = stock or a price-book line exists. */
export async function listMarginProducts(): Promise<ProductOption[]> {
  return (await db.execute<ProductOption>(sql`
    SELECT p.id, p.name, p.asset_type,
           (EXISTS (SELECT 1 FROM inventory i WHERE i.product_id = p.id AND i.inventory_amount > 0)
            OR EXISTS (SELECT 1 FROM oem_reference_prices r WHERE r.product_id = p.id::text)) AS has_cost
      FROM products p
     ORDER BY p.name
  `)) as unknown as ProductOption[];
}

/** Map an item to a product (or clear it with null). A person's choice is never auto_matched. */
export async function setItemProduct(itemKey: string, productId: string | null, userId: string): Promise<boolean> {
  if (productId) {
    const found = (await db.execute<{ id: string }>(sql`SELECT id FROM products WHERE id = ${productId}::uuid LIMIT 1`)) as unknown as { id: string }[];
    if (found.length === 0) return false;
  }
  const updated = (await db.execute<{ item_key: string }>(sql`
    UPDATE sales_invoice_item_products
       SET product_id = ${productId}::uuid, auto_matched = FALSE, mapped_by = ${userId}::uuid, updated_at = now()
     WHERE item_key = ${itemKey}
     RETURNING item_key
  `)) as unknown as { item_key: string }[];
  return updated.length > 0;
}

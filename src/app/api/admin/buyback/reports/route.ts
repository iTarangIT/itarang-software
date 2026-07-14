/**
 * GET /api/admin/buyback/reports?type=...   (M22)
 *
 *   AC: "no report reads live catalog prices."
 *
 * THAT IS THE ONLY RULE THAT MATTERS HERE, and it is easy to break by accident.
 * `catalog_variants.est_buyback_price_working` is right there, it joins cleanly,
 * and a margin report built on it would look correct — until someone repriced the
 * catalog, at which point every historical deal's margin would silently change.
 * Last quarter's numbers would move because someone edited a price today.
 *
 * So every rupee below comes from `deal_line_locks`: dealer_price, margin_value
 * and vendor_price, frozen at agreement and fill-once. The catalog is joined ONLY
 * for the battery's name.
 *
 * Two margins are reported, and they are not the same number:
 *   · planned  = Σ qty × margin_value              — the uplift we set
 *   · realised = Σ qty × (vendor_price − dealer)   — what we actually earned
 * A vendor haggled above our ask earns us more than we planned. Reporting only
 * the planned figure would understate every well-negotiated deal.
 *
 * Types: `margin` · `funnel` · `aging` · `dealer` · `vendor`
 * Add `&format=csv` to export any of them.
 */

import { sql } from "drizzle-orm";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { requireBuybackAdmin } from "@/lib/buyback/auth";
import { ValidationError } from "@/lib/buyback/errors";

export const runtime = "nodejs";

const REPORTS = ["margin", "funnel", "aging", "dealer", "vendor"] as const;
type ReportType = (typeof REPORTS)[number];

/**
 * Per-SKU economics for every deal that has locks, from the CURRENT lock
 * generation only. A reopen writes a new generation; the old one stays on disk for
 * the audit trail but stops being read — which is what makes a reopened deal
 * report its NEW price rather than double-counting both.
 */
const LOCKED = sql`
  SELECT
    bd.id            AS deal_id,
    bd.status,
    br.id            AS request_id,
    br.request_no,
    br.created_at    AS raised_at,
    da.id            AS dealer_id,
    da.business_entity_name AS dealer,
    va.business_entity_name AS vendor,
    SUM(bl.quantity)                                          AS units,
    SUM(bl.quantity * dll.dealer_price)                       AS dealer_total,
    SUM(bl.quantity * dll.margin_value)                       AS planned_margin,
    SUM(bl.quantity * COALESCE(dll.vendor_price - dll.dealer_price, 0)) AS realised_margin,
    SUM(bl.quantity * COALESCE(dll.vendor_price, 0))          AS vendor_total
  FROM deal_line_locks dll
  JOIN buyback_deals bd    ON bd.id = dll.deal_id AND bd.offer_version = dll.offer_version
  JOIN buyback_requests br ON br.id = bd.request_id
  JOIN accounts da         ON da.id = br.dealer_entity_id
  JOIN buyback_lines bl    ON bl.id = dll.line_id
  LEFT JOIN vendor_threads vt ON vt.deal_id = bd.id AND vt.status = 'AGREED'
  LEFT JOIN scrap_vendors sv  ON sv.id = vt.vendor_id
  LEFT JOIN accounts va       ON va.id = sv.entity_id
  GROUP BY bd.id, bd.status, br.id, br.request_no, br.created_at, da.id,
           da.business_entity_name, va.business_entity_name
`;

async function runReport(type: ReportType) {
  switch (type) {
    case "margin":
      return {
        columns: [
          "Request",
          "Dealer",
          "Vendor",
          "Status",
          "Units",
          "Paid to dealer",
          "Received from vendor",
          "Planned margin",
          "Realised margin",
        ],
        rows: (await db.execute(sql`
          SELECT request_no, dealer, COALESCE(vendor, '—') AS vendor, status, units,
                 dealer_total, vendor_total, planned_margin, realised_margin
          FROM (${LOCKED}) locked
          ORDER BY raised_at DESC
        `)) as unknown as Array<Record<string, unknown>>,
      };

    case "funnel":
      // Where deals die. A funnel built on counts alone hides the fact that the
      // ones dying late are the expensive ones, so the value is carried too.
      return {
        columns: ["Status", "Deals", "Units", "Value at stake"],
        rows: (await db.execute(sql`
          SELECT bd.status,
                 count(*)::int                                   AS deals,
                 COALESCE(SUM(l.units), 0)                       AS units,
                 COALESCE(SUM(l.dealer_total), 0)                AS value_at_stake
          FROM buyback_deals bd
          LEFT JOIN (${LOCKED}) l ON l.deal_id = bd.id
          GROUP BY bd.status
          ORDER BY count(*) DESC
        `)) as unknown as Array<Record<string, unknown>>,
      };

    case "aging":
      // Deals sitting still. Terminal states are excluded: a CLOSED deal is not
      // "aging", it is finished, and including it would bury the live ones.
      return {
        columns: ["Request", "Dealer", "Status", "Days open", "Value"],
        rows: (await db.execute(sql`
          SELECT br.request_no, da.business_entity_name AS dealer, bd.status,
                 FLOOR(EXTRACT(EPOCH FROM (now() - bd.updated_at)) / 86400)::int AS days_open,
                 COALESCE(l.dealer_total, 0) AS value
          FROM buyback_deals bd
          JOIN buyback_requests br ON br.id = bd.request_id
          JOIN accounts da         ON da.id = br.dealer_entity_id
          LEFT JOIN (${LOCKED}) l  ON l.deal_id = bd.id
          WHERE bd.status NOT IN ('CLOSED', 'REJECTED', 'CANCELLED')
          ORDER BY bd.updated_at ASC
        `)) as unknown as Array<Record<string, unknown>>,
      };

    case "dealer":
      return {
        columns: ["Dealer", "Requests", "Closed", "Units", "Paid out", "Margin earned"],
        rows: (await db.execute(sql`
          SELECT dealer,
                 count(*)::int                                              AS requests,
                 count(*) FILTER (WHERE status = 'CLOSED')::int             AS closed,
                 SUM(units)                                                 AS units,
                 SUM(dealer_total)                                          AS paid_out,
                 SUM(realised_margin) FILTER (WHERE status = 'CLOSED')      AS margin_earned
          FROM (${LOCKED}) locked
          GROUP BY dealer
          ORDER BY SUM(dealer_total) DESC
        `)) as unknown as Array<Record<string, unknown>>,
      };

    case "vendor":
      // Bid-to-win and payment days are what BRD M22 actually asks for — a vendor
      // who bids on everything and wins nothing is costing us quotation effort,
      // and one who wins and pays late is costing us cash.
      return {
        columns: ["Vendor", "Quoted on", "Won", "Bid-to-win", "Bought", "Avg days to pay"],
        rows: (await db.execute(sql`
          SELECT
            a.business_entity_name AS vendor,
            count(*)::int                                            AS quoted_on,
            count(*) FILTER (WHERE vt.status = 'AGREED')::int         AS won,
            ROUND(
              100.0 * count(*) FILTER (WHERE vt.status = 'AGREED') / NULLIF(count(*), 0)
            )::int || '%'                                             AS bid_to_win,
            COALESCE(SUM(
              CASE WHEN vt.status = 'AGREED' THEN (
                SELECT SUM(bl.quantity * dll.vendor_price)
                FROM deal_line_locks dll
                JOIN buyback_lines bl ON bl.id = dll.line_id
                JOIN buyback_deals bd2 ON bd2.id = dll.deal_id
                                      AND bd2.offer_version = dll.offer_version
                WHERE dll.deal_id = vt.deal_id
              ) ELSE 0 END
            ), 0)                                                     AS bought,
            ROUND(AVG(
              EXTRACT(EPOCH FROM (st.closed_at - i.approved_at)) / 86400
            ))::int                                                   AS avg_days_to_pay
          FROM vendor_threads vt
          JOIN scrap_vendors sv ON sv.id = vt.vendor_id
          JOIN accounts a       ON a.id = sv.entity_id
          LEFT JOIN invoices i  ON i.deal_id = vt.deal_id AND i.leg = 'VENDOR'
          LEFT JOIN settlement_transactions st
                                ON st.deal_id = vt.deal_id AND st.leg = 'VENDOR'
          GROUP BY a.business_entity_name
          ORDER BY count(*) FILTER (WHERE vt.status = 'AGREED') DESC
        `)) as unknown as Array<Record<string, unknown>>,
      };
  }
}

export const GET = withErrorHandler(async (req: Request) => {
  await requireBuybackAdmin();

  const url = new URL(req.url);
  const type = (url.searchParams.get("type") ?? "margin") as ReportType;

  if (!REPORTS.includes(type)) {
    throw new ValidationError(`Unknown report "${type}". Try: ${REPORTS.join(", ")}.`);
  }

  const report = await runReport(type);

  if (url.searchParams.get("format") === "csv") {
    const esc = (v: unknown) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const csv = [
      report.columns.join(","),
      ...report.rows.map((r) => Object.values(r).map(esc).join(",")),
    ].join("\n");

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="buyback-${type}.csv"`,
      },
    });
  }

  return successResponse({
    type,
    columns: report.columns,
    rows: report.rows,
    // Stated, not implied. The AC is that no report reads live catalog prices, and
    // a reader of this payload should be able to see that claim being made.
    source: "deal_line_locks (frozen at agreement) — never live catalog prices",
  });
});

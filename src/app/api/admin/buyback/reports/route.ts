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
 *
 * E-192-C (scale pack): the LOCKED CTE below used to full-scan
 * `deal_line_locks` on every call with no bound at all. It now takes an
 * optional `from`/`to` window (filtering on `br.created_at`, i.e. when the
 * request was raised — the same column the margin report already exposed as
 * `raised_at`). `?from=`/`?to=` on the route default, per type, to:
 *
 *   - margin / dealer / vendor → last 12 months (raised_at / their
 *     underlying deals' raised_at)
 *   - funnel                   → last 12 months, but bounded on the DEAL's
 *     own `created_at` (funnel counts every buyback_deals row, not just ones
 *     with locks — LOCKED itself is also bounded to the same window purely
 *     to keep its scan cheap; a deal and its request are created together in
 *     practice, so the two bounds agree)
 *   - aging                    → left UNBOUNDED. It already only reads
 *     non-terminal deals (`status NOT IN ('CLOSED','REJECTED','CANCELLED')`),
 *     so it is inherently active-only, not all-time — a deal stuck open for
 *     13 months is exactly the one this report exists to surface, and a
 *     12-month window would silently drop it.
 *
 * As before, `dealer`/`vendor` are ordered by their main rupee-volume metric
 * DESC. Both now take `?limit=` (default 200, max 1000) and, when the result
 * is capped, return `has_more`.
 *
 * Passing an explicit `from`/`to` opts a caller back out of the type's
 * default window, same convention as the ledger route.
 */

import { sql } from "drizzle-orm";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { requireBuybackAdmin } from "@/lib/buyback/auth";
import { ValidationError } from "@/lib/buyback/errors";

export const runtime = "nodejs";

const REPORTS = ["margin", "funnel", "aging", "dealer", "vendor"] as const;
type ReportType = (typeof REPORTS)[number];

const DEFAULT_WINDOW_DAYS = 365;
const DEFAULT_BREAKDOWN_LIMIT = 200;
const MAX_BREAKDOWN_LIMIT = 1000;

/**
 * Clamp an optional `?limit=` query param to a safe integer. Mirrors
 * queue/route.ts and ledger/route.ts.
 */
function parseIntParam(raw: string | null, fallback: number, opts?: { min?: number; max?: number }): number {
  const n = raw === null ? NaN : Number(raw);
  const min = opts?.min ?? 0;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) return fallback;
  return opts?.max !== undefined ? Math.min(n, opts.max) : n;
}

/** ISO date (`YYYY-MM-DD`) `days` ago, for a report type's default window. */
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Per-SKU economics for every deal that has locks, from the CURRENT lock
 * generation only. A reopen writes a new generation; the old one stays on disk for
 * the audit trail but stops being read — which is what makes a reopened deal
 * report its NEW price rather than double-counting both.
 *
 * `from`/`to` (nullable ISO dates) bound `br.created_at` — pass `null, null`
 * for the unbounded scan (aging's case).
 */
function lockedCte(from: string | null, to: string | null) {
  return sql`
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
    WHERE (${from}::date IS NULL OR br.created_at >= ${from}::date)
      AND (${to}::date   IS NULL OR br.created_at <= ${to}::date)
    GROUP BY bd.id, bd.status, br.id, br.request_no, br.created_at, da.id,
             da.business_entity_name, va.business_entity_name
  `;
}

async function runReport(type: ReportType, from: string | null, to: string | null, limit: number) {
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
          // Ext-4: the buyback admin dashboard's "Margin by month" chart groups
          // these rows by month — it needs a timestamp per row to group on.
          // `raised_at` is the request's created_at, already computed (and
          // already named raised_at) by the LOCKED CTE for its own ORDER BY;
          // this just also selects it out. Additive — appended, not inserted,
          // so any existing positional CSV consumer's first 9 columns are
          // untouched.
          "Raised at",
          // Ext-6 (Payments & Settlement page): the request's id, so a UI can
          // deep-link `/admin/buyback/{request_id}` without a second lookup.
          // The LOCKED CTE already selects `request_id` for its own joins —
          // this just also exposes it. Additive — appended last.
          "Request ID",
        ],
        rows: (await db.execute(sql`
          SELECT request_no, dealer, COALESCE(vendor, '—') AS vendor, status, units,
                 dealer_total, vendor_total, planned_margin, realised_margin, raised_at,
                 request_id
          FROM (${lockedCte(from, to)}) locked
          ORDER BY raised_at DESC
        `)) as unknown as Array<Record<string, unknown>>,
      };

    case "funnel": {
      // Where deals die. A funnel built on counts alone hides the fact that the
      // ones dying late are the expensive ones, so the value is carried too.
      // Bounded on the DEAL's own created_at (not LOCKED's raised_at) — funnel
      // counts every buyback_deals row, including ones with no locks yet.
      return {
        columns: ["Status", "Deals", "Units", "Value at stake"],
        rows: (await db.execute(sql`
          SELECT bd.status,
                 count(*)::int                                   AS deals,
                 COALESCE(SUM(l.units), 0)                       AS units,
                 COALESCE(SUM(l.dealer_total), 0)                AS value_at_stake
          FROM buyback_deals bd
          LEFT JOIN (${lockedCte(from, to)}) l ON l.deal_id = bd.id
          WHERE (${from}::date IS NULL OR bd.created_at >= ${from}::date)
            AND (${to}::date   IS NULL OR bd.created_at <= ${to}::date)
          GROUP BY bd.status
          ORDER BY count(*) DESC
        `)) as unknown as Array<Record<string, unknown>>,
      };
    }

    case "aging":
      // Deals sitting still. Terminal states are excluded: a CLOSED deal is not
      // "aging", it is finished, and including it would bury the live ones.
      // Deliberately UNBOUNDED by time — see file docblock. The `status NOT
      // IN (...)` clause already restricts this to active deals only, so a
      // deal open for 13 months is exactly what this report must still show.
      return {
        columns: ["Request", "Dealer", "Status", "Days open", "Value"],
        rows: (await db.execute(sql`
          SELECT br.request_no, da.business_entity_name AS dealer, bd.status,
                 FLOOR(EXTRACT(EPOCH FROM (now() - bd.updated_at)) / 86400)::int AS days_open,
                 COALESCE(l.dealer_total, 0) AS value
          FROM buyback_deals bd
          JOIN buyback_requests br ON br.id = bd.request_id
          JOIN accounts da         ON da.id = br.dealer_entity_id
          LEFT JOIN (${lockedCte(null, null)}) l  ON l.deal_id = bd.id
          WHERE bd.status NOT IN ('CLOSED', 'REJECTED', 'CANCELLED')
          ORDER BY bd.updated_at ASC
        `)) as unknown as Array<Record<string, unknown>>,
      };

    case "dealer": {
      const raw = (await db.execute(sql`
        SELECT dealer,
               count(*)::int                                              AS requests,
               count(*) FILTER (WHERE status = 'CLOSED')::int             AS closed,
               SUM(units)                                                 AS units,
               SUM(dealer_total)                                          AS paid_out,
               SUM(realised_margin) FILTER (WHERE status = 'CLOSED')      AS margin_earned
        FROM (${lockedCte(from, to)}) locked
        GROUP BY dealer
        ORDER BY SUM(dealer_total) DESC
        LIMIT ${limit + 1}
      `)) as unknown as Array<Record<string, unknown>>;
      const has_more = raw.length > limit;
      return {
        columns: ["Dealer", "Requests", "Closed", "Units", "Paid out", "Margin earned"],
        rows: has_more ? raw.slice(0, limit) : raw,
        has_more,
      };
    }

    case "vendor": {
      // Bid-to-win and payment days are what BRD M22 actually asks for — a vendor
      // who bids on everything and wins nothing is costing us quotation effort,
      // and one who wins and pays late is costing us cash. Bounded on
      // `vt.created_at` (when the vendor was quoted) — the underlying "deals"
      // for a vendor breakdown. Ordered by `bought` (rupee volume), matching
      // dealer's `paid_out` — not by win-count, which is a rate, not a volume.
      const raw = (await db.execute(sql`
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
        WHERE (${from}::date IS NULL OR vt.created_at >= ${from}::date)
          AND (${to}::date   IS NULL OR vt.created_at <= ${to}::date)
        GROUP BY a.business_entity_name
        ORDER BY bought DESC
        LIMIT ${limit + 1}
      `)) as unknown as Array<Record<string, unknown>>;
      const has_more = raw.length > limit;
      return {
        columns: ["Vendor", "Quoted on", "Won", "Bid-to-win", "Bought", "Avg days to pay"],
        rows: has_more ? raw.slice(0, limit) : raw,
        has_more,
      };
    }
  }
}

export const GET = withErrorHandler(async (req: Request) => {
  await requireBuybackAdmin();

  const url = new URL(req.url);
  const type = (url.searchParams.get("type") ?? "margin") as ReportType;

  if (!REPORTS.includes(type)) {
    throw new ValidationError(`Unknown report "${type}". Try: ${REPORTS.join(", ")}.`);
  }

  const rawFrom = url.searchParams.get("from");
  const rawTo = url.searchParams.get("to");
  // Default window: last 12 months, but ONLY when neither `from` nor `to`
  // was given explicitly (aging ignores both — it's active-only, see above).
  const from = rawFrom ?? (rawFrom === null && rawTo === null ? isoDaysAgo(DEFAULT_WINDOW_DAYS) : null);
  const to = rawTo;

  const limit = parseIntParam(url.searchParams.get("limit"), DEFAULT_BREAKDOWN_LIMIT, {
    min: 1,
    max: MAX_BREAKDOWN_LIMIT,
  });

  // aging ignores from/to entirely (hardcodes lockedCte(null, null) — see the
  // case above) so passing the computed window through is harmless for it.
  const report = await runReport(type, from, to, limit);

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
    // Additive — only dealer/vendor are ever capped, so this is `false` for
    // margin/funnel/aging (whose `report` has no such field).
    has_more: "has_more" in report ? report.has_more : false,
    // Stated, not implied. The AC is that no report reads live catalog prices, and
    // a reader of this payload should be able to see that claim being made.
    source: "deal_line_locks (frozen at agreement) — never live catalog prices",
  });
});

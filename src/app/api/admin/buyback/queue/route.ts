/**
 * GET /api/admin/buyback/queue
 *
 * The review queue (BRD M06). Columns match the design handoff:
 * Request · Dealer · Provenance · Dealer quote · SLA aging · Status.
 *
 * Closed/terminal deals drop out; DRAFTs never appear (the dealer hasn't
 * submitted them). ORDER BY is backed by the E-192
 * buyback_requests_submitted_created_idx (submitted_at NULLS LAST,
 * created_at) — there was no supporting index for this sort before.
 *
 * Ext-5 (admin Negotiations screen): two additive per-row fields —
 * `neg_rounds` (count of DEALER-leg negotiation_rounds) and
 * `last_offer_total` (Σ qty × offered_price_per_unit over the DEALER leg's
 * latest round, NULL when there is no round yet). `offer_version` was
 * already selected/returned before this change. Nothing existing was
 * renamed or removed.
 *
 * E-192 (scale pack for 10K+ dealers):
 *  - The four correlated subqueries that all re-scanned
 *    `buyback_lines JOIN buyback_batches WHERE bb.request_id = br.id`
 *    (total_units, dealer_quote, line_count, lines_with_provenance) are
 *    collapsed into ONE `LEFT JOIN LATERAL` (`agg`) that scans that join
 *    once per request instead of four times. Output field names and values
 *    are unchanged — same aliases, same types (dealer_quote stays
 *    uncast/NUMERIC, the rest stay ::int), same NULL/0 semantics.
 *  - `neg_rounds`/`last_offer_total` are untouched — different tables, no
 *    scan to share.
 *  - Optional `?limit=`/`?offset=` pagination, additive: no query params ⇒
 *    limit defaults to 500 (max 1000), offset to 0 — same as before this
 *    change for any caller that doesn't pass them. Response gains
 *    `has_more`; `queue` keeps its existing shape.
 *  - `scope=all` (documents picker) still works — the picker itself moves to
 *    a typeahead (AdminBuybackSearch) instead of loading this with scope=all,
 *    but the param stays supported for any other/future caller.
 */

import { sql } from "drizzle-orm";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { requireBuybackAdmin } from "@/lib/buyback/auth";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

/**
 * Clamp an optional `?limit=`/`?offset=` query param to a safe integer.
 * Missing/non-numeric/non-integer/out-of-range → `fallback`, never NaN or a
 * negative LIMIT/OFFSET reaching the query.
 */
function parseIntParam(raw: string | null, fallback: number, opts?: { min?: number; max?: number }): number {
  const n = raw === null ? NaN : Number(raw);
  const min = opts?.min ?? 0;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) return fallback;
  return opts?.max !== undefined ? Math.min(n, opts.max) : n;
}

export const GET = withErrorHandler(async (request: Request) => {
  await requireBuybackAdmin();

  const { searchParams } = new URL(request.url);
  const scope = searchParams.get("scope");

  // Additive pagination — absent params behave exactly as before (limit 500,
  // offset 0), so every existing caller keeps working unchanged.
  const limit = parseIntParam(searchParams.get("limit"), DEFAULT_LIMIT, { min: 1, max: MAX_LIMIT });
  const offset = parseIntParam(searchParams.get("offset"), 0, { min: 0 });

  // Documents picker uses scope=all to reach CLOSED/SETTLED deals for audit
  const statusFilter =
    scope === "all"
      ? sql`bd.status NOT IN ('DRAFT')`
      : sql`bd.status NOT IN ('DRAFT', 'CLOSED', 'SETTLED', 'REJECTED', 'CANCELLED')`;

  const rows = await db.execute(sql`
    SELECT
      br.id           AS request_id,
      br.request_no,
      br.source_channel,
      br.created_at,
      br.submitted_at,
      bd.status,
      bd.offer_version,
      a.business_entity_name AS dealer_name,
      a.city                 AS dealer_city,

      -- The dealer's asking value, derived from the LINES (never stored on the
      -- request — invariant 1). Provenance completeness across ALL lines (the
      -- prototype only looked at the first line, which reported 100% on a
      -- request whose second line had nothing at all).
      --
      -- E-192: these four used to be four separate correlated subqueries,
      -- each independently re-joining buyback_lines to buyback_batches for
      -- the same request. Collapsed into one LATERAL that does that join
      -- once. Same aliases/types/NULL-handling as before.
      agg.total_units,
      agg.dealer_quote,
      agg.line_count,
      agg.lines_with_provenance,

      -- SLA aging: days sitting in the queue since submit.
      GREATEST(0, EXTRACT(DAY FROM (now() - coalesce(br.submitted_at, br.created_at))))::int
        AS days_in_queue,

      -- Same aging, in hours — additive: days_in_queue floors sub-24h requests
      -- to "0d in queue", which reads as broken for anything submitted today.
      GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - coalesce(br.submitted_at, br.created_at))) / 3600))::int
        AS hours_in_queue,

      -- Ext-5 (Negotiations screen): how many DEALER-leg negotiation rounds this
      -- deal has been through, and what the dealer's most recent round asked for
      -- in total. Additive — two new columns, nothing existing renamed/removed.
      (SELECT count(*)::int
         FROM negotiation_rounds nr
        WHERE nr.deal_id = bd.id AND nr.leg = 'DEALER') AS neg_rounds,

      -- Σ qty × offered_price_per_unit over the DEALER leg's latest round only
      -- (highest round_no) — NULL, not 0, when there is no round yet, so the UI
      -- can render "—" rather than a misleading ₹0.
      (SELECT sum(bl.quantity * nrl.offered_price_per_unit)
         FROM negotiation_round_lines nrl
         JOIN buyback_lines bl ON bl.id = nrl.line_id
        WHERE nrl.round_id = (
          SELECT nr2.id FROM negotiation_rounds nr2
           WHERE nr2.deal_id = bd.id AND nr2.leg = 'DEALER'
           ORDER BY nr2.round_no DESC
           LIMIT 1
        )) AS last_offer_total

    FROM buyback_requests br
    JOIN buyback_deals bd ON bd.request_id = br.id
    LEFT JOIN accounts a  ON a.id = br.dealer_entity_id
    LEFT JOIN LATERAL (
      SELECT
        count(*)::int                                                          AS line_count,
        coalesce(sum(bl.quantity), 0)::int                                     AS total_units,
        coalesce(sum(bl.quantity * coalesce(bl.expected_price_per_unit, 0)), 0) AS dealer_quote,
        (count(*) FILTER (
           WHERE EXISTS (
             SELECT 1 FROM provenance_records pr
              WHERE pr.line_id = bl.id AND pr.scope = 'LINE'
           )
         ))::int                                                                AS lines_with_provenance
      FROM buyback_lines bl
      JOIN buyback_batches bb ON bb.id = bl.batch_id
      WHERE bb.request_id = br.id
    ) agg ON true
    WHERE ${statusFilter}
    ORDER BY br.submitted_at ASC NULLS LAST, br.created_at ASC
    LIMIT ${limit + 1} OFFSET ${offset}
  `);

  const allRows = rows as unknown as Array<Record<string, unknown>>;
  const has_more = allRows.length > limit;
  const pageRows = has_more ? allRows.slice(0, limit) : allRows;

  const queue = pageRows.map((r) => {
    const lineCount = Number(r.line_count);
    const withProv = Number(r.lines_with_provenance);

    return {
      request_id: String(r.request_id),
      request_no: String(r.request_no),
      source_channel: String(r.source_channel),
      status: String(r.status),
      offer_version: Number(r.offer_version),
      dealer_name: (r.dealer_name as string) ?? "—",
      dealer_city: (r.dealer_city as string) ?? null,
      total_units: Number(r.total_units),
      dealer_quote: Number(r.dealer_quote),
      // 0 lines → 0%, not a divide-by-zero NaN.
      provenance_pct: lineCount === 0 ? 0 : Math.round((withProv / lineCount) * 100),
      days_in_queue: Number(r.days_in_queue),
      hours_in_queue: Number(r.hours_in_queue),
      created_at: r.created_at,
      submitted_at: r.submitted_at,
      // Ext-5 — additive. last_offer_total stays null (never 0) when no round
      // has been made yet.
      neg_rounds: Number(r.neg_rounds),
      last_offer_total: r.last_offer_total === null ? null : Number(r.last_offer_total),
    };
  });

  return successResponse({ queue, has_more });
});

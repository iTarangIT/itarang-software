/**
 * GET /api/admin/buyback/queue
 *
 * The review queue (BRD M06). Columns match the design handoff:
 * Request · Dealer · Provenance · Dealer quote · SLA aging · Status.
 *
 * Closed/terminal deals drop out; DRAFTs never appear (the dealer hasn't
 * submitted them). Backed by the (status, created_at) index from E-185.
 *
 * Ext-5 (admin Negotiations screen): two additive per-row fields —
 * `neg_rounds` (count of DEALER-leg negotiation_rounds) and
 * `last_offer_total` (Σ qty × offered_price_per_unit over the DEALER leg's
 * latest round, NULL when there is no round yet). `offer_version` was
 * already selected/returned before this change. Nothing existing was
 * renamed or removed.
 */

import { sql } from "drizzle-orm";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { requireBuybackAdmin } from "@/lib/buyback/auth";

export const runtime = "nodejs";

export const GET = withErrorHandler(async (request: Request) => {
  await requireBuybackAdmin();

  const { searchParams } = new URL(request.url);
  const scope = searchParams.get("scope");

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

      (SELECT coalesce(sum(bl.quantity), 0)::int
         FROM buyback_lines bl JOIN buyback_batches bb ON bb.id = bl.batch_id
        WHERE bb.request_id = br.id) AS total_units,

      -- The dealer's asking value, derived from the LINES (never stored on the
      -- request — invariant 1).
      (SELECT coalesce(sum(bl.quantity * bl.expected_price_per_unit), 0)
         FROM buyback_lines bl JOIN buyback_batches bb ON bb.id = bl.batch_id
        WHERE bb.request_id = br.id) AS dealer_quote,

      -- Provenance completeness across ALL lines (the prototype only looked at
      -- the first line, which reported 100% on a request whose second line had
      -- nothing at all).
      (SELECT count(*)::int
         FROM buyback_lines bl JOIN buyback_batches bb ON bb.id = bl.batch_id
        WHERE bb.request_id = br.id) AS line_count,
      (SELECT count(*)::int
         FROM buyback_lines bl JOIN buyback_batches bb ON bb.id = bl.batch_id
        WHERE bb.request_id = br.id
          AND EXISTS (SELECT 1 FROM provenance_records pr
                       WHERE pr.line_id = bl.id AND pr.scope = 'LINE')) AS lines_with_provenance,

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
    WHERE ${statusFilter}
    ORDER BY br.submitted_at ASC NULLS LAST, br.created_at ASC
  `);

  const queue = (rows as unknown as Array<Record<string, unknown>>).map((r) => {
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

  return successResponse({ queue });
});

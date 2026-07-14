/**
 * GET /api/admin/buyback/queue
 *
 * The review queue (BRD M06). Columns match the design handoff:
 * Request · Dealer · Provenance · Dealer quote · SLA aging · Status.
 *
 * Closed/terminal deals drop out; DRAFTs never appear (the dealer hasn't
 * submitted them). Backed by the (status, created_at) index from E-185.
 */

import { sql } from "drizzle-orm";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { requireBuybackAdmin } from "@/lib/buyback/auth";

export const runtime = "nodejs";

export const GET = withErrorHandler(async () => {
  await requireBuybackAdmin();

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
        AS days_in_queue

    FROM buyback_requests br
    JOIN buyback_deals bd ON bd.request_id = br.id
    LEFT JOIN accounts a  ON a.id = br.dealer_entity_id
    WHERE bd.status NOT IN ('DRAFT', 'CLOSED', 'SETTLED', 'REJECTED', 'CANCELLED')
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
      created_at: r.created_at,
      submitted_at: r.submitted_at,
    };
  });

  return successResponse({ queue });
});

/**
 * GET /api/admin/buyback/documents/dealers?q=&page=   (documents redesign — V5)
 *
 * The dealer directory for the Documents page: every dealer with at least one
 * buyback request, with how many requests they have, how many FORMAL documents
 * those deals have produced, and when the most recent one landed. Lets an admin
 * who knows only the firm name — not a request number — find their way in.
 *
 * `q` is an ILIKE on `accounts.business_entity_name` (E-192 trigram index);
 * 25 per page, ordered by most-recent-document first (dealers with no documents
 * yet sort last but are still listed). Read-only, requireBuybackAdmin, same
 * `{ success, data }` envelope as the sibling reports route.
 */

import { sql } from "drizzle-orm";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { requireBuybackAdmin } from "@/lib/buyback/auth";

export const runtime = "nodejs";

const PAGE_SIZE = 25;

/** Clamp `?page=` to a non-negative integer. */
function parsePage(raw: string | null): number {
  const n = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return 0;
  return n;
}

interface DealerDirRow {
  entity_id: string;
  name: string | null;
  requests: number;
  docs: number;
  /** ISO-8601 UTC string (`to_char … AT TIME ZONE 'UTC'`), or null when no docs. */
  last_doc_at: string | null;
}

export const GET = withErrorHandler(async (req: Request) => {
  await requireBuybackAdmin();

  const url = new URL(req.url);
  const page = parsePage(url.searchParams.get("page"));
  const rawQ = url.searchParams.get("q");
  const q = rawQ && rawQ.trim() ? rawQ.trim() : null;
  const like = q ? `%${q}%` : null;

  // accounts ⋈ requests ⋈ (LEFT) deals ⋈ LATERAL per-deal doc counts. A request
  // has at most one deal (buyback_deals_request_unique), so the LATERAL never
  // multiplies rows: one row per request, summed per dealer.
  const rows = (await db.execute(sql`
    SELECT
      a.id                       AS entity_id,
      a.business_entity_name     AS name,
      COUNT(DISTINCT br.id)::int AS requests,
      COALESCE(SUM(dc.doc_count), 0)::int AS docs,
      to_char(MAX(dc.last_doc_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_doc_at
    FROM accounts a
    JOIN buyback_requests br ON br.dealer_entity_id = a.id
    LEFT JOIN buyback_deals bd ON bd.request_id = br.id
    LEFT JOIN LATERAL (
      SELECT
        (
            (SELECT count(*) FROM vendor_threads vt        WHERE vt.deal_id = bd.id AND vt.quotation_pdf_s3 IS NOT NULL)
          + (SELECT count(*) FROM purchase_orders po       WHERE po.deal_id = bd.id AND po.pdf_s3 IS NOT NULL)
          + (SELECT count(*) FROM invoices iv              WHERE iv.deal_id = bd.id AND iv.pdf_s3 IS NOT NULL)
          + (SELECT count(*) FROM settlement_transactions st WHERE st.deal_id = bd.id AND st.proof_s3 IS NOT NULL)
          + (SELECT count(*) FROM pickups pk               WHERE pk.deal_id = bd.id AND pk.eway_bill_s3 IS NOT NULL)
          + (SELECT count(*) FROM pickups pk               WHERE pk.deal_id = bd.id AND pk.weighbridge_slip_s3 IS NOT NULL)
        )::int AS doc_count,
        (
          SELECT MAX(ts) FROM (
            SELECT vt.created_at AS ts FROM vendor_threads vt WHERE vt.deal_id = bd.id AND vt.quotation_pdf_s3 IS NOT NULL
            UNION ALL SELECT po.created_at FROM purchase_orders po WHERE po.deal_id = bd.id AND po.pdf_s3 IS NOT NULL
            UNION ALL SELECT iv.created_at FROM invoices iv WHERE iv.deal_id = bd.id AND iv.pdf_s3 IS NOT NULL
            UNION ALL SELECT st.created_at FROM settlement_transactions st WHERE st.deal_id = bd.id AND st.proof_s3 IS NOT NULL
            UNION ALL SELECT pk.created_at FROM pickups pk WHERE pk.deal_id = bd.id AND (pk.eway_bill_s3 IS NOT NULL OR pk.weighbridge_slip_s3 IS NOT NULL)
          ) t
        ) AS last_doc_at
    ) dc ON true
    WHERE (${q}::text IS NULL OR a.business_entity_name ILIKE ${like}::text)
    GROUP BY a.id, a.business_entity_name
    ORDER BY MAX(dc.last_doc_at) DESC NULLS LAST, a.business_entity_name ASC
    LIMIT ${PAGE_SIZE + 1} OFFSET ${page * PAGE_SIZE}
  `)) as unknown as DealerDirRow[];

  const has_more = rows.length > PAGE_SIZE;
  const page_rows = has_more ? rows.slice(0, PAGE_SIZE) : rows;

  const items = page_rows.map((r) => ({
    entity_id: String(r.entity_id),
    name: r.name ?? null,
    requests: Number(r.requests),
    docs: Number(r.docs),
    last_doc_at: r.last_doc_at == null ? null : String(r.last_doc_at),
  }));

  return successResponse({ items, page, has_more });
});

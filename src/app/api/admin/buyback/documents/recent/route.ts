/**
 * GET /api/admin/buyback/documents/recent?limit=8   (documents redesign — V5)
 *
 * The most recently produced FORMAL documents across the whole buyback network,
 * newest first. Feeds the Documents page's "recent docs on focus" dropdown so an
 * admin who has just landed — no request number in hand — can jump straight to a
 * deal's document set.
 *
 * Formal documents only: the six file-bearing sources (quotation PDF, both PO
 * legs, both invoice legs, both settlement-proof legs, the two BWM pickup slips).
 * `buyback_photos` is deliberately excluded everywhere in this surface — line
 * photos belong on the request detail, not the document centre.
 *
 * Read-only, requireBuybackAdmin, same `{ success, data }` envelope as the
 * sibling reports route.
 */

import { sql } from "drizzle-orm";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { requireBuybackAdmin } from "@/lib/buyback/auth";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

/** Clamp `?limit=` to a safe integer. Mirrors the reports route's helper. */
function parseLimit(raw: string | null): number {
  const n = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

interface RecentDocRow {
  doc_type: string;
  request_id: string;
  request_no: string;
  dealer_name: string | null;
  /** Already an ISO-8601 UTC string (`to_char … AT TIME ZONE 'UTC'`). */
  ts: string;
}

export const GET = withErrorHandler(async (req: Request) => {
  await requireBuybackAdmin();

  const url = new URL(req.url);
  const limit = parseLimit(url.searchParams.get("limit"));

  // One UNION ALL across the six file-bearing sources, each emitting
  // (doc_type, deal_id, ts). The PO/invoice/proof legs split into a *_dealer /
  // *_vendor doc_type; pickups contribute two arms (e-way bill, weighbridge).
  const rows = (await db.execute(sql`
    WITH docs AS (
      SELECT 'quotation'::text AS doc_type, vt.deal_id AS deal_id, vt.created_at AS ts
      FROM vendor_threads vt
      WHERE vt.quotation_pdf_s3 IS NOT NULL
      UNION ALL
      SELECT CASE WHEN po.leg = 'DEALER' THEN 'po_dealer' ELSE 'po_vendor' END,
             po.deal_id, po.created_at
      FROM purchase_orders po
      WHERE po.pdf_s3 IS NOT NULL
      UNION ALL
      SELECT CASE WHEN i.leg = 'DEALER' THEN 'invoice_dealer' ELSE 'invoice_vendor' END,
             i.deal_id, i.created_at
      FROM invoices i
      WHERE i.pdf_s3 IS NOT NULL
      UNION ALL
      SELECT CASE WHEN st.leg = 'DEALER' THEN 'proof_dealer' ELSE 'proof_vendor' END,
             st.deal_id, st.created_at
      FROM settlement_transactions st
      WHERE st.proof_s3 IS NOT NULL
      UNION ALL
      SELECT 'eway_bill', pk.deal_id, pk.created_at
      FROM pickups pk
      WHERE pk.eway_bill_s3 IS NOT NULL
      UNION ALL
      SELECT 'weighbridge_slip', pk.deal_id, pk.created_at
      FROM pickups pk
      WHERE pk.weighbridge_slip_s3 IS NOT NULL
    )
    SELECT d.doc_type,
           br.id AS request_id,
           br.request_no,
           a.business_entity_name AS dealer_name,
           to_char(d.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ts
    FROM docs d
    JOIN buyback_deals bd    ON bd.id = d.deal_id
    JOIN buyback_requests br ON br.id = bd.request_id
    LEFT JOIN accounts a     ON a.id = br.dealer_entity_id
    ORDER BY d.ts DESC
    LIMIT ${limit}
  `)) as unknown as RecentDocRow[];

  const items = rows.map((r) => ({
    doc_type: r.doc_type,
    request_id: String(r.request_id),
    request_no: String(r.request_no),
    dealer_name: r.dealer_name ?? null,
    ts: String(r.ts),
  }));

  return successResponse({ items });
});

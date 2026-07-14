/**
 * GET /api/admin/buyback/statements/:id/rows  — one import's rows (M13 / U9)
 *
 * The reconciliation worklist. Every parsed row, with its suggestion resolved
 * into something a human can check at a glance: the request number and the name
 * of the party who should be on the other side of that leg.
 *
 * Resolving the counterparty here rather than in the UI is not cosmetic. The
 * whole point of a suggestion is that a person confirms it, and a person cannot
 * confirm "deal 4f3c-… , leg VENDOR". They can confirm "BB-1024 — AmpFusion
 * Recyclers paid us ₹61,000", because they know whether that happened.
 */

import { sql } from "drizzle-orm";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { requireBuybackAdmin } from "@/lib/buyback/auth";
import { NotFoundError } from "@/lib/buyback/errors";

export const runtime = "nodejs";

interface StatementRowView {
  id: string;
  txn_date: string;
  amount: string;
  txn_ref: string | null;
  description: string | null;
  status: "UNMATCHED" | "SUGGESTED" | "MATCHED" | "IGNORED";
  suggested_deal_id: string | null;
  suggested_leg: "DEALER" | "VENDOR" | null;
  suggested_request_no: string | null;
  suggested_counterparty: string | null;
  matched_leg_sub_id: string | null;
  matched_at: Date | null;
  matched_by: string | null;
}

export const GET = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    await requireBuybackAdmin();
    const { id: importId } = await ctx.params;

    const [meta] = (await db.execute(sql`
      SELECT id, filename, account_label, created_at
      FROM bank_statement_imports
      WHERE id = ${importId}::uuid
    `)) as unknown as Array<{
      id: string;
      filename: string;
      account_label: string | null;
      created_at: Date;
    }>;

    if (!meta) throw new NotFoundError("Statement import not found.");

    const rows = (await db.execute(sql`
      SELECT
        r.id,
        to_char(r.txn_date, 'YYYY-MM-DD') AS txn_date,
        r.amount, r.txn_ref, r.description, r.status,
        r.suggested_deal_id, r.suggested_leg,
        br.request_no AS suggested_request_no,
        -- Whoever is on the other side of the SUGGESTED leg: the dealer on a
        -- payout, the agreed vendor on a receipt.
        CASE
          WHEN r.suggested_leg = 'DEALER' THEN da.business_entity_name
          WHEN r.suggested_leg = 'VENDOR' THEN va.business_entity_name
        END AS suggested_counterparty,
        st.leg_sub_id AS matched_leg_sub_id,
        r.matched_at,
        u.name AS matched_by
      FROM bank_statement_rows r
      LEFT JOIN buyback_deals bd     ON bd.id = r.suggested_deal_id
      LEFT JOIN buyback_requests br  ON br.id = bd.request_id
      LEFT JOIN accounts da          ON da.id = br.dealer_entity_id
      LEFT JOIN vendor_threads vt    ON vt.deal_id = bd.id AND vt.status = 'AGREED'
      LEFT JOIN scrap_vendors sv     ON sv.id = vt.vendor_id
      LEFT JOIN accounts va          ON va.id = sv.entity_id
      LEFT JOIN settlement_transactions st ON st.id = r.matched_settlement_id
      LEFT JOIN users u              ON u.id = r.matched_by
      WHERE r.import_id = ${importId}::uuid
      ORDER BY r.txn_date, r.created_at
    `)) as unknown as StatementRowView[];

    return successResponse({
      import: meta,
      rows,
      counts: {
        total: rows.length,
        suggested: rows.filter((r) => r.status === "SUGGESTED").length,
        matched: rows.filter((r) => r.status === "MATCHED").length,
        ignored: rows.filter((r) => r.status === "IGNORED").length,
        unmatched: rows.filter((r) => r.status === "UNMATCHED").length,
      },
    });
  },
);

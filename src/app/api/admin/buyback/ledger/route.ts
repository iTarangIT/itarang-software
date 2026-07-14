/**
 * GET /api/admin/buyback/ledger            — the money ledger (M14)
 * GET /api/admin/buyback/ledger?format=csv — the same, exported
 *
 * A flat ledger of every settlement, both directions, with IN / OUT / net totals.
 *
 * THE AC IS THE INTERESTING PART:
 *
 *   "ledger net for CLOSED deals == dashboard Total Margin Earned
 *    (reconciliation invariant)"
 *
 * Those two numbers come from completely independent places. The ledger net is
 * what MOVED — money in from vendors, money out to dealers. The margin is what
 * was AGREED — Σ qty × margin_value, from deal_line_locks, which is frozen and
 * fill-once. If they ever disagree, one of them is lying, and a report has been
 * repeating it.
 *
 * So this endpoint does not just report the ledger — it computes BOTH numbers and
 * returns the difference. `reconciled: false` is a bug in the data, and it is
 * surfaced rather than smoothed over. (The close route refuses to close a deal
 * that does not reconcile, so in practice this should never trip; it is here
 * because a reconciliation invariant nobody checks is not an invariant.)
 */

import { sql } from "drizzle-orm";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { requireBuybackAdmin } from "@/lib/buyback/auth";

export const runtime = "nodejs";

interface LedgerRow {
  txn: string;
  group_txn_id: string;
  request_no: string;
  deal_status: string;
  counterparty: string;
  direction: "IN" | "OUT";
  method: string;
  txn_ref: string | null;
  proof_s3: string | null;
  txn_date: string;
  recorded_by: string | null;
  amount: string;
}

export const GET = withErrorHandler(async (req: Request) => {
  await requireBuybackAdmin();

  const url = new URL(req.url);
  const direction = url.searchParams.get("direction"); // IN | OUT
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const method = url.searchParams.get("method");
  const format = url.searchParams.get("format");

  const rows = (await db.execute(sql`
    SELECT
      st.leg_sub_id   AS txn,
      st.group_txn_id,
      br.request_no,
      bd.status       AS deal_status,
      -- The counterparty is whoever was on the other side of THAT leg: the dealer
      -- on the payout, the agreed vendor on the receipt.
      CASE WHEN st.leg = 'DEALER' THEN da.business_entity_name ELSE va.business_entity_name END
                      AS counterparty,
      st.direction, st.method, st.txn_ref, st.proof_s3,
      to_char(st.txn_date, 'YYYY-MM-DD') AS txn_date,
      u.name          AS recorded_by,
      st.amount
    FROM settlement_transactions st
    JOIN buyback_deals bd     ON bd.id = st.deal_id
    JOIN buyback_requests br  ON br.id = bd.request_id
    JOIN accounts da          ON da.id = br.dealer_entity_id
    LEFT JOIN users u         ON u.id = st.recorded_by
    LEFT JOIN vendor_threads vt ON vt.deal_id = bd.id AND vt.status = 'AGREED'
    LEFT JOIN scrap_vendors sv  ON sv.id = vt.vendor_id
    LEFT JOIN accounts va       ON va.id = sv.entity_id
    WHERE st.closed_at IS NOT NULL
      AND (${direction}::text IS NULL OR st.direction::text = ${direction})
      AND (${method}::text    IS NULL OR st.method::text    = ${method})
      AND (${from}::date      IS NULL OR st.txn_date >= ${from}::date)
      AND (${to}::date        IS NULL OR st.txn_date <= ${to}::date)
    ORDER BY st.txn_date DESC, st.created_at DESC
  `)) as unknown as LedgerRow[];

  // --- The reconciliation invariant, computed from two independent sources ----
  const recon = (await db.execute(sql`
    WITH closed AS (
      SELECT id FROM buyback_deals WHERE status = 'CLOSED'
    ),
    ledger AS (
      SELECT COALESCE(SUM(CASE WHEN st.direction = 'IN' THEN st.amount ELSE -st.amount END), 0) AS net
      FROM settlement_transactions st
      JOIN closed c ON c.id = st.deal_id
      WHERE st.closed_at IS NOT NULL
    ),
    locked AS (
      -- What was AGREED, read from the locks only — never from live catalog
      -- prices (M22 AC).
      --
      -- (vendor_price − dealer_price), NOT margin_value. margin_value is the
      -- margin we PLANNED — the uplift we added when setting the ask. A vendor
      -- can agree ABOVE the ask, so the realised margin can exceed the planned
      -- one; reconciling against the plan would make this banner scream "does not
      -- reconcile" on every deal where we successfully haggled.
      SELECT
        COALESCE(SUM(bl.quantity * (dll.vendor_price - dll.dealer_price)), 0) AS margin,
        COALESCE(SUM(bl.quantity * dll.margin_value), 0)                      AS planned
      FROM deal_line_locks dll
      JOIN buyback_deals bd ON bd.id = dll.deal_id AND bd.offer_version = dll.offer_version
      JOIN closed c         ON c.id = dll.deal_id
      JOIN buyback_lines bl ON bl.id = dll.line_id
      WHERE dll.vendor_price IS NOT NULL
    )
    SELECT ledger.net, locked.margin, locked.planned FROM ledger, locked
  `)) as unknown as Array<{ net: string; margin: string; planned: string }>;

  const net = Number(recon[0]?.net ?? 0);
  const margin = Number(recon[0]?.margin ?? 0);
  const planned = Number(recon[0]?.planned ?? 0);
  const reconciled = Math.round(net * 100) === Math.round(margin * 100);

  if (format === "csv") {
    const header = [
      "TXN",
      "Group",
      "Request",
      "Counterparty",
      "Direction",
      "Method",
      "Reference",
      "Date",
      "Recorded by",
      "Amount",
    ];

    const esc = (v: unknown) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const csv = [
      header.join(","),
      ...rows.map((r) =>
        [
          r.txn,
          r.group_txn_id,
          r.request_no,
          r.counterparty,
          r.direction,
          r.method,
          r.txn_ref ?? "",
          r.txn_date,
          r.recorded_by ?? "",
          // Signed, so the column sums to the net in a spreadsheet without the
          // reader having to reconstruct the sign from the Direction column.
          (r.direction === "IN" ? 1 : -1) * Number(r.amount),
        ]
          .map(esc)
          .join(","),
      ),
    ].join("\n");

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="buyback-ledger.csv"`,
      },
    });
  }

  const totalIn = rows
    .filter((r) => r.direction === "IN")
    .reduce((s, r) => s + Number(r.amount), 0);
  const totalOut = rows
    .filter((r) => r.direction === "OUT")
    .reduce((s, r) => s + Number(r.amount), 0);

  return successResponse({
    rows,
    totals: {
      in: totalIn,
      out: totalOut,
      net: totalIn - totalOut,
    },
    // M14's AC, as data. If `reconciled` is ever false, a report is lying and
    // somebody needs to know — so it is returned, not swallowed.
    reconciliation: {
      scope: "CLOSED deals",
      ledger_net: net,
      // What the locks say we earned: Σ qty × (vendor_price − dealer_price).
      expected_margin: margin,
      // What we set out to earn. The gap is what the vendor negotiation was
      // worth — the only place that number is visible.
      planned_margin: planned,
      uplift: margin - planned,
      difference: net - margin,
      reconciled,
    },
  });
});

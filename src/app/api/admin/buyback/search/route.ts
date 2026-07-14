/**
 * GET /api/admin/buyback/search?q=...   — the ADMIN's search (M23)
 *
 *   AC: "global search (request ID, dealer, vendor, RC, TXN) scoped by role."
 *
 * Deliberately a SEPARATE FILE from the dealer's search, rather than one endpoint
 * that branches on the caller's role. The vendor and settlement queries below are
 * not "gated" for a dealer — they are in a file a dealer's request never reaches,
 * behind `requireBuybackAdmin()`.
 *
 * That separation is not fastidiousness. A permission boundary implemented as an
 * `if (isAdmin)` inside a shared handler survives exactly as long as nobody
 * refactors it, and search is the highest-consequence endpoint to get wrong: it
 * exists to surface records the caller could not otherwise name.
 */

import { sql } from "drizzle-orm";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { requireBuybackAdmin } from "@/lib/buyback/auth";

export const runtime = "nodejs";

export interface SearchHit {
  kind: "request" | "vendor" | "transaction";
  id: string;
  label: string;
  sublabel: string | null;
  href: string;
}

export const GET = withErrorHandler(async (req: Request) => {
  await requireBuybackAdmin();

  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2) {
    return successResponse({ query: q, hits: [] });
  }

  const like = `%${q}%`;
  const hits: SearchHit[] = [];

  // Requests — by number, by dealer, and by the provenance on their lines (the RC
  // or vehicle number is often the only thing anyone remembers about a battery).
  const requests = (await db.execute(sql`
    SELECT DISTINCT br.id, br.request_no, bd.status, acc.business_entity_name AS dealer
    FROM buyback_requests br
    JOIN accounts acc               ON acc.id = br.dealer_entity_id
    LEFT JOIN buyback_deals bd      ON bd.request_id = br.id
    LEFT JOIN buyback_batches bb    ON bb.request_id = br.id
    LEFT JOIN buyback_lines bl      ON bl.batch_id = bb.id
    LEFT JOIN provenance_records pr ON pr.line_id = bl.id
    WHERE br.request_no ILIKE ${like}
       OR acc.business_entity_name ILIKE ${like}
       OR pr.vehicle_no ILIKE ${like}
       OR pr.rc_number ILIKE ${like}
       OR pr.prev_owner_name ILIKE ${like}
    ORDER BY br.request_no DESC
    LIMIT 20
  `)) as unknown as Array<{
    id: string;
    request_no: string;
    status: string | null;
    dealer: string;
  }>;

  for (const r of requests) {
    hits.push({
      kind: "request",
      id: r.id,
      label: r.request_no,
      sublabel: [r.dealer, r.status].filter(Boolean).join(" · "),
      href: `/admin/buyback/${r.id}`,
    });
  }

  const vendors = (await db.execute(sql`
    SELECT sv.id, acc.business_entity_name AS name, acc.city, ber.status AS role_status
    FROM scrap_vendors sv
    JOIN accounts acc ON acc.id = sv.entity_id
    LEFT JOIN business_entity_roles ber
      ON ber.entity_id = sv.entity_id AND ber.role = 'SCRAP_VENDOR'
    WHERE acc.business_entity_name ILIKE ${like} OR acc.gstin ILIKE ${like}
    ORDER BY acc.business_entity_name
    LIMIT 10
  `)) as unknown as Array<{
    id: string;
    name: string;
    city: string | null;
    role_status: string | null;
  }>;

  for (const v of vendors) {
    hits.push({
      kind: "vendor",
      id: v.id,
      label: v.name,
      // Whether they can actually be routed to is the thing an admin is usually
      // trying to find out, so it is the subtitle rather than buried on a page.
      sublabel: [v.city, v.role_status === "ACTIVE" ? "active" : "not onboarded"]
        .filter(Boolean)
        .join(" · "),
      href: "/admin/buyback/vendors",
    });
  }

  const txns = (await db.execute(sql`
    SELECT st.id, st.leg_sub_id, st.direction, br.request_no, br.id AS request_id
    FROM settlement_transactions st
    JOIN buyback_deals bd    ON bd.id = st.deal_id
    JOIN buyback_requests br ON br.id = bd.request_id
    WHERE st.leg_sub_id ILIKE ${like}
       OR st.group_txn_id ILIKE ${like}
       OR st.txn_ref ILIKE ${like}
    ORDER BY st.created_at DESC
    LIMIT 10
  `)) as unknown as Array<{
    id: string;
    leg_sub_id: string;
    direction: string;
    request_no: string;
    request_id: string;
  }>;

  for (const t of txns) {
    hits.push({
      kind: "transaction",
      id: t.id,
      label: t.leg_sub_id,
      sublabel: `${t.direction} · ${t.request_no}`,
      href: `/admin/buyback/${t.request_id}`,
    });
  }

  return successResponse({ query: q, hits });
});

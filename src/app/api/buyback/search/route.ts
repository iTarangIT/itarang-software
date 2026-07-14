/**
 * GET /api/buyback/search?q=...   — the DEALER's search (M23)
 *
 * A search box is the easiest place in any system to leak data, because it is the
 * one endpoint whose entire job is to return things the caller did not already
 * know the ID of. Get the WHERE clause wrong and a dealer types "Vardhan" and
 * finds their competitor's request.
 *
 * THIS ROUTE IS DEALER-ONLY, AND THAT IS A STRUCTURAL FACT, NOT A RUNTIME CHECK.
 *
 * The first version of this file served both roles, branching on `isAdmin` — and
 * the release-blocking permission test in
 * src/lib/buyback/__tests__/permissions.contract.test.ts rightly failed it: a
 * dealer-facing route was reaching for `scrap_vendors` and
 * `settlement_transactions`. Both queries were correctly gated. But a security
 * boundary that lives inside an `if` is one careless refactor from not existing,
 * and the test is there precisely to stop that reasoning from taking hold.
 *
 * So the admin search is a DIFFERENT FILE, under /api/admin/. The vendor and
 * transaction queries are not merely unreachable for a dealer here — they are not
 * in the file.
 *
 * A dealer can search their own requests by request number, and by the vehicle /
 * RC number on their own provenance records. That is all there is.
 */

import { sql } from "drizzle-orm";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { requireDealer } from "@/lib/buyback/auth";

export const runtime = "nodejs";

export const GET = withErrorHandler(async (req: Request) => {
  // Not `requireAuth` — `requireDealer`. An admin hitting this endpoint gets a
  // 403, not a wider result set.
  const actor = await requireDealer();

  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2) {
    return successResponse({ query: q, hits: [] });
  }

  const like = `%${q}%`;

  const rows = (await db.execute(sql`
    SELECT DISTINCT br.id, br.request_no, bd.status
    FROM buyback_requests br
    LEFT JOIN buyback_deals bd      ON bd.request_id = br.id
    LEFT JOIN buyback_batches bb    ON bb.request_id = br.id
    LEFT JOIN buyback_lines bl      ON bl.batch_id = bb.id
    LEFT JOIN provenance_records pr ON pr.line_id = bl.id
    WHERE br.dealer_entity_id = ${actor.entityId}
      AND (
        br.request_no ILIKE ${like}
        OR pr.vehicle_no ILIKE ${like}
        OR pr.rc_number  ILIKE ${like}
      )
    ORDER BY br.request_no DESC
    LIMIT 20
  `)) as unknown as Array<{ id: string; request_no: string; status: string | null }>;

  return successResponse({
    query: q,
    hits: rows.map((r) => ({
      kind: "request" as const,
      id: r.id,
      label: r.request_no,
      sublabel: r.status,
      href: `/dealer-portal/buyback/${r.id}`,
    })),
  });
});

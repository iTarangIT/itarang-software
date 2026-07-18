/**
 * GET /api/vendor/payment-links   (E-193 surface for the vendor portal)
 *
 * The vendor's own Razorpay payment links, so "Pay now" can live in the portal
 * instead of only in the emailed link. Scoped to the caller's own AGREED threads
 * and masked: a link carries only what the vendor owes and where to pay it — no
 * dealer figure, margin, or floor.
 *
 * DELIBERATELY ISOLATED from /api/vendor/threads. The gateway table (E-193) is
 * not on every environment; referencing it from the core threads query would
 * 500 the whole vendor portal wherever that migration has not landed. Here a
 * missing table (or any query failure) is caught and returned as "no links", so
 * the Payments page simply shows nothing to pay yet rather than breaking.
 */

import { sql } from "drizzle-orm";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { requireVendor } from "@/lib/buyback/auth";

export const runtime = "nodejs";

interface VendorPaymentLink {
  thread_id: string;
  status: string;
  short_url: string | null;
  amount: string | null;
  paid: boolean;
}

export const GET = withErrorHandler(async () => {
  const actor = await requireVendor();
  const entityId = actor.entityId!;

  let links: VendorPaymentLink[] = [];
  try {
    // The latest live/paid link per won thread. CANCELLED/FAILED/EXPIRED links
    // are excluded by the status filter, so a superseded link never shows a
    // stale "Pay now". short_url is null until a link reaches PENDING.
    const rows = await db.execute(sql`
      SELECT DISTINCT ON (vt.id)
        vt.id      AS thread_id,
        gt.status  AS status,
        gt.short_url,
        gt.amount
      FROM vendor_threads vt
      JOIN scrap_vendors sv ON sv.id = vt.vendor_id
      JOIN buyback_gateway_transactions gt ON gt.deal_id = vt.deal_id
      WHERE sv.entity_id = ${entityId}
        AND vt.status = 'AGREED'
        AND gt.leg = 'VENDOR'
        AND gt.kind = 'PAYMENT_LINK'
        AND gt.status IN ('PENDING', 'QUEUED', 'PROCESSING', 'PAID')
      ORDER BY vt.id, gt.created_at DESC
    `);

    links = (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
      thread_id: String(r.thread_id),
      status: String(r.status),
      short_url: (r.short_url as string) ?? null,
      amount: (r.amount as string) ?? null,
      paid: String(r.status) === "PAID",
    }));
  } catch {
    // Gateway table absent on this environment, or the query failed — the vendor
    // simply has no in-app link to pay yet. Never surfaced as an error.
    links = [];
  }

  return successResponse({ links });
});

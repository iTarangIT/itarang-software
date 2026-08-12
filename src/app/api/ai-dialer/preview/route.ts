/**
 * POST /api/ai-dialer/preview
 *
 * Server-side replacement for the modal's old client-side
 * "fetch 500 leads, filter in browser" path. Accepts a region selection
 * (loose states, specific state+city pairs, pincodes, saved group IDs)
 * plus an optional segment category, and returns the bucketed counts
 * (hot/warm/cold/all) plus the queue of dealer_leads.id values to dial.
 *
 * The returned queueIds is what the modal hands to /api/ai-dialer/start,
 * so the modal's "Start dialing" button doesn't need to know anything
 * about the underlying lead set — preview is the source of truth.
 *
 * The resolution itself lives in src/lib/ai-dialer/audience.ts (extracted in
 * E-224) so the NeoDove push path targets the same lead set through the same
 * canonical-city logic. This route is a thin wrapper; its response shape is
 * unchanged.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveAudience, type AudienceSelection } from "@/lib/ai-dialer/audience";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as AudienceSelection;
    const result = await resolveAudience(body ?? {});

    return NextResponse.json({
      success: true,
      counts: result.counts,
      excluded: result.excluded,
      totalWithPhone: result.totalWithPhone,
      queueIds: result.queueIds,
      queue: result.queue.map((r) => ({
        id: r.id,
        phone: r.phone,
        dealer_name: r.dealer_name,
        shop_name: r.shop_name,
        final_intent_score: r.final_intent_score,
        current_status: r.current_status,
      })),
    });
  } catch (err) {
    console.error("[AI DIALER] preview error:", err);
    return NextResponse.json(
      { success: false, error: (err as Error)?.message ?? "Preview failed" },
      { status: 500 },
    );
  }
}

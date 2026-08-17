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
import {
  resolveDialerAudience,
  type AudienceSelection,
} from "@/lib/ai-dialer/audience";
import { requireRole } from "@/lib/auth-utils";
import { LEADS_OVERSIGHT_ROLES } from "@/lib/leads/access";

export async function POST(req: NextRequest) {
  try {
    // ⚠ SECURITY: this route had NO auth check of any kind, and middleware does
    // not gate /api/*. It returns every matching dealer's name, shop and PHONE
    // for an arbitrary region, with no limit — i.e. the whole prospect list to
    // anyone who can reach the host. Same hole, same fix, same roles as
    // /api/ai-dialer/start.
    await requireRole([...LEADS_OVERSIGHT_ROLES]);

    const body = (await req.json().catch(() => ({}))) as AudienceSelection;

    // Take only the audience fields off the wire. The exclusion flags are NOT
    // client input: they are what makes this the AI-dialer view of the
    // audience, and a crafted POST setting excludeAiConnected:false would
    // otherwise resurrect leads the hard block exists to remove. Enrolment is
    // scrubbed again in createCampaign regardless, but the displayed counts
    // should not be forgeable either.
    const selection: AudienceSelection = {
      states: body?.states,
      cities: body?.cities,
      pincodes: body?.pincodes,
      groupIds: body?.groupIds,
      category: body?.category,
    };

    const result = await resolveDialerAudience(selection);

    return NextResponse.json({
      success: true,
      counts: result.counts,
      excluded: result.excluded,
      totalWithPhone: result.totalWithPhone,
      aiConnectedCount: result.aiConnectedCount,
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

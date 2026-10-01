// POST/GET /api/ai-dialer/campaigns/[id]/leads/[leadId]/intent-feedback
//
// ⚠ COMPATIBILITY SHIM. The real implementation is now
//   /api/dealer-leads/[leadId]/intent-feedback
// and this route forwards to it.
//
// WHY IT STILL EXISTS
//   The campaign transcript drawer (CampaignLeadTranscriptDrawer.tsx) has
//   posted here since E-159, and it is reachable from four campaign screens.
//   Keeping the path alive means the drawer keeps working while the review UI
//   moves to the lead-detail screens, and any bookmarked/in-flight client keeps
//   working too.
//
// WHY IT IS A SHIM RATHER THAN A SECOND IMPLEMENTATION
//   Correcting a band is now an OVERRIDE — it writes through to
//   dealer_leads.intent_band and final_intent_score. Two copies of a mutation
//   that moves leads through the pipeline is exactly the kind of duplication
//   that drifts silently: one gets a guard the other doesn't, and nobody
//   notices until a corrected lead behaves differently depending on which
//   screen corrected it.
//
// WHAT THIS FIXES ON THE WAY
//   The original handlers were open. POST checked only that SOMEONE was signed
//   in — no role gate — and GET had no auth check at all (it sat outside the
//   auth block entirely). Middleware early-exits on every /api path
//   (src/middleware.ts), so neither was covered there either: any signed-in
//   dealer, vendor or service engineer could read reviewer notes and write
//   corrections. The delegate enforces INTENT_REVIEW_ROLES on both verbs, so
//   forwarding closes the hole rather than preserving it.

import { NextRequest } from "next/server";
import {
  GET as leadScopedGET,
  POST as leadScopedPOST,
} from "@/app/api/dealer-leads/[id]/intent-feedback/route";
import { errorResponse, withErrorHandler } from "@/lib/api-utils";
import { leadOwnedBy, requireCampaignReader } from "@/lib/ai-dialer/campaignAccess";

/**
 * ID 45: a rep (asm / inside_sales_rep / partner) may only read or correct the
 * intent of a lead they OWN. Anything else is a 404 — the same answer as "no
 * such lead", so the pool cannot be probed id by id. null = allowed.
 */
async function denyUnlessOwned(ctx: {
  params: Promise<{ id: string; leadId: string }>;
}): Promise<Response | null> {
  const { user, ownOnly } = await requireCampaignReader();
  if (!ownOnly) return null;
  const { leadId } = await ctx.params;
  return leadId && (await leadOwnedBy(leadId, user.id))
    ? null
    : errorResponse("Lead not found", 404);
}

/**
 * Re-key the params. The delegate is lead-scoped and names the lead `id`; this
 * route names it `leadId` and uses `id` for the campaign, which is dropped —
 * the correction is a fact about the CALL and the LEAD, not about the campaign
 * that happened to dial it. The same call corrected from two campaigns must
 * produce the same training row.
 */
function asLeadScopedCtx(ctx: {
  params: Promise<{ id: string; leadId: string }>;
}): { params: Promise<{ id: string }> } {
  return { params: ctx.params.then(({ leadId }) => ({ id: leadId })) };
}

export const POST = withErrorHandler(
  async (
    req: NextRequest,
    ctx: { params: Promise<{ id: string; leadId: string }> },
  ) => (await denyUnlessOwned(ctx)) ?? leadScopedPOST(req, asLeadScopedCtx(ctx)),
);

export const GET = withErrorHandler(
  async (
    req: NextRequest,
    ctx: { params: Promise<{ id: string; leadId: string }> },
  ) => (await denyUnlessOwned(ctx)) ?? leadScopedGET(req, asLeadScopedCtx(ctx)),
);

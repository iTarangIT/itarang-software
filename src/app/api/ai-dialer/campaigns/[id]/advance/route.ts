// POST /api/ai-dialer/campaigns/[id]/advance
//
// Manually place the next pending call in a campaign. Used when a
// campaign has stalled mid-flight — e.g. the watchdog swept a stuck
// 'calling' row to 'failed' but no webhook fired to re-enter
// advanceCampaign, so the remaining pending rows sit untouched. The
// detail page shows a "Call next" button that hits this.
//
// Idempotent in the safe sense: advanceCampaign uses FOR UPDATE SKIP
// LOCKED, so two concurrent clicks claim two different rows (or one
// claims, the other returns no-pending). It never double-places a call
// on the same lead.

import { advanceCampaign } from "@/lib/queue/advanceCampaign";
import {
  errorResponse,
  successResponse,
  withErrorHandler,
} from "@/lib/api-utils";
import { guardApi } from "@/lib/auth/apiGuard";
import { CAMPAIGN_ACTION_ROLES } from "@/lib/leads/access";

export const POST = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    // ID 145: Admin and CEO only; the detail view hides Call next for the rest
    // (canRunCampaignActions). JSON 401/403, never a redirect.
    const gate = await guardApi([...CAMPAIGN_ACTION_ROLES]);
    if (!gate.ok) return gate.response;

    const { id: campaignId } = await ctx.params;
    if (!campaignId) return errorResponse("Campaign id required", 400);

    const result = await advanceCampaign(campaignId);

    if (result.kind === "campaign-not-running") {
      return errorResponse(
        "Campaign is not running — start a new campaign for these leads",
        409,
      );
    }
    if (result.kind === "error") {
      return errorResponse(result.error, 500);
    }

    return successResponse({ campaignId, ...result });
  },
);

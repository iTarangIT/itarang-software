// POST /api/bot/campaigns/[id]/start   ({ provider? })
//
// Bot command: launch a DRAFT campaign created via /api/bot/campaigns/upload.
// Mirrors /api/ai-dialer/lists/[id]/start, reusing the startDraftCampaign
// primitive (flip to running, tag leads with the provider, seed the Redis
// session, place the first call). Defaults to ElevenLabs for bot campaigns.
//
// Idempotent: only a draft can be started. A second call (already running /
// completed / stopped) returns the current state without re-dialing.

import { db } from "@/lib/db";
import { dialerCampaigns } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { successResponse, errorResponse } from "@/lib/api-utils";
import { withBotAuth } from "@/lib/bot/auth";
import { type DialerProvider } from "@/lib/queue/dialerSession";
import { startDraftCampaign } from "@/lib/queue/startCampaign";

const ALLOWED_PROVIDERS: DialerProvider[] = ["bolna", "elevenlabs"];

export const POST = withBotAuth(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: campaignId } = await ctx.params;
    if (!campaignId) return errorResponse("Campaign id required", 400);

    const body = await req.json().catch(() => ({}));
    const provider: DialerProvider = ALLOWED_PROVIDERS.includes(body?.provider)
      ? body.provider
      : "elevenlabs";

    const existing = await db
      .select({ id: dialerCampaigns.id, status: dialerCampaigns.status })
      .from(dialerCampaigns)
      .where(eq(dialerCampaigns.id, campaignId))
      .limit(1);

    if (existing.length === 0) return errorResponse("Campaign not found", 404);

    if (existing[0].status !== "draft") {
      return successResponse({
        campaignId,
        status: existing[0].status,
        alreadyStarted: true,
      });
    }

    const result = await startDraftCampaign(campaignId, provider);

    if (!result.started) {
      return errorResponse("This campaign has no leads to dial", 400);
    }

    return successResponse({
      campaignId,
      status: "running",
      provider,
      queued: result.queued,
      firstCallPlaced: result.firstCallPlaced,
      firstCallError: result.firstCallError,
    });
  },
);

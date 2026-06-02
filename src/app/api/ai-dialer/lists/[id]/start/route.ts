// POST /api/ai-dialer/lists/[id]/start  ({ provider })
//
// Launches a DRAFT list campaign created by /api/ai-dialer/lists/create.
// Mirrors /api/ai-dialer/start: flip the campaign to "running", tag its leads
// with the chosen provider, seed the Redis dialer session, and place the first
// call via advanceCampaign (which requires status="running" — set first).
//
// Idempotent: only a draft can be started. A second click (already running /
// completed / stopped) returns the current state without re-dialing.

import { db } from "@/lib/db";
import { dialerCampaigns } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { successResponse, errorResponse, withErrorHandler } from "@/lib/api-utils";
import { requireAuth } from "@/lib/auth-utils";
import { type DialerProvider } from "@/lib/queue/dialerSession";
import { startDraftCampaign } from "@/lib/queue/startCampaign";

const ALLOWED_PROVIDERS: DialerProvider[] = ["bolna", "elevenlabs"];

export const POST = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: campaignId } = await ctx.params;
    if (!campaignId) return errorResponse("Campaign id required", 400);

    // Auth is best-effort (dev/system contexts) — same posture as /start.
    try {
      await requireAuth();
    } catch {
      /* tolerate no session */
    }

    const body = await req.json().catch(() => ({}));
    const provider: DialerProvider = ALLOWED_PROVIDERS.includes(body?.provider)
      ? body.provider
      : "bolna";

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

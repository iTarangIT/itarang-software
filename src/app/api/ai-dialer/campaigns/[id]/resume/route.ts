// POST /api/ai-dialer/campaigns/[id]/resume
//
// Resume a *stopped* campaign and continue dialing the leads that were never
// reached. Unlike recall-failed (which spins up a brand-new campaign from the
// FAILED leads), resume keeps THIS campaign — it just flips it back to running
// and lets advanceCampaign pick up where it stopped.
//
// Why this is safe: advanceCampaign claims the next row WHERE status='pending'
// (FOR UPDATE SKIP LOCKED), so already-completed/failed leads are never
// re-dialed. We reuse startDraftCampaign with resetStartedAt:false so the
// campaign's original started_at is preserved (same run, not a new one).
//
// Previously-failed leads remain the job of the "Retry failed leads" button.

import { db } from "@/lib/db";
import { dialerCampaigns, dialerCampaignLeads } from "@/lib/db/schema";
import { startDraftCampaign } from "@/lib/queue/startCampaign";
import type { DialerProvider } from "@/lib/queue/dialerSession";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireAuth } from "@/lib/auth-utils";
import { and, eq, sql } from "drizzle-orm";

export const POST = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: campaignId } = await ctx.params;
    if (!campaignId) return errorResponse("Campaign id required", 400);

    try {
      // Auth is only for parity with stop/start; resume doesn't need the id.
      await requireAuth();
    } catch {
      // Allow unauth in dev / system contexts — same posture as /stop.
    }

    const existing = await db
      .select({
        id: dialerCampaigns.id,
        status: dialerCampaigns.status,
        provider: dialerCampaigns.provider,
      })
      .from(dialerCampaigns)
      .where(eq(dialerCampaigns.id, campaignId))
      .limit(1);

    if (existing.length === 0) {
      return errorResponse("Campaign not found", 404);
    }

    const campaign = existing[0];

    // Already-running campaigns short-circuit so a double-click doesn't seed a
    // second dialer session / place a duplicate first call.
    if (campaign.status === "running") {
      return successResponse({
        campaignId,
        status: campaign.status,
        alreadyRunning: true,
      });
    }

    // Only a stopped or paused campaign can be resumed. Draft/completed/failed
    // are not "paused mid-run" states, so resuming them is meaningless.
    //
    // E-254 added 'paused': a single-run campaign that reached its window end
    // time. It is exactly the state this button exists for. 'scheduled' is
    // deliberately NOT resumable — it already has a resume_after armed and the
    // ticker owns it, so a manual resume would only park it again.
    if (campaign.status !== "stopped" && campaign.status !== "paused") {
      return errorResponse(
        `Cannot resume a ${campaign.status} campaign`,
        400,
      );
    }

    // Nothing left to dial → nothing to resume. The UI hides the button in this
    // case, but guard the route too (direct hits / stale UI).
    const pendingRes = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(dialerCampaignLeads)
      .where(
        and(
          eq(dialerCampaignLeads.campaign_id, campaignId),
          eq(dialerCampaignLeads.status, "pending"),
        ),
      );
    const pending = pendingRes[0]?.n ?? 0;
    if (pending === 0) {
      return errorResponse("No pending leads to resume", 400);
    }

    const result = await startDraftCampaign(
      campaignId,
      campaign.provider as DialerProvider,
      { resetStartedAt: false },
    );

    // E-254 — resuming outside the calling window is not refused, it is
    // re-armed. startDraftCampaign flips the campaign to running and calls
    // advanceCampaign, which sees the shut window and parks it again; a
    // recurring campaign comes back 'scheduled' for its next opening, a single
    // run comes back 'paused'. Either way no call is placed late, and the
    // user's click is never wasted — the UI reports when it will actually run.
    return successResponse({
      campaignId,
      status: result.armed ? (result.armedStatus ?? "paused") : "running",
      queued: result.queued,
      firstCallPlaced: result.firstCallPlaced,
      firstCallError: result.firstCallError,
      armed: result.armed,
      resumeAt: result.resumeAt ? result.resumeAt.toISOString() : null,
    });
  },
);

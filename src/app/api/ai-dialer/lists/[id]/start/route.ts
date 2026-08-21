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
import {
  campaignScheduleSchema,
  scheduleColumns,
} from "@/lib/queue/campaignWindow";

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

    // E-254 — the calling window. Unlike the region flow, a list campaign is
    // CREATED as a draft and STARTED later, so the window is chosen at start
    // time and written onto the existing row below rather than at insert.
    let schedule = null as ReturnType<
      typeof campaignScheduleSchema.parse
    > | null;
    if (body?.schedule != null) {
      const parsed = campaignScheduleSchema.safeParse(body.schedule);
      if (!parsed.success) {
        return errorResponse(
          parsed.error.issues[0]?.message ?? "Invalid calling window",
          400,
        );
      }
      schedule = parsed.data;
    }

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

    // Written BEFORE startDraftCampaign, because that flips the campaign to
    // running and calls advanceCampaign, which reads these very columns to
    // decide whether it may dial. Written after, a campaign started outside its
    // window would place one call before the window took effect.
    //
    // Unconditional, including the unscheduled quartet: re-starting a draft that
    // previously carried a window must clear it, or the row would keep a
    // schedule the operator just switched off.
    await db
      .update(dialerCampaigns)
      .set(scheduleColumns(schedule))
      .where(eq(dialerCampaigns.id, campaignId));

    const result = await startDraftCampaign(campaignId, provider);

    if (!result.started) {
      return errorResponse("This campaign has no leads to dial", 400);
    }

    return successResponse({
      campaignId,
      // E-254 — 'running' is no longer a given: started outside its window the
      // campaign comes back parked, and the UI needs to say so rather than
      // claim it is dialling.
      status: result.armed ? (result.armedStatus ?? "paused") : "running",
      provider,
      queued: result.queued,
      firstCallPlaced: result.firstCallPlaced,
      firstCallError: result.firstCallError,
      armed: result.armed,
      resumeAt: result.resumeAt ? result.resumeAt.toISOString() : null,
    });
  },
);

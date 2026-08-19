// POST /api/ai-dialer/campaigns/[id]/recall-failed
//
// "Retry failed leads": bundle this campaign's retryable failed leads into a
// BRAND-NEW campaign and start dialing it immediately. The source campaign and
// its stats are left completely untouched — each run stays a clean, separate
// record for audit/cost history.
//
// Retryable is decided by deriveFailureReason() — the SAME function the campaign
// table uses to label each row — so the button can never offer to retry
// something the table calls non-retryable. It excludes:
//   - no_phone / ineligible_*  → there is nothing to call, or the lead is now
//                                owned by Inside Sales / ASM
//   - silent_call / no_response → the dealer WAS reached. The AI-connected hard
//                                block would refuse these anyway, so retrying
//                                them is offering an action that silently does
//                                nothing. They need a person.
//
// The new campaign carries recall:true in its region_filter, which makes
// advanceCampaign bypass the once-per-day idempotency guard so the second dial
// goes through even on the same day the lead first failed.

import { db } from "@/lib/db";
import { dialerCampaigns, dialerCampaignLeads } from "@/lib/db/schema";
import { and, asc, eq, sql } from "drizzle-orm";
import { successResponse, errorResponse, withErrorHandler } from "@/lib/api-utils";
import { requireAuth } from "@/lib/auth-utils";
import { type DialerProvider } from "@/lib/queue/dialerSession";
import { createCampaign } from "@/lib/queue/campaignTracker";
import { startDraftCampaign } from "@/lib/queue/startCampaign";
import { isRetryableFailure } from "@/lib/ai-dialer/failureReason";



export const POST = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: campaignId } = await ctx.params;
    if (!campaignId) return errorResponse("Campaign id required", 400);

    // Auth is best-effort (dev/system contexts) — same posture as list start.
    let triggeredBy: string | null = null;
    try {
      const user = await requireAuth();
      triggeredBy = user?.id ?? null;
    } catch {
      /* tolerate no session */
    }

    // Load the source campaign — we read from it but never mutate it.
    const rows = await db
      .select({
        id: dialerCampaigns.id,
        name: dialerCampaigns.name,
        status: dialerCampaigns.status,
        provider: dialerCampaigns.provider,
        category: dialerCampaigns.category,
        region_filter: dialerCampaigns.region_filter,
      })
      .from(dialerCampaigns)
      .where(eq(dialerCampaigns.id, campaignId))
      .limit(1);

    if (rows.length === 0) return errorResponse("Campaign not found", 404);
    const source = rows[0];

    // Retrying while the source is still dialing would race its live session;
    // the UI hides the button in this state, but guard the API too.
    if (source.status === "running") {
      return errorResponse(
        "Wait for the campaign to finish before retrying.",
        400,
      );
    }

    // Failed rows for the source campaign, in original queue order, with the
    // evidence deriveFailureReason needs. Filtered in JS rather than SQL because
    // the retryable rule lives in one shared function — duplicating it as a
    // NOT IN list is how the button and the table would start disagreeing.
    const failed = await db
      .select({
        lead_id: dialerCampaignLeads.lead_id,
        status: dialerCampaignLeads.status,
        call_outcome: dialerCampaignLeads.call_outcome,
        has_transcript: sql<boolean>`(
          select transcript is not null from ai_call_logs
          where call_id = ${dialerCampaignLeads.bolna_call_id}
          limit 1
        )`,
        log_status: sql<string | null>`(
          select status from ai_call_logs
          where call_id = ${dialerCampaignLeads.bolna_call_id}
          limit 1
        )`,
        log_call_status: sql<string | null>`(
          select call_status from ai_call_logs
          where call_id = ${dialerCampaignLeads.bolna_call_id}
          limit 1
        )`,
      })
      .from(dialerCampaignLeads)
      .where(
        and(
          eq(dialerCampaignLeads.campaign_id, campaignId),
          eq(dialerCampaignLeads.status, "failed"),
        ),
      )
      .orderBy(asc(dialerCampaignLeads.queue_position));

    // De-dupe lead ids preserving order (a lead could have more than one
    // failed row across earlier follow-ups within the same campaign).
    const seen = new Set<string>();
    const queueIds: string[] = [];
    let skippedNonRetryable = 0;
    for (const r of failed) {
      if (
        !isRetryableFailure({
          status: r.status,
          callOutcome: r.call_outcome,
          hasTranscript: r.has_transcript,
          providerStatus: r.log_status,
          bandCallStatus: r.log_call_status,
        })
      ) {
        skippedNonRetryable += 1;
        continue;
      }
      if (!seen.has(r.lead_id)) {
        seen.add(r.lead_id);
        queueIds.push(r.lead_id);
      }
    }

    if (queueIds.length === 0) {
      return errorResponse(
        skippedNonRetryable > 0
          ? `None of the ${skippedNonRetryable} failed leads can be retried — the AI already reached them, or they were never eligible. They need manual follow-up.`
          : "No failed leads to retry",
        400,
      );
    }

    // New campaign's region_filter: inherit the source region for display
    // context, then add the recall markers. recall:true is what makes
    // advanceCampaign bypass the once-per-day idempotency guard.
    const srcRegion =
      source.region_filter && typeof source.region_filter === "object"
        ? (source.region_filter as Record<string, unknown>)
        : {};
    const region = {
      ...srcRegion,
      recall: true,
      sourceCampaignId: source.id,
    };

    const provider: DialerProvider =
      source.provider === "elevenlabs" ? "elevenlabs" : "bolna";

    // Name the retry "Retry · <original>". Collapse any existing "Retry · "
    // prefixes first so retrying a retry doesn't compound into
    // "Retry · Retry · Retry · …".
    const baseName = (source.name ?? "").replace(/^(?:Retry · )+/, "").trim();
    const retryName = `Retry · ${baseName || "previous campaign"}`;

    // Create the retry as a draft, then start it (same sequence as List start).
    const { campaignId: newId, queued, blockedAiConnected } = await createCampaign({
      queueIds,
      provider,
      category: source.category,
      region,
      triggeredBy,
      status: "draft",
      name: retryName,
    });

    // Worth understanding rather than treating as an odd edge case: a retry
    // re-queues leads whose PREVIOUS attempt failed, and a failed attempt
    // usually means no transcript, so almost nothing gets scrubbed here. The
    // exception is a `needs_review` row — the call connected and produced a
    // transcript, but the analyzer could not read it. Those are AI-connected by
    // the locked definition and are now permanently out of the AI's reach, even
    // though what failed was our extraction, not the conversation.
    if (!newId && blockedAiConnected.length > 0) {
      return errorResponse(
        "Every failed lead in this campaign has already been reached by the AI (their calls connected but could not be analysed). They need manual follow-up.",
        409,
      );
    }
    if (!newId) return errorResponse("Could not create retry campaign", 500);

    // Flip to running, tag leads, seed the session, place the first call.
    const result = await startDraftCampaign(newId, provider);

    return successResponse({
      campaignId: newId,
      retryCount: queued,
      skippedNonRetryable,
      blockedAiConnected: blockedAiConnected.length,
      status: "running",
      firstCallPlaced: result.firstCallPlaced,
      firstCallError: result.firstCallError,
    });
  },
);

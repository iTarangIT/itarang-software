// POST/GET /api/dealer-leads/[id]/intent-feedback
//
// THE canonical intent-review write path. A reviewer says "this band is wrong",
// and two things happen: a permanent training row is recorded, and the lead is
// actually corrected.
//
// ── WHY LEAD-SCOPED AND NOT CAMPAIGN-SCOPED ──────────────────────────────────
// The original route (E-159) lives at
//   /api/ai-dialer/campaigns/[id]/leads/[leadId]/intent-feedback
// which can only be called from a campaign context. But the review now lives on
// the lead-detail screens — that is where sales_head, sales_insight and ASMs
// actually work — and plenty of reviewable calls have no campaign at all
// (manual one-off dials, and any lead whose campaign row was cleaned up). The
// campaign-scoped route now delegates here, so there is ONE write path and the
// campaign drawer and the lead panel can never diverge.
//
// This mirrors why /api/dealer-leads/[id]/ai-summary exists rather than reusing
// the campaign transcript route — see that file's header.
//
// ── WHY /api/dealer-leads AND NOT /api/leads ─────────────────────────────────
// `/api/leads/*` is the customer/loan `leads` table, a completely different
// entity. Putting dealer-lead work there is the bug documented at length in
// ../route.ts, where every edit 404'd silently.

import { NextRequest } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { aiCallLogs, intentScoreFeedback } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { INTENT_REVIEW_ROLES } from "@/lib/leads/access";
import { QualificationSignalsSchema } from "@/lib/ai/scoring/signals";
import { statusToBand } from "@/lib/ai/scoring";
import {
  applyIntentOverride,
  stampHumanBandOnCall,
  REVIEW_STATUSES,
} from "@/lib/leads/intentOverride";

const FeedbackBody = z.object({
  // The call being corrected. Optional: a reviewer can correct a lead the AI
  // never called (after attaching their own recording), in which case there is
  // no ai_call_logs row to snapshot and nothing to stamp a human_band onto.
  callId: z.string().min(1).nullable().optional(),
  correctedStatus: z.enum(REVIEW_STATUSES),
  correctedScore: z.number().int().min(0).max(100).nullable().optional(),
  // Deep mode: a full QualificationSignals (yes/no facts) shape. Forgiving
  // parse, matching extraction. Old BANT-shaped corrections stay readable in
  // the DB — jsonb is untyped and rows are version-stamped.
  correctedSignals: QualificationSignalsSchema.nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
  // lead_call_recordings.id when the reviewer attached audio as their
  // explanation instead of typing one.
  recordingId: z.string().uuid().nullable().optional(),
  // Escape hatch for a reviewer who wants to log an observation WITHOUT moving
  // the lead. Defaults to overriding, because that is what "correct this" means
  // and because the silent no-op was the original bug.
  applyToLead: z.boolean().optional(),
});

export const POST = withErrorHandler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireRole([...INTENT_REVIEW_ROLES]);
    const { id: leadId } = await ctx.params;

    const body = FeedbackBody.parse(await req.json());

    const correctedBand = statusToBand(body.correctedStatus);
    if (!correctedBand) {
      return errorResponse(`Unknown status: ${body.correctedStatus}`, 400);
    }

    // Snapshot what the AI produced, so the training row is self-contained and
    // no later mutation of ai_call_logs can rewrite history. E-159 captured the
    // score and signals; E-250 adds the BAND, without which "did the human
    // agree" can only be reconstructed by re-deriving the band from the score —
    // which stops being correct the moment BAND_LEAD_SCORE changes.
    let call: {
      intentScore: number | null;
      signals: unknown;
      scoringVersion: string | null;
      band: string | null;
      leadId: string | null;
    } | null = null;

    if (body.callId) {
      const rows = await db
        .select({
          intentScore: aiCallLogs.intent_score,
          signals: aiCallLogs.signals,
          scoringVersion: aiCallLogs.scoring_version,
          band: aiCallLogs.band,
          leadId: aiCallLogs.lead_id,
        })
        .from(aiCallLogs)
        .where(eq(aiCallLogs.call_id, body.callId))
        .orderBy(desc(aiCallLogs.created_at))
        .limit(1);
      call = rows[0] ?? null;
    }

    const agreed = call?.band ? call.band === correctedBand : null;

    // The feedback row goes in FIRST and on its own. It is the durable record —
    // a correction that trains the model but fails to move the lead is a
    // recoverable annoyance, whereas a correction lost because the lead update
    // threw is destroyed evidence.
    const inserted = await db
      .insert(intentScoreFeedback)
      .values({
        // call_id is NOT NULL in E-159. A correction with no AI call still needs
        // a row, so it is keyed to the lead with an explicit sentinel rather
        // than a fabricated id that would look like a real call to the exporter.
        call_id: body.callId ?? `lead:${leadId}`,
        lead_id: leadId ?? call?.leadId ?? null,
        scoring_version: call?.scoringVersion ?? null,
        original_intent_score: call?.intentScore ?? null,
        original_signals: call?.signals ?? null,
        ai_band: call?.band ?? null,
        corrected_status: body.correctedStatus,
        corrected_score: body.correctedScore ?? null,
        corrected_signals: body.correctedSignals ?? null,
        reviewer_note: body.note ?? null,
        reviewed_by: user.id,
        reviewer_role: user.role ?? null,
        review_kind: "correction",
        source: "app",
        recording_id: body.recordingId ?? null,
        agreed,
      })
      .returning({
        id: intentScoreFeedback.id,
        createdAt: intentScoreFeedback.created_at,
      });

    const feedbackId = inserted[0]?.id;

    // ── The override ──
    const shouldApply = body.applyToLead !== false;
    let override: Awaited<ReturnType<typeof applyIntentOverride>> | null = null;

    if (shouldApply) {
      override = await applyIntentOverride({
        leadId,
        band: correctedBand,
        score: body.correctedScore ?? null,
        reviewerId: user.id,
      });

      // Record the human answer on the call ALONGSIDE the AI's, never over it.
      // See stampHumanBandOnCall's header for why ai_call_logs.band is left
      // alone.
      if (body.callId) {
        await stampHumanBandOnCall(body.callId, correctedBand, user.id);
      }

      if (override.applied && feedbackId) {
        await db
          .update(intentScoreFeedback)
          .set({ applied_to_lead: true, applied_at: new Date() })
          .where(eq(intentScoreFeedback.id, feedbackId));
      }
    }

    return successResponse(
      {
        id: feedbackId,
        createdAt: inserted[0]?.createdAt,
        agreed,
        aiBand: call?.band ?? null,
        correctedBand,
        applied: override?.applied ?? false,
        // What the lead now reads, so the client can update without refetching.
        lead: override?.applied
          ? {
              intentBand: override.band,
              finalIntentScore: override.score,
              currentStatus: override.status,
              interestLevel: override.interestLevel,
              intentBandSource: "human" as const,
            }
          : null,
      },
      201,
    );
  },
);

export const GET = withErrorHandler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    // ⚠ E-159's GET had NO auth check at all — it sat outside the handler's
    // auth block, and middleware early-exits on every /api path, so reviewer
    // notes on any lead were readable by anyone who could guess a lead id.
    await requireRole([...INTENT_REVIEW_ROLES]);

    const { id: leadId } = await ctx.params;
    const callId = new URL(req.url).searchParams.get("callId");

    const rows = await db
      .select({
        id: intentScoreFeedback.id,
        callId: intentScoreFeedback.call_id,
        correctedStatus: intentScoreFeedback.corrected_status,
        correctedScore: intentScoreFeedback.corrected_score,
        correctedSignals: intentScoreFeedback.corrected_signals,
        originalIntentScore: intentScoreFeedback.original_intent_score,
        aiBand: intentScoreFeedback.ai_band,
        agreed: intentScoreFeedback.agreed,
        appliedToLead: intentScoreFeedback.applied_to_lead,
        reviewKind: intentScoreFeedback.review_kind,
        source: intentScoreFeedback.source,
        recordingId: intentScoreFeedback.recording_id,
        note: intentScoreFeedback.reviewer_note,
        reviewerRole: intentScoreFeedback.reviewer_role,
        reviewerName: sql<string | null>`(
          SELECT u.name FROM users u WHERE u.id = ${intentScoreFeedback.reviewed_by}
        )`.as("reviewer_name"),
        createdAt: intentScoreFeedback.created_at,
      })
      .from(intentScoreFeedback)
      .where(
        callId
          ? eq(intentScoreFeedback.call_id, callId)
          : eq(intentScoreFeedback.lead_id, leadId),
      )
      .orderBy(desc(intentScoreFeedback.created_at))
      .limit(20);

    return successResponse({ feedback: rows });
  },
);

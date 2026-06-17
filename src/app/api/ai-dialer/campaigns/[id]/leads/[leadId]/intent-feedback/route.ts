// POST/GET /api/ai-dialer/campaigns/[id]/leads/[leadId]/intent-feedback
//
// Captures a reviewer's correction of an AI intent score from the transcript
// drawer ("this 65 is wrong"). The correction snapshots what the AI produced
// (original score + signals + scoring_version, read from the call's
// ai_call_logs row) and records the human ground truth. These rows are the
// benchmark/golden set the eval harness (scripts/intent) replays and the
// learning levers (calibration, weight-tuning) learn from.
//
// POST body:
//   { callId, correctedStatus, correctedScore?, correctedSignals?, note? }
// GET returns existing feedback rows for ?callId= (or all for this lead),
// newest first, so the drawer can show "already corrected".

import { db } from "@/lib/db";
import { aiCallLogs, intentScoreFeedback } from "@/lib/db/schema";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { createClient } from "@/lib/supabase/server";
import { QualificationSignalsSchema } from "@/lib/ai/scoring/signals";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

const LEAD_STATUSES = ["qualified", "warm", "cold", "disqualified"] as const;

const FeedbackBody = z.object({
  callId: z.string().min(1, "callId required"),
  correctedStatus: z.enum(LEAD_STATUSES),
  correctedScore: z.number().int().min(0).max(100).nullable().optional(),
  // Deep mode: a full QualificationSignals (yes/no facts) shape. Forgiving parse
  // (matches extraction). Old BANT-shaped corrections stay readable in the DB —
  // jsonb is untyped and rows are version-stamped.
  correctedSignals: QualificationSignalsSchema.nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});

export const POST = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ id: string; leadId: string }> }) => {
    const { leadId } = await ctx.params;

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return errorResponse("Not authenticated", 401);

    const body = FeedbackBody.parse(await req.json());

    // Snapshot what the AI produced for this call, so the golden row is
    // self-contained (no later mutation of ai_call_logs can rewrite history).
    const callRows = await db
      .select({
        intentScore: aiCallLogs.intent_score,
        signals: aiCallLogs.signals,
        scoringVersion: aiCallLogs.scoring_version,
        leadId: aiCallLogs.lead_id,
      })
      .from(aiCallLogs)
      .where(eq(aiCallLogs.call_id, body.callId))
      .orderBy(desc(aiCallLogs.created_at))
      .limit(1);

    const call = callRows[0] ?? null;

    const inserted = await db
      .insert(intentScoreFeedback)
      .values({
        call_id: body.callId,
        lead_id: leadId ?? call?.leadId ?? null,
        scoring_version: call?.scoringVersion ?? null,
        original_intent_score: call?.intentScore ?? null,
        original_signals: call?.signals ?? null,
        corrected_status: body.correctedStatus,
        corrected_score: body.correctedScore ?? null,
        corrected_signals: body.correctedSignals ?? null,
        reviewer_note: body.note ?? null,
        reviewed_by: user.id,
      })
      .returning({ id: intentScoreFeedback.id, createdAt: intentScoreFeedback.created_at });

    return successResponse({ id: inserted[0]?.id, createdAt: inserted[0]?.createdAt }, 201);
  },
);

export const GET = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ id: string; leadId: string }> }) => {
    const { leadId } = await ctx.params;
    const callId = new URL(req.url).searchParams.get("callId");

    const where = callId
      ? eq(intentScoreFeedback.call_id, callId)
      : eq(intentScoreFeedback.lead_id, leadId);

    const rows = await db
      .select({
        id: intentScoreFeedback.id,
        callId: intentScoreFeedback.call_id,
        correctedStatus: intentScoreFeedback.corrected_status,
        correctedScore: intentScoreFeedback.corrected_score,
        correctedSignals: intentScoreFeedback.corrected_signals,
        originalIntentScore: intentScoreFeedback.original_intent_score,
        note: intentScoreFeedback.reviewer_note,
        createdAt: intentScoreFeedback.created_at,
      })
      .from(intentScoreFeedback)
      .where(where)
      .orderBy(desc(intentScoreFeedback.created_at))
      .limit(20);

    return successResponse({ feedback: rows });
  },
);

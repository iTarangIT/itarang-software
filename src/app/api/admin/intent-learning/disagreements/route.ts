// GET /api/admin/intent-learning/disagreements — the promotion queue.
//
// Corrections where a human overruled the AI, newest first, with the transcript
// that produced the disagreement. These are the raw material of the learning
// loop: each one is a worked example of the model reading a call wrong, and the
// curator's job is to decide which are worth teaching.
//
// Deliberately NOT every correction. A reviewer confirming the AI was right is
// valuable as a measurement (it feeds the accuracy number) but useless as a
// teaching example — few-shot prompts work by showing the model cases it would
// otherwise get wrong, and padding them with cases it already handles just
// spends context.

import { NextRequest } from "next/server";
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { INTENT_CURATOR_ROLES } from "@/lib/leads/access";

interface Row {
  id: string;
  call_id: string;
  lead_id: string | null;
  lead_name: string | null;
  ai_band: string | null;
  original_intent_score: number | null;
  corrected_status: string;
  corrected_score: number | null;
  corrected_signals: unknown;
  original_signals: unknown;
  reviewer_note: string | null;
  reviewer_role: string | null;
  reviewer_name: string | null;
  created_at: string | Date;
  transcript: string | null;
  scoring_version: string | null;
  already_promoted: boolean;
}

function rowsOf<T>(result: unknown): T[] {
  return (((result as { rows?: T[] }).rows ?? (result as T[])) || []) as T[];
}

export const GET = withErrorHandler(async (req: NextRequest) => {
  await requireRole([...INTENT_CURATOR_ROLES]);

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") || "") || 25, 100);

  const result = await db.execute(sql`
    SELECT f.id::text                    AS id,
           f.call_id,
           f.lead_id,
           dl.dealer_name                AS lead_name,
           f.ai_band,
           f.original_intent_score,
           f.corrected_status,
           f.corrected_score,
           f.corrected_signals,
           f.original_signals,
           f.reviewer_note,
           f.reviewer_role,
           u.name                        AS reviewer_name,
           f.created_at,
           acl.transcript,
           f.scoring_version,
           -- Already taught? A curator must not promote the same call twice,
           -- and seeing WHICH rows are already in the prompt is most of the
           -- decision about what to promote next.
           EXISTS (
             SELECT 1 FROM intent_calibration_examples e
              WHERE e.source_feedback_id = f.id
           )                             AS already_promoted
      FROM intent_score_feedback f
      LEFT JOIN users u ON u.id = f.reviewed_by
      LEFT JOIN dealer_leads dl ON dl.id = f.lead_id
      LEFT JOIN LATERAL (
            SELECT transcript
              FROM ai_call_logs
             WHERE call_id = f.call_id
             ORDER BY created_at DESC
             LIMIT 1
      ) acl ON true
     WHERE f.review_kind = 'correction'
       AND f.agreed IS FALSE
       -- A teaching example needs a transcript to teach FROM. A correction on
       -- a call with no stored text can still count toward accuracy, but it
       -- cannot become a few-shot, so it does not belong in this queue.
       AND acl.transcript IS NOT NULL
       AND length(acl.transcript) > 40
     ORDER BY f.created_at DESC
     LIMIT ${limit}
  `);

  const items = rowsOf<Row>(result).map((r) => ({
    id: r.id,
    callId: r.call_id,
    leadId: r.lead_id,
    leadName: r.lead_name,
    aiBand: r.ai_band,
    aiScore: r.original_intent_score,
    humanStatus: r.corrected_status,
    humanScore: r.corrected_score,
    // The curator edits these before promoting; corrected_signals is only
    // present when the reviewer used deep mode, so fall back to what the AI
    // extracted as the starting point.
    correctedSignals: r.corrected_signals ?? r.original_signals ?? null,
    note: r.reviewer_note,
    reviewerRole: r.reviewer_role,
    reviewerName: r.reviewer_name,
    createdAt:
      r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    transcript: r.transcript,
    scoringVersion: r.scoring_version,
    alreadyPromoted: Boolean(r.already_promoted),
  }));

  return successResponse({ disagreements: items });
});

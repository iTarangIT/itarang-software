// GET/POST /api/admin/intent-learning/examples — the active teaching set.
//
// POST is the act that closes the learning loop: it takes a correction a
// reviewer made and turns it into a few-shot example the extraction prompt
// reads on every subsequent call. Before this, that step was "an engineer edits
// calibrationExamples.ts, bumps EXTRACTION_VERSION and redeploys" — which is
// why it had never happened.
//
// Gated to INTENT_CURATOR_ROLES, narrower than the reviewers who can correct.
// A promoted example changes how EVERY future call is read, so the blast radius
// is nothing like that of correcting one lead.

import { NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { INTENT_CURATOR_ROLES } from "@/lib/leads/access";
import { QualificationSignalsSchema } from "@/lib/ai/scoring/signals";
import { EXTRACTION_VERSION } from "@/lib/ai/scoring/version";
import { invalidateCalibrationCache } from "@/lib/ai/analysis/calibrationStore";

const CreateBody = z.object({
  // Shown TO THE MODEL as the example's heading — it is prompt text, not an
  // internal note, and it is the sentence that does the actual teaching. Hence
  // a real minimum length: "wrong" teaches nothing.
  why: z.string().min(10, "Explain what this example teaches — the model reads it."),
  transcript: z.string().min(20, "A teaching example needs a transcript."),
  signals: QualificationSignalsSchema,
  sortOrder: z.number().int().min(0).max(9999).optional(),
  sourceFeedbackId: z.string().uuid().nullable().optional(),
  sourceCallId: z.string().nullable().optional(),
});

function rowsOf<T>(result: unknown): T[] {
  return (((result as { rows?: T[] }).rows ?? (result as T[])) || []) as T[];
}

export const GET = withErrorHandler(async () => {
  await requireRole([...INTENT_CURATOR_ROLES]);

  const result = await db.execute(sql`
    SELECT e.id::text            AS id,
           e.why,
           e.transcript,
           e.signals,
           e.active,
           e.sort_order,
           e.source_call_id,
           e.source_feedback_id::text AS source_feedback_id,
           e.extraction_version,
           e.created_at,
           u.name                AS created_by_name
      FROM intent_calibration_examples e
      LEFT JOIN users u ON u.id = e.created_by
     ORDER BY e.active DESC, e.sort_order, e.created_at
     LIMIT 200
  `);

  const examples = rowsOf<Record<string, unknown>>(result).map((r) => ({
    id: r.id as string,
    why: r.why as string,
    transcript: r.transcript as string,
    signals: r.signals,
    active: Boolean(r.active),
    sortOrder: Number(r.sort_order ?? 100),
    sourceCallId: (r.source_call_id as string | null) ?? null,
    sourceFeedbackId: (r.source_feedback_id as string | null) ?? null,
    extractionVersion: (r.extraction_version as string | null) ?? null,
    createdAt:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : ((r.created_at as string | null) ?? null),
    createdByName: (r.created_by_name as string | null) ?? null,
  }));

  return successResponse({ examples });
});

export const POST = withErrorHandler(async (req: NextRequest) => {
  const user = await requireRole([...INTENT_CURATOR_ROLES]);

  const parsed = CreateBody.safeParse(await req.json());
  if (!parsed.success) {
    return errorResponse(parsed.error.issues[0]?.message ?? "Invalid example.", 400);
  }
  const body = parsed.data;

  // Refuse a second promotion of the same correction. Two identical few-shots
  // do not teach twice — they just spend prompt context and skew the model
  // toward one call.
  if (body.sourceFeedbackId) {
    const dupe = rowsOf<{ id: string }>(
      await db.execute(sql`
        SELECT id::text AS id
          FROM intent_calibration_examples
         WHERE source_feedback_id = ${body.sourceFeedbackId}::uuid
         LIMIT 1
      `),
    );
    if (dupe.length > 0) {
      return errorResponse("That correction is already a teaching example.", 409);
    }
  }

  const inserted = rowsOf<{ id: string }>(
    await db.execute(sql`
      INSERT INTO intent_calibration_examples
        (why, transcript, signals, sort_order, source_feedback_id, source_call_id,
         extraction_version, created_by)
      VALUES
        (${body.why}, ${body.transcript},
         ${sql`${JSON.stringify(body.signals)}::jsonb`},
         ${body.sortOrder ?? 100},
         ${body.sourceFeedbackId ?? null},
         ${body.sourceCallId ?? null},
         ${EXTRACTION_VERSION},
         ${user.id}::uuid)
      RETURNING id::text AS id
    `),
  );

  // Take effect now rather than in up to five minutes. A curator who promotes
  // an example and immediately re-runs a call expects to see it applied; a
  // silent cache delay reads as "it didn't work".
  invalidateCalibrationCache();

  return successResponse({ id: inserted[0]?.id }, 201);
});

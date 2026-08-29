// PATCH/DELETE /api/admin/intent-learning/examples/[exampleId]
//
// Editing and retiring teaching examples. Deactivating is the instant undo for
// a promotion that turned out to hurt: it takes the example out of the prompt
// on the next extraction, with no deploy. That reversibility is most of the
// argument for moving the calibration set into the database at all — the old
// TypeScript array could only be fixed by shipping code.
//
// DELETE is a soft retire by default, because an example's row is the audit
// trail linking a reviewer's correction to a change in model behaviour. Hard
// deletion is available but has to be asked for.

import { NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { INTENT_CURATOR_ROLES } from "@/lib/leads/access";
import { QualificationSignalsSchema } from "@/lib/ai/scoring/signals";
import { invalidateCalibrationCache } from "@/lib/ai/analysis/calibrationStore";

const PatchBody = z.object({
  active: z.boolean().optional(),
  why: z.string().min(10).optional(),
  transcript: z.string().min(20).optional(),
  signals: QualificationSignalsSchema.optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

function rowsOf<T>(result: unknown): T[] {
  return (((result as { rows?: T[] }).rows ?? (result as T[])) || []) as T[];
}

export const PATCH = withErrorHandler(
  async (req: NextRequest, ctx: { params: Promise<{ exampleId: string }> }) => {
    await requireRole([...INTENT_CURATOR_ROLES]);
    const { exampleId } = await ctx.params;

    const parsed = PatchBody.safeParse(await req.json());
    if (!parsed.success) {
      return errorResponse(parsed.error.issues[0]?.message ?? "Invalid patch.", 400);
    }
    const b = parsed.data;

    if (Object.keys(b).length === 0) {
      return errorResponse("Nothing to update.", 400);
    }

    // COALESCE rather than a dynamically-built SET list: every field is
    // optional and this keeps it one statement with no string concatenation
    // into SQL. `signals` needs the explicit cast because a NULL parameter has
    // no inferable type in that position.
    const updated = rowsOf<{ id: string }>(
      await db.execute(sql`
        UPDATE intent_calibration_examples
           SET active     = COALESCE(${b.active ?? null}, active),
               why        = COALESCE(${b.why ?? null}, why),
               transcript = COALESCE(${b.transcript ?? null}, transcript),
               signals    = COALESCE(${
                 b.signals ? sql`${JSON.stringify(b.signals)}::jsonb` : sql`NULL::jsonb`
               }, signals),
               sort_order = COALESCE(${b.sortOrder ?? null}, sort_order),
               updated_at = now()
         WHERE id = ${exampleId}::uuid
        RETURNING id::text AS id
      `),
    );

    if (updated.length === 0) return errorResponse("Example not found.", 404);

    invalidateCalibrationCache();
    return successResponse({ id: updated[0].id });
  },
);

export const DELETE = withErrorHandler(
  async (req: NextRequest, ctx: { params: Promise<{ exampleId: string }> }) => {
    await requireRole([...INTENT_CURATOR_ROLES]);
    const { exampleId } = await ctx.params;

    // Soft by default. The row links a reviewer's correction to a change in how
    // the model reads calls — throwing that away makes a past
    // calibration_set_hash unexplainable.
    const hard = new URL(req.url).searchParams.get("hard") === "1";

    const result = hard
      ? await db.execute(sql`
          DELETE FROM intent_calibration_examples
           WHERE id = ${exampleId}::uuid
          RETURNING id::text AS id
        `)
      : await db.execute(sql`
          UPDATE intent_calibration_examples
             SET active = false, updated_at = now()
           WHERE id = ${exampleId}::uuid
          RETURNING id::text AS id
        `);

    if (rowsOf<{ id: string }>(result).length === 0) {
      return errorResponse("Example not found.", 404);
    }

    invalidateCalibrationCache();
    return successResponse({ id: exampleId, deleted: hard });
  },
);

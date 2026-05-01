// [E-012] PATCH /api/admin/nbfc-assignments/{assignmentId}
//
// BRD §6.0.8 — update an existing dealer-NBFC assignment.
// Supports status change and notes update.
// Status transitions:
//   active <-> suspended
//   active|suspended -> terminated  (terminal — cannot move out)
//   terminated -> *                 -> 422
//
// Auth: admin (requireAdminOrTestBypass for the loop test plumbing).

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealerNbfcAssignments } from "@/lib/db/schema";
import { requireAdminOrTestBypass } from "@/lib/auth/adminTestBypass";

type RouteContext = {
  params: Promise<{ assignmentId: string }>;
};

const patchBodySchema = z
  .object({
    status: z.enum(["active", "suspended", "terminated"]).optional(),
    notes: z.string().max(2000).optional(),
  })
  .refine((v) => v.status !== undefined || v.notes !== undefined, {
    message: "At least one of `status` or `notes` must be provided",
  });

const ALLOWED_TRANSITIONS: Record<string, Set<string>> = {
  active: new Set(["active", "suspended", "terminated"]),
  suspended: new Set(["active", "suspended", "terminated"]),
  // terminated is terminal — no outgoing transitions.
  terminated: new Set(["terminated"]),
};

export async function PATCH(req: NextRequest, context: RouteContext) {
  const auth = await requireAdminOrTestBypass(req.headers);
  if (!auth.ok) return auth.response;

  try {
    const { assignmentId } = await context.params;
    const id = Number.parseInt(assignmentId, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return NextResponse.json(
        { success: false, message: "Invalid assignmentId" },
        { status: 400 },
      );
    }

    const json = await req.json().catch(() => null);
    const parsed = patchBodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        {
          success: false,
          error: "VALIDATION_ERROR",
          message: "Invalid request body",
          issues: parsed.error.flatten(),
        },
        { status: 400 },
      );
    }

    const [existing] = await db
      .select()
      .from(dealerNbfcAssignments)
      .where(eq(dealerNbfcAssignments.id, id))
      .limit(1);
    if (!existing) {
      return NextResponse.json(
        { success: false, error: "NOT_FOUND", message: "Assignment not found" },
        { status: 404 },
      );
    }

    // Validate status transition before any update.
    if (parsed.data.status) {
      const allowed = ALLOWED_TRANSITIONS[existing.status] ?? new Set<string>();
      if (!allowed.has(parsed.data.status)) {
        return NextResponse.json(
          {
            success: false,
            error: "invalid_transition",
            message: `Cannot transition status from '${existing.status}' to '${parsed.data.status}'`,
          },
          { status: 422 },
        );
      }
    }

    const updateValues: Partial<typeof dealerNbfcAssignments.$inferInsert> = {};
    if (parsed.data.status !== undefined) updateValues.status = parsed.data.status;
    if (parsed.data.notes !== undefined) updateValues.notes = parsed.data.notes;

    const [updated] = await db
      .update(dealerNbfcAssignments)
      .set(updateValues)
      .where(eq(dealerNbfcAssignments.id, id))
      .returning();

    return NextResponse.json({
      success: true,
      id: updated.id,
      dealerId: updated.dealer_id,
      nbfcId: updated.nbfc_id,
      status: updated.status,
      notes: updated.notes,
      enabledAt: updated.enabled_at,
    });
  } catch (error: unknown) {
    console.error("ADMIN NBFC ASSIGNMENT PATCH ERROR:", error);
    return NextResponse.json(
      { success: false, message: "Failed to update assignment" },
      { status: 500 },
    );
  }
}

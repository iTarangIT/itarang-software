// PATCH /api/admin/whatsapp-operators/[operatorId]
// Activate / deactivate an internal onboarding operator, or rename them.
//
// Deactivation is a flag flip, never a delete: dealer_onboarding_applications
// .onboarding_operator_id points here, and that attribution has to survive (the
// approve route overwrites dealer_user_id, so this is the only record of who
// onboarded a dealer). A deactivated number simply falls through the operator
// gate and gets the ordinary dealer greeting again.

import { eq } from "drizzle-orm";

import { db } from "@/lib/db/index";
import { whatsappOperators } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import {
  errorResponse,
  successResponse,
  withErrorHandler,
} from "@/lib/api-utils";

const WRITE_ROLES = ["admin", "sales_head"];

export const PATCH = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ operatorId: string }> }) => {
    const actor = await requireRole(WRITE_ROLES);
    const { operatorId } = await ctx.params;
    if (!operatorId) return errorResponse("Operator id required", 400);

    const body = await req.json().catch(() => ({}));
    const patch: Record<string, unknown> = { updated_at: new Date() };

    if (typeof body?.displayName === "string") {
      const name = body.displayName.trim();
      if (!name) return errorResponse("Name cannot be empty", 400);
      patch.display_name = name;
    }
    if (typeof body?.notes === "string") {
      patch.notes = body.notes.trim() || null;
    }
    if (typeof body?.isActive === "boolean") {
      patch.is_active = body.isActive;
      patch.deactivated_at = body.isActive ? null : new Date();
      patch.deactivated_by = body.isActive ? null : actor.id;
    }

    const [updated] = await db
      .update(whatsappOperators)
      .set(patch as never)
      .where(eq(whatsappOperators.id, operatorId))
      .returning();

    if (!updated) return errorResponse("Operator not found", 404);
    return successResponse({ operator: updated });
  },
);

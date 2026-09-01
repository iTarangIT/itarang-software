// PATCH /api/admin/dealer-extra-numbers/[id]
// Deactivate / re-activate an extra main-dealer number, or rename/annotate it.
//
// Deactivation is a flag flip, never a delete (matches whatsapp-operators and
// dealer_salespersons): the admin table keeps its history and the number is
// freed for a future re-add. The service layer also resets the number's live
// WhatsApp session so its next message falls back to onboarding cleanly.
// Re-activation re-runs the conflict matrix — the phone may have become an
// operator / salesperson / another dealer's number while inactive.

import { requireRole } from "@/lib/auth-utils";
import {
  errorResponse,
  successResponse,
  withErrorHandler,
} from "@/lib/api-utils";
import {
  CONFLICT_MESSAGES,
  deactivateExtraNumber,
  reactivateExtraNumber,
  updateExtraNumber,
} from "@/lib/team/extra-numbers";

const WRITE_ROLES = ["admin", "sales_head"];

export const PATCH = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const actor = await requireRole(WRITE_ROLES);
    const { id } = await ctx.params;
    if (!id) return errorResponse("Id required", 400);

    const body = await req.json().catch(() => ({}));

    if (typeof body?.isActive === "boolean") {
      if (body.isActive) {
        const result = await reactivateExtraNumber({ id });
        if (!result.ok) {
          if (result.reason === "not_found") {
            return errorResponse("Number not found", 404);
          }
          return errorResponse(CONFLICT_MESSAGES[result.reason], 409);
        }
        return successResponse({ number: result.number });
      }
      const row = await deactivateExtraNumber({ id, deactivatedBy: actor.id });
      if (!row) return errorResponse("Number not found (or already inactive)", 404);
      return successResponse({ number: row });
    }

    if (
      typeof body?.displayName === "string" ||
      typeof body?.notes === "string"
    ) {
      if (typeof body?.displayName === "string" && !body.displayName.trim()) {
        return errorResponse("Name cannot be empty", 400);
      }
      const row = await updateExtraNumber({
        id,
        displayName:
          typeof body?.displayName === "string" ? body.displayName : undefined,
        notes: typeof body?.notes === "string" ? body.notes : undefined,
      });
      if (!row) return errorResponse("Number not found", 404);
      return successResponse({ number: row });
    }

    return errorResponse("Nothing to update", 400);
  },
);

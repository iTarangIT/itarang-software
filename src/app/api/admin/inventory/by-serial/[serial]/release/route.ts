import { z } from "zod";

import { withErrorHandler, successResponse, errorResponse } from "@/lib/api-utils";
import { requireInventoryAdmin } from "@/lib/auth-utils";
import { db } from "@/lib/db";
import { InventoryLifecycleError, releaseInventorySerial } from "@/lib/inventory/lifecycle";

const bodySchema = z.object({
  leadId: z.string().min(1).optional(),
  dealerId: z.string().min(1).optional(),
  notes: z.string().max(500).optional(),
});

export const POST = withErrorHandler(
  async (req: Request, ctx: { params: Promise<{ serial: string }> }) => {
    const user = await requireInventoryAdmin();
    const { serial } = await ctx.params;
    const body = bodySchema.parse(await req.json());

    try {
      const updated = await db.transaction(async (tx) =>
        releaseInventorySerial({
          tx,
          serial,
          dealerId: body.dealerId,
          leadId: body.leadId,
          performedBy: user.id,
          notes: body.notes,
        }),
      );
      return successResponse({
        serial,
        status: updated.status,
        linkedLeadId: updated.linked_lead_id,
      });
    } catch (error) {
      if (error instanceof InventoryLifecycleError) {
        return errorResponse(error.message, error.statusCode);
      }
      throw error;
    }
  },
);

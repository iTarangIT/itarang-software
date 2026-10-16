// POST /api/admin/inventory/stock-tasks/[id]/close — ID 174: close a
// "Stock to upload" task by hand, with a reason. Admin, Inventory Manager and
// partner (the CEO reads the list but does not close).

import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { closeStockTaskByHand } from "@/lib/inventory/stockUploadTasks/service";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ note: z.string().trim().min(3, "Say why the task is closed.").max(500) });

export const POST = withErrorHandler(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireRole(["admin", "inventory_manager", "partner"]);
    const { id } = await ctx.params;
    const taskId = Number(id);
    if (!Number.isInteger(taskId) || taskId <= 0) return errorResponse("Unknown task.", 400);
    const { note } = bodySchema.parse(await req.json());
    const ok = await closeStockTaskByHand(taskId, user.id, note);
    if (!ok) return errorResponse("This task is already closed or does not exist.", 409);
    return successResponse({ closed: true });
});

// POST /api/admin/upload/[batchId]/restore — undo a rollback (BRD §0.4 — "can
// restore"). Re-activates every lead from the batch.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import {
    errorResponse,
    successResponse,
    withErrorHandler,
} from "@/lib/api-utils";

export const dynamic = "force-dynamic";

export const POST = withErrorHandler(
    async (_req: Request, ctx: { params: Promise<{ batchId: string }> }) => {
        await requireRole(["admin", "sales_head", "sales_insight", "inside_sales_rep"]);
        const { batchId } = await ctx.params;
        if (!batchId) return errorResponse("Batch id required.", 400);

        const rows = await db.execute<{ rolled_back_at: string | null }>(sql`
            SELECT rolled_back_at FROM upload_batches
            WHERE batch_id = ${batchId} LIMIT 1
        `);
        const batch = rows[0];
        if (!batch) return errorResponse("Batch not found.", 404);
        if (!batch.rolled_back_at) {
            return errorResponse("This batch is not rolled back.", 409);
        }

        await db.execute(sql`
            UPDATE dealer_leads
            SET is_active = TRUE, deleted_at = NULL, updated_at = NOW()
            WHERE upload_batch_id = ${batchId}
        `);
        await db.execute(sql`
            UPDATE upload_batches SET
                status = 'processed',
                rolled_back_at = NULL,
                rolled_back_by = NULL,
                updated_at = NOW()
            WHERE batch_id = ${batchId}
        `);

        return successResponse({ ok: true });
    },
);

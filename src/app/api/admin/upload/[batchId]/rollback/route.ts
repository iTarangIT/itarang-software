// POST /api/admin/upload/[batchId]/rollback — BRD §0.4. Within 24h of import,
// soft-deletes every lead created by the batch (is_active = false).

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import {
    errorResponse,
    successResponse,
    withErrorHandler,
} from "@/lib/api-utils";

import { uploadBatches, dealerLeads } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

export const POST = withErrorHandler(
    async (_req: Request, ctx: { params: Promise<{ batchId: string }> }) => {
        const user = await requireRole(["admin", "sales_head", "sales_insight", "inside_sales_rep"]);
        const { batchId } = await ctx.params;
        if (!batchId) return errorResponse("Batch id required.", 400);

        const rows = await db.execute<{
            status: string | null;
            rolled_back_at: string | null;
            rollback_window_until: string | null;
        }>(sql`
            SELECT status, rolled_back_at, rollback_window_until
            FROM ${uploadBatches} WHERE batch_id = ${batchId} LIMIT 1
        `);
        const batch = rows[0];
        if (!batch) return errorResponse("Batch not found.", 404);
        if (batch.rolled_back_at) {
            return errorResponse("This batch is already rolled back.", 409);
        }
        if (
            !batch.rollback_window_until ||
            new Date(batch.rollback_window_until).getTime() < Date.now()
        ) {
            return errorResponse(
                "The 24-hour rollback window for this batch has closed.",
                409,
            );
        }

        await db.execute(sql`
            UPDATE ${dealerLeads}
            SET is_active = FALSE, deleted_at = NOW(), updated_at = NOW()
            WHERE upload_batch_id = ${batchId}
        `);
        await db.execute(sql`
            UPDATE ${uploadBatches} SET
                status = 'rolled_back',
                rolled_back_at = NOW(),
                rolled_back_by = ${user.id},
                updated_at = NOW()
            WHERE batch_id = ${batchId}
        `);

        return successResponse({ ok: true });
    },
);

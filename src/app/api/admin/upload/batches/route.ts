// GET /api/admin/upload/batches — recent bulk-upload batches with rollback
// status (BRD §0.4).

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import type { UploadBatchSummary } from "@/lib/admin/types";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async () => {
    await requireRole(["admin", "sales_head", "ceo"]);

    const rows = await db.execute<UploadBatchSummary>(sql`
        SELECT b.batch_id, b.file_name, b.uploaded_by,
               u.name AS uploaded_by_name, b.total_rows, b.valid_rows,
               b.errored_rows, b.duplicate_rows, b.routing_to_ai,
               b.source_label, b.status, b.rollback_window_until,
               b.rolled_back_at, b.created_at
        FROM upload_batches b
        LEFT JOIN users u ON u.id::text = b.uploaded_by
        ORDER BY b.created_at DESC
        LIMIT 30
    `);

    return successResponse({ batches: rows as unknown as UploadBatchSummary[] });
});

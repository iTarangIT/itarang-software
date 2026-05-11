import { db } from "@/lib/db";
import { inventoryUploadReports, accounts, users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireInventoryAdmin } from "@/lib/auth-utils";
import { successResponse, errorResponse, withErrorHandler } from "@/lib/api-utils";

export const GET = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ reportId: string }> }) => {
    await requireInventoryAdmin();
    const { reportId } = await ctx.params;

    const rows = await db
      .select({
        id: inventoryUploadReports.id,
        dealerId: inventoryUploadReports.dealer_id,
        dealerName: accounts.business_entity_name,
        inventoryType: inventoryUploadReports.inventory_type,
        assetType: inventoryUploadReports.asset_type,
        uploadMethod: inventoryUploadReports.upload_method,
        uploadedBy: inventoryUploadReports.uploaded_by,
        uploadedByName: users.name,
        uploadedAt: inventoryUploadReports.uploaded_at,
        totalRows: inventoryUploadReports.total_rows,
        rowsImported: inventoryUploadReports.rows_imported,
        rowsSkipped: inventoryUploadReports.rows_skipped,
        errors: inventoryUploadReports.errors_json,
        insertedInventoryIds: inventoryUploadReports.inserted_inventory_ids,
        fileUrl: inventoryUploadReports.file_url,
        reportUrl: inventoryUploadReports.report_url,
        source: inventoryUploadReports.source,
      })
      .from(inventoryUploadReports)
      .leftJoin(accounts, eq(accounts.id, inventoryUploadReports.dealer_id))
      .leftJoin(users, eq(users.id, inventoryUploadReports.uploaded_by))
      .where(eq(inventoryUploadReports.id, reportId))
      .limit(1);

    const row = rows[0];
    if (!row) return errorResponse(`Report ${reportId} not found`, 404);

    return successResponse(row);
  },
);

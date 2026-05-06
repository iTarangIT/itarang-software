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
        dealer_id: inventoryUploadReports.dealer_id,
        dealer_name: accounts.business_entity_name,
        asset_type: inventoryUploadReports.asset_type,
        uploaded_by: inventoryUploadReports.uploaded_by,
        uploaded_by_name: users.name,
        uploaded_at: inventoryUploadReports.uploaded_at,
        total_rows: inventoryUploadReports.total_rows,
        inserted_rows: inventoryUploadReports.inserted_rows,
        skipped_rows: inventoryUploadReports.skipped_rows,
        errors_json: inventoryUploadReports.errors_json,
        inserted_inventory_ids: inventoryUploadReports.inserted_inventory_ids,
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

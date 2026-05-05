import { db } from "@/lib/db";
import { inventory, accounts } from "@/lib/db/schema";
import { and, eq, ilike, or, sql, desc, SQL } from "drizzle-orm";
import { requireInventoryAdmin } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";

// Filterable inventory listing for the admin dashboard.
// ?dealer_id=&status=&asset_type=&q=  (q searches serial / hsn / model)

export const GET = withErrorHandler(async (req: Request) => {
  await requireInventoryAdmin();
  const { searchParams } = new URL(req.url);
  const dealerId = searchParams.get("dealer_id");
  const status = searchParams.get("status");
  const assetType = searchParams.get("asset_type");
  const q = searchParams.get("q");
  const limit = Math.min(Number(searchParams.get("limit") || 200), 500);

  const conditions: SQL[] = [];
  if (dealerId) conditions.push(eq(inventory.dealer_id, dealerId));
  if (status) conditions.push(eq(inventory.status, status));
  if (assetType) conditions.push(eq(inventory.asset_type, assetType));
  if (q) {
    const like = `%${q}%`;
    const searchExpr = or(
      ilike(inventory.serial_number, like),
      ilike(inventory.model_type, like),
      ilike(inventory.hsn_code, like),
    );
    if (searchExpr) conditions.push(searchExpr);
  }

  const whereExpr = conditions.length ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id: inventory.id,
      serial_number: inventory.serial_number,
      asset_category: inventory.asset_category,
      asset_type: inventory.asset_type,
      model_type: inventory.model_type,
      status: inventory.status,
      warehouse_location: inventory.warehouse_location,
      hsn_code: inventory.hsn_code,
      oem_name: inventory.oem_name,
      dealer_id: inventory.dealer_id,
      dealer_name: accounts.business_entity_name,
      inventory_amount: inventory.inventory_amount,
      gst_amount: inventory.gst_amount,
      final_amount: inventory.final_amount,
      iot_imei_no: inventory.iot_imei_no,
      oem_invoice_number: inventory.oem_invoice_number,
      oem_invoice_date: inventory.oem_invoice_date,
      created_at: inventory.created_at,
    })
    .from(inventory)
    .leftJoin(accounts, eq(accounts.id, inventory.dealer_id))
    .where(whereExpr)
    .orderBy(desc(inventory.created_at))
    .limit(limit);

  // Aggregate KPIs in one round-trip
  const kpiRows = await db
    .select({
      status: inventory.status,
      count: sql<number>`count(*)::int`,
      value: sql<number>`coalesce(sum(${inventory.final_amount}), 0)::float`,
    })
    .from(inventory)
    .where(whereExpr)
    .groupBy(inventory.status);

  const kpis = {
    total: 0,
    available: 0,
    reserved: 0,
    sold: 0,
    write_off: 0,
    total_value: 0,
  } as Record<string, number>;
  for (const k of kpiRows) {
    kpis.total += k.count;
    kpis.total_value += Number(k.value || 0);
    if (k.status in kpis) kpis[k.status as keyof typeof kpis] = k.count;
  }

  return successResponse({ rows, kpis });
});

import { and, eq, notInArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { inventory, paraphernaliaStock } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, errorResponse, withErrorHandler } from "@/lib/api-utils";

const SERIAL_LIMIT = 500;

export const GET = withErrorHandler(async (req: Request) => {
  const user = await requireRole(["dealer"]);
  const dealerId = user.dealer_id;
  if (!dealerId) {
    return errorResponse("No dealer account is linked to this user.", 403);
  }

  const { searchParams } = new URL(req.url);
  const category = (searchParams.get("category") || "").trim();
  const sku = (searchParams.get("sku") || "").trim();

  if (!category) return errorResponse("category is required", 400);
  if (!sku) return errorResponse("sku is required", 400);

  if (category.toLowerCase() === "paraphernalia") {
    const [row] = await db
      .select({
        id: paraphernaliaStock.id,
        item_type: paraphernaliaStock.item_type,
        item_label: paraphernaliaStock.item_label,
        available_qty: paraphernaliaStock.available_qty,
        reserved_qty: paraphernaliaStock.reserved_qty,
        sold_qty: paraphernaliaStock.sold_qty,
        unit_cost: paraphernaliaStock.unit_cost,
        last_upload_at: paraphernaliaStock.last_upload_at,
      })
      .from(paraphernaliaStock)
      .where(
        and(
          eq(paraphernaliaStock.dealer_id, dealerId),
          eq(paraphernaliaStock.item_type, sku),
        ),
      )
      .limit(1);

    return successResponse({
      kind: "paraphernalia" as const,
      sku,
      category: "Paraphernalia",
      item_label: row?.item_label ?? null,
      available_qty: row?.available_qty ?? 0,
      reserved_qty: row?.reserved_qty ?? 0,
      sold_qty: row?.sold_qty ?? 0,
      unit_cost: row?.unit_cost ? Number(row.unit_cost) : 0,
      last_upload_at: row?.last_upload_at
        ? new Date(row.last_upload_at).toISOString()
        : null,
      serials: [] as never[],
    });
  }

  const rows = await db
    .select({
      id: inventory.id,
      serial_number: inventory.serial_number,
      status: inventory.status,
      iot_enabled: inventory.iot_enabled,
      iot_imei_no: inventory.iot_imei_no,
      soc_percent: inventory.soc_percent,
      soc_last_sync_at: inventory.soc_last_sync_at,
      warehouse_location: inventory.warehouse_location,
      physical_condition: inventory.physical_condition,
      star_rating: inventory.star_rating,
      material_code: inventory.material_code,
      batch_number: inventory.batch_number,
      voltage_v: inventory.voltage_v,
      capacity_ah: inventory.capacity_ah,
      final_amount: inventory.final_amount,
      allocated_to_dealer_at: inventory.allocated_to_dealer_at,
      sold_at: inventory.sold_at,
      dispatch_date: inventory.dispatch_date,
      oem_invoice_number: inventory.oem_invoice_number,
      oem_invoice_date: inventory.oem_invoice_date,
      oem_warranty_expiry: inventory.oem_warranty_expiry,
      oem_warranty_months: inventory.oem_warranty_months,
      created_at: inventory.created_at,
    })
    .from(inventory)
    .where(
      and(
        eq(inventory.dealer_id, dealerId),
        eq(inventory.asset_type, category),
        eq(inventory.model_type, sku),
        notInArray(inventory.status, ["transferred_out", "write-off"]),
      ),
    )
    .orderBy(
      sql`${inventory.allocated_to_dealer_at} DESC NULLS LAST`,
      sql`${inventory.created_at} DESC`,
    )
    .limit(SERIAL_LIMIT + 1);

  const truncated = rows.length > SERIAL_LIMIT;
  const serials = (truncated ? rows.slice(0, SERIAL_LIMIT) : rows).map((r) => ({
    id: r.id,
    serial_number: r.serial_number,
    status: r.status,
    iot_enabled: r.iot_enabled,
    iot_imei_no: r.iot_imei_no,
    soc_percent: r.soc_percent ? Number(r.soc_percent) : null,
    soc_last_sync_at: r.soc_last_sync_at
      ? new Date(r.soc_last_sync_at).toISOString()
      : null,
    warehouse_location: r.warehouse_location,
    physical_condition: r.physical_condition,
    star_rating: r.star_rating,
    material_code: r.material_code,
    batch_number: r.batch_number,
    voltage_v: r.voltage_v ? Number(r.voltage_v) : null,
    capacity_ah: r.capacity_ah ? Number(r.capacity_ah) : null,
    unit_price: r.final_amount ? Number(r.final_amount) : 0,
    allocated_to_dealer_at: r.allocated_to_dealer_at
      ? new Date(r.allocated_to_dealer_at).toISOString()
      : null,
    sold_at: r.sold_at ? new Date(r.sold_at).toISOString() : null,
    dispatch_date: r.dispatch_date ? new Date(r.dispatch_date).toISOString() : null,
    oem_invoice_number: r.oem_invoice_number,
    oem_invoice_date: r.oem_invoice_date
      ? new Date(r.oem_invoice_date).toISOString()
      : null,
    oem_warranty_expiry: r.oem_warranty_expiry
      ? new Date(r.oem_warranty_expiry).toISOString()
      : null,
    oem_warranty_months: r.oem_warranty_months,
    created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
  }));

  return successResponse({
    kind: "serialized" as const,
    sku,
    category,
    truncated,
    limit: SERIAL_LIMIT,
    serials,
  });
});

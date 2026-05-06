import { db } from "@/lib/db";
import { accounts, inventory } from "@/lib/db/schema";
import { and, eq, isNotNull, lte, sql, SQL } from "drizzle-orm";
import { requireInventoryAdmin } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";

// BRD V2 §5.3 — Inventory Ageing Report.
// GET /api/admin/inventory/ageing-report?minAge=90&dealerId=&category=&format=json|csv
//
// Surfaces stock that has been sitting in dealer warehouses for too long.
// Default minAge = 90 days (BRD ops cadence). Status filter is hard-pinned to
// items still on the shelf - sold / written_off rows are excluded.

const csvEscape = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const GET = withErrorHandler(async (req: Request) => {
  await requireInventoryAdmin();
  const { searchParams } = new URL(req.url);
  const minAge = Math.max(0, Number(searchParams.get("minAge") ?? "90"));
  const dealerId = searchParams.get("dealerId");
  const category = searchParams.get("category"); // matches inventory.asset_category
  const format = (searchParams.get("format") || "json").toLowerCase();

  // sold_date older than (today - minAge days). BRD calls this "Sold Date" in
  // the upload UI but the column is oem_invoice_date in the DB.
  const cutoff = new Date(Date.now() - minAge * 24 * 60 * 60 * 1000);

  const conditions: SQL[] = [
    isNotNull(inventory.oem_invoice_date),
    lte(inventory.oem_invoice_date, cutoff),
    // Only ageing matters for items still on the shelf — exclude sold and
    // written-off rows.
    sql`${inventory.status} NOT IN ('sold','written_off')`,
  ];
  if (dealerId) conditions.push(eq(inventory.dealer_id, dealerId));
  if (category) conditions.push(eq(inventory.asset_category, category));

  const rows = await db
    .select({
      battery_id: inventory.id,
      material_code: inventory.material_code,
      dealer_id: inventory.dealer_id,
      dealer_name: accounts.business_entity_name,
      category: inventory.asset_category,
      sub_category: inventory.sub_category,
      model_number: inventory.model_type,
      serial_number: inventory.serial_number,
      sold_date: inventory.oem_invoice_date,
      status: inventory.status,
      invoice_value: inventory.inventory_amount,
      star_rating: inventory.star_rating,
      soc_percent: inventory.soc_percent,
      imei_id: inventory.iot_imei_no,
      iot_enabled: inventory.iot_enabled,
      oem_warranty_date: inventory.oem_warranty_date,
      oem_warranty_expiry: inventory.oem_warranty_expiry,
      // Computed days-on-shelf so the page can sort + filter without redoing math.
      inventory_age_days: sql<number>`EXTRACT(DAY FROM (NOW() - ${inventory.oem_invoice_date}))::int`,
    })
    .from(inventory)
    .leftJoin(accounts, eq(accounts.id, inventory.dealer_id))
    .where(and(...conditions))
    .orderBy(sql`${inventory.oem_invoice_date} ASC`);

  if (format === "csv") {
    const headers = [
      "battery_id",
      "material_code",
      "dealer_name",
      "category",
      "sub_category",
      "model_number",
      "serial_number",
      "sold_date",
      "inventory_age_days",
      "status",
      "invoice_value",
      "star_rating",
      "soc_percent",
      "imei_id",
      "iot_enabled",
      "oem_warranty_date",
      "oem_warranty_expiry",
    ];
    const lines = [headers.join(",")];
    for (const r of rows) {
      lines.push(
        [
          r.battery_id,
          r.material_code,
          r.dealer_name,
          r.category,
          r.sub_category,
          r.model_number,
          r.serial_number,
          r.sold_date ? new Date(r.sold_date).toISOString().slice(0, 10) : "",
          r.inventory_age_days,
          r.status,
          r.invoice_value,
          r.star_rating,
          r.soc_percent,
          r.imei_id,
          r.iot_enabled,
          r.oem_warranty_date ? new Date(r.oem_warranty_date).toISOString().slice(0, 10) : "",
          r.oem_warranty_expiry ? new Date(r.oem_warranty_expiry).toISOString().slice(0, 10) : "",
        ]
          .map(csvEscape)
          .join(","),
      );
    }
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(lines.join("\n"), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="inventory-ageing-${stamp}.csv"`,
      },
    });
  }

  const buckets = { "0-30": 0, "31-90": 0, "91-180": 0, "181+": 0 };
  for (const r of rows) {
    const d = Number(r.inventory_age_days || 0);
    if (d <= 30) buckets["0-30"]++;
    else if (d <= 90) buckets["31-90"]++;
    else if (d <= 180) buckets["91-180"]++;
    else buckets["181+"]++;
  }

  return successResponse({
    rows,
    buckets,
    filters: { minAge, dealerId, category },
    generatedAt: new Date().toISOString(),
  });
});

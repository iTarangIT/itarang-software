import { db } from "@/lib/db";
import { inventory, accounts } from "@/lib/db/schema";
import { and, asc, count, desc, eq, ilike, lte, or, sql, SQL } from "drizzle-orm";
import { requireInventoryAdmin } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { normalizeInventoryStatus } from "@/lib/inventory/status";

function hasPgCode(error: unknown, code: string): boolean {
  let curr: unknown = error;
  while (curr && typeof curr === "object") {
    const rec = curr as { code?: string; cause?: unknown };
    if (rec.code === code) return true;
    curr = rec.cause;
  }
  return false;
}

export const GET = withErrorHandler(async (req: Request) => {
  await requireInventoryAdmin();
  const { searchParams } = new URL(req.url);

  const dealerId = searchParams.get("dealerId");
  const statusRaw = searchParams.get("status");
  const category = searchParams.get("category");
  const subCategory = searchParams.get("subCategory");
  const minAge = Number(searchParams.get("minAge") || "0");
  const q = searchParams.get("q");
  const sort = searchParams.get("sort") || "invoice_date_asc";
  const format = (searchParams.get("format") || "json").toLowerCase();
  const page = Math.max(1, Number(searchParams.get("page") || "1"));
  const limit = Math.min(500, Math.max(1, Number(searchParams.get("limit") || "50")));
  const offset = (page - 1) * limit;
  const queryLimit = format === "csv" ? 5000 : limit;
  const queryOffset = format === "csv" ? 0 : offset;

  const status = statusRaw ? normalizeInventoryStatus(statusRaw) : null;

  const conditions: SQL[] = [];
  const legacyConditions: SQL[] = [];
  if (dealerId) {
    conditions.push(eq(inventory.dealer_id, dealerId));
    legacyConditions.push(eq(inventory.dealer_id, dealerId));
  }
  if (status) {
    conditions.push(eq(inventory.status, status));
    legacyConditions.push(eq(inventory.status, status));
  }
  if (category) {
    conditions.push(eq(inventory.asset_category, category));
    legacyConditions.push(eq(inventory.asset_category, category));
  }
  if (subCategory) {
    conditions.push(eq(inventory.sub_category, subCategory));
    const legacySubExpr = or(
      eq(inventory.asset_type, subCategory),
      eq(inventory.model_type, subCategory),
    );
    if (legacySubExpr) legacyConditions.push(legacySubExpr);
  }
  if (minAge > 0) {
    const cutoff = new Date(Date.now() - minAge * 24 * 60 * 60 * 1000);
    conditions.push(lte(inventory.oem_invoice_date, cutoff));
    legacyConditions.push(lte(inventory.oem_invoice_date, cutoff));
  }
  if (q) {
    const like = `%${q}%`;
    const searchExpr = or(
      ilike(inventory.serial_number, like),
      ilike(inventory.model_type, like),
      ilike(inventory.sub_category, like),
      ilike(inventory.material_code, like),
      ilike(inventory.oem_name, like),
    );
    if (searchExpr) conditions.push(searchExpr);

    const legacySearchExpr = or(
      ilike(inventory.serial_number, like),
      ilike(inventory.model_type, like),
      ilike(inventory.asset_type, like),
      ilike(inventory.hsn_code, like),
      ilike(inventory.oem_name, like),
    );
    if (legacySearchExpr) legacyConditions.push(legacySearchExpr);
  }

  const whereExpr = conditions.length ? and(...conditions) : undefined;
  const legacyWhereExpr = legacyConditions.length ? and(...legacyConditions) : undefined;
  const orderBy =
    sort === "invoice_date_desc"
      ? desc(inventory.oem_invoice_date)
      : sort === "status"
        ? asc(inventory.status)
        : sort === "dealer"
          ? asc(accounts.business_entity_name)
          : asc(inventory.oem_invoice_date);

  let useLegacyColumns = false;
  let items: Array<{
    id: string;
    serialNumber: string | null;
    materialCode: string | null;
    inventoryType: string | null;
    category: string | null;
    subCategory: string | null;
    modelNumber: string | null;
    voltageV: string | null;
    capacityAh: string | null;
    outputCurrentA: string | null;
    starRating: number | null;
    iotEnabled: boolean | null;
    imeiId: string | null;
    status: string;
    linkedLeadId: string | null;
    dealerId: string | null;
    dealerName: string | null;
    warehouseLocation: string | null;
    invoiceNumber: string | null;
    invoiceDate: Date | null;
    invoiceValue: string | null;
    supplierName: string | null;
    physicalCondition: string | null;
    oemWarrantyDate: string | null;
    oemWarrantyMonths: number | null;
    oemWarrantyExpiry: string | null;
    createdAt: Date;
    updatedAt: Date;
    inventoryAgeDays: number | null;
  }>;

  try {
    items = await db
      .select({
        id: inventory.id,
        serialNumber: inventory.serial_number,
        materialCode: inventory.material_code,
        inventoryType: inventory.inventory_type,
        category: inventory.asset_category,
        subCategory: inventory.sub_category,
        modelNumber: inventory.model_type,
        voltageV: inventory.voltage_v,
        capacityAh: inventory.capacity_ah,
        outputCurrentA: inventory.output_current_a,
        starRating: inventory.star_rating,
        iotEnabled: inventory.iot_enabled,
        imeiId: inventory.iot_imei_no,
        status: inventory.status,
        linkedLeadId: inventory.linked_lead_id,
        dealerId: inventory.dealer_id,
        dealerName: accounts.business_entity_name,
        warehouseLocation: inventory.warehouse_location,
        invoiceNumber: inventory.oem_invoice_number,
        invoiceDate: inventory.oem_invoice_date,
        invoiceValue: inventory.inventory_amount,
        supplierName: inventory.oem_name,
        physicalCondition: inventory.physical_condition,
        oemWarrantyDate: inventory.oem_warranty_date,
        oemWarrantyMonths: inventory.oem_warranty_months,
        oemWarrantyExpiry: inventory.oem_warranty_expiry,
        createdAt: inventory.created_at,
        updatedAt: inventory.updated_at,
        inventoryAgeDays: sql<number>`EXTRACT(DAY FROM (NOW() - ${inventory.oem_invoice_date}))::int`,
      })
      .from(inventory)
      .leftJoin(accounts, eq(accounts.id, inventory.dealer_id))
      .where(whereExpr)
      .orderBy(orderBy)
      .limit(queryLimit)
      .offset(queryOffset);
  } catch (error) {
    if (!hasPgCode(error, "42703")) throw error;
    useLegacyColumns = true;

    items = await db
      .select({
        id: inventory.id,
        serialNumber: inventory.serial_number,
        materialCode: sql<string | null>`NULL::text`,
        inventoryType: inventory.asset_type,
        category: inventory.asset_category,
        subCategory: inventory.asset_type,
        modelNumber: inventory.model_type,
        voltageV: sql<string | null>`NULL::text`,
        capacityAh: sql<string | null>`NULL::text`,
        outputCurrentA: sql<string | null>`NULL::text`,
        starRating: sql<number | null>`NULL::int`,
        iotEnabled: sql<boolean>`false`,
        imeiId: sql<string | null>`NULL::text`,
        status: inventory.status,
        linkedLeadId: sql<string | null>`NULL::text`,
        dealerId: inventory.dealer_id,
        dealerName: accounts.business_entity_name,
        warehouseLocation: inventory.warehouse_location,
        invoiceNumber: inventory.oem_invoice_number,
        invoiceDate: inventory.oem_invoice_date,
        invoiceValue: inventory.inventory_amount,
        supplierName: inventory.oem_name,
        physicalCondition: sql<string | null>`NULL::text`,
        oemWarrantyDate: sql<string | null>`NULL::text`,
        oemWarrantyMonths: sql<number | null>`NULL::int`,
        oemWarrantyExpiry: sql<string | null>`NULL::text`,
        createdAt: inventory.created_at,
        updatedAt: inventory.updated_at,
        inventoryAgeDays: sql<number>`EXTRACT(DAY FROM (NOW() - ${inventory.oem_invoice_date}))::int`,
      })
      .from(inventory)
      .leftJoin(accounts, eq(accounts.id, inventory.dealer_id))
      .where(legacyWhereExpr)
      .orderBy(orderBy)
      .limit(queryLimit)
      .offset(queryOffset);
  }

  if (format === "csv") {
    const headers = [
      "serialNumber",
      "materialCode",
      "inventoryType",
      "category",
      "subCategory",
      "modelNumber",
      "status",
      "dealerName",
      "invoiceNumber",
      "invoiceDate",
      "invoiceValue",
      "inventoryAgeDays",
    ];
    const csvEscape = (v: unknown) => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(",")];
    for (const row of items) {
      lines.push(
        [
          row.serialNumber,
          row.materialCode,
          row.inventoryType,
          row.category,
          row.subCategory,
          row.modelNumber,
          row.status,
          row.dealerName,
          row.invoiceNumber,
          row.invoiceDate ? new Date(row.invoiceDate).toISOString().slice(0, 10) : "",
          row.invoiceValue,
          row.inventoryAgeDays,
        ]
          .map(csvEscape)
          .join(","),
      );
    }

    return new Response(lines.join("\n"), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="inventory-all-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }

  const activeWhereExpr = useLegacyColumns ? legacyWhereExpr : whereExpr;
  let total = items.length;
  const kpis = {
    totalUnits: 0,
    availableUnits: 0,
    reservedUnits: 0,
    soldUnits: 0,
    writtenOffUnits: 0,
    totalInvoiceValue: 0,
  };

  try {
    const [countRow] = await db
      .select({ total: count() })
      .from(inventory)
      .leftJoin(accounts, eq(accounts.id, inventory.dealer_id))
      .where(activeWhereExpr);
    total = countRow?.total ?? items.length;

    const kpiRows = await db
      .select({
        status: inventory.status,
        units: sql<number>`count(*)::int`,
        value: sql<number>`coalesce(sum(${inventory.inventory_amount}),0)::float`,
      })
      .from(inventory)
      .where(activeWhereExpr)
      .groupBy(inventory.status);

    for (const r of kpiRows) {
      kpis.totalUnits += r.units;
      kpis.totalInvoiceValue += Number(r.value || 0);
      if (r.status === "available") kpis.availableUnits = r.units;
      if (r.status === "reserved") kpis.reservedUnits = r.units;
      if (r.status === "sold") kpis.soldUnits = r.units;
      if (r.status === "written_off") kpis.writtenOffUnits = r.units;
    }
  } catch (error) {
    if (!hasPgCode(error, "42703")) throw error;
    total = items.length;
    for (const row of items) {
      kpis.totalUnits += 1;
      kpis.totalInvoiceValue += Number(row.invoiceValue || 0);
      if (row.status === "available") kpis.availableUnits += 1;
      if (row.status === "reserved") kpis.reservedUnits += 1;
      if (row.status === "sold") kpis.soldUnits += 1;
      if (row.status === "written_off") kpis.writtenOffUnits += 1;
    }
  }

  return successResponse({
    total,
    page,
    limit,
    items,
    kpis,
  });
});

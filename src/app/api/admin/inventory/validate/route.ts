import { db } from "@/lib/db";
import { inventory, oems, products } from "@/lib/db/schema";
import { inArray } from "drizzle-orm";
import { requireInventoryAdmin } from "@/lib/auth-utils";
import { successResponse, errorResponse, withErrorHandler } from "@/lib/api-utils";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import {
  ASSET_TYPES,
  AssetType,
} from "@/lib/inventory/csv-templates";
import {
  formatZodErrors,
  getRowSchema,
  ValidatedRow,
} from "@/lib/inventory/validation";

const MAX_ROWS = 500;

export const POST = withErrorHandler(async (req: Request) => {
  await requireInventoryAdmin();

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const assetType = (formData.get("assetType") || "") as AssetType;

  if (!file) return errorResponse("No file uploaded", 400);
  if (!ASSET_TYPES.includes(assetType))
    return errorResponse("assetType must be battery|charger|paraphernalia", 400);

  const buffer = await file.arrayBuffer();
  let rawRows: Record<string, unknown>[] = [];
  if (file.name.toLowerCase().endsWith(".csv")) {
    const text = new TextDecoder().decode(buffer);
    const parsed = Papa.parse<Record<string, unknown>>(text, {
      header: true,
      skipEmptyLines: true,
    });
    rawRows = parsed.data;
  } else {
    const wb = XLSX.read(buffer);
    rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
      wb.Sheets[wb.SheetNames[0]],
    );
  }

  if (rawRows.length === 0) return errorResponse("File contains no data rows", 400);
  if (rawRows.length > MAX_ROWS)
    return errorResponse(`Maximum ${MAX_ROWS} rows per upload`, 400);

  const schema = getRowSchema(assetType);

  // Pre-fetch lookup data once for the whole batch
  const incomingSerials = rawRows
    .map((r) => String(r.serial_number || "").trim())
    .filter(Boolean);

  const existingSerials = incomingSerials.length
    ? await db
        .select({ serial_number: inventory.serial_number })
        .from(inventory)
        .where(inArray(inventory.serial_number, incomingSerials))
    : [];
  const existingSet = new Set(
    existingSerials.map((r) => r.serial_number).filter((s): s is string => !!s),
  );

  const oemNames = Array.from(
    new Set(rawRows.map((r) => String(r.oem_name || "").trim()).filter(Boolean)),
  );
  const oemRows = oemNames.length
    ? await db.select().from(oems).where(inArray(oems.business_entity_name, oemNames))
    : [];
  const oemMap = new Map(oemRows.map((o) => [o.business_entity_name, o]));

  const hsnCodes = Array.from(
    new Set(rawRows.map((r) => String(r.hsn_code || "").trim()).filter(Boolean)),
  );
  const productRows = hsnCodes.length
    ? await db.select().from(products).where(inArray(products.hsn_code, hsnCodes))
    : [];
  const productMap = new Map(productRows.map((p) => [p.hsn_code, p]));

  const seenSerialsInBatch = new Set<string>();
  const validated: ValidatedRow[] = [];
  let validCount = 0;

  for (let i = 0; i < rawRows.length; i++) {
    const rowNumber = i + 2; // header is row 1
    const errors: string[] = [];
    let data: Record<string, unknown> | null = null;

    const parsed = schema.safeParse(rawRows[i]);
    if (!parsed.success) {
      errors.push(...formatZodErrors(parsed.error));
    } else {
      data = parsed.data as Record<string, unknown>;

      // OEM existence check
      const oem = oemMap.get(String(data.oem_name));
      if (!oem) errors.push(`OEM '${data.oem_name}' not registered`);

      // HSN / catalog product existence check
      const product = productMap.get(String(data.hsn_code));
      if (!product) errors.push(`No catalog product for HSN ${data.hsn_code}`);

      // Serial duplicate checks (battery/charger only)
      if (assetType !== "paraphernalia") {
        const serial = String(data.serial_number || "").trim();
        if (existingSet.has(serial)) {
          errors.push(`Serial ${serial} already exists in inventory`);
        }
        if (seenSerialsInBatch.has(serial)) {
          errors.push(`Serial ${serial} duplicated within this upload`);
        }
        seenSerialsInBatch.add(serial);
      }
    }

    const status: "valid" | "error" = errors.length === 0 ? "valid" : "error";
    if (status === "valid") validCount++;
    validated.push({ rowIndex: rowNumber, status, data, errors });
  }

  return successResponse({
    assetType,
    summary: {
      total: validated.length,
      valid: validCount,
      errors: validated.length - validCount,
    },
    rows: validated,
  });
});

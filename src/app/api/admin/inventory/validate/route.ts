import { db } from "@/lib/db";
import {
  inventory,
  productMasterBatteries,
  productMasterChargers,
  productMasterParaphernalia,
  products,
} from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import { requireInventoryAdmin } from "@/lib/auth-utils";
import { successResponse, errorResponse, withErrorHandler } from "@/lib/api-utils";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { ASSET_TYPES, AssetType } from "@/lib/inventory/csv-templates";
import { formatZodErrors, getRowSchema, ValidatedRow } from "@/lib/inventory/validation";

const MAX_ROWS = 500;
const MAX_BYTES = 5 * 1024 * 1024;

function hasPgCode(error: unknown, code: string): boolean {
  let curr: unknown = error;
  while (curr && typeof curr === "object") {
    const rec = curr as { code?: string; cause?: unknown };
    if (rec.code === code) return true;
    curr = rec.cause;
  }
  return false;
}

export const POST = withErrorHandler(async (req: Request) => {
  await requireInventoryAdmin();

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const assetType = (formData.get("assetType") || "") as AssetType;

  if (!file) return errorResponse("No file uploaded", 400);
  if (!ASSET_TYPES.includes(assetType))
    return errorResponse("assetType must be battery|charger|paraphernalia", 400);

  const fileName = file.name.toLowerCase();
  if (!fileName.endsWith(".csv") && !fileName.endsWith(".xlsx")) {
    return errorResponse("Please upload a CSV or Excel file", 400);
  }
  if (file.size > MAX_BYTES) {
    return errorResponse("File exceeds 5 MB limit. Please reduce or split the file.", 400);
  }

  const buffer = await file.arrayBuffer();
  let rawRows: Record<string, unknown>[] = [];
  if (fileName.endsWith(".csv")) {
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

  const serials =
    assetType === "battery"
      ? rawRows.map((r) => String(r.battery_id || "").trim()).filter(Boolean)
      : rawRows.map((r) => String(r.serial_number || "").trim()).filter(Boolean);
  const imeis =
    assetType === "battery"
      ? rawRows.map((r) => String(r.imei_id || "").trim()).filter(Boolean)
      : [];

  const existingSerials = serials.length
    ? await db
        .select({ serial_number: inventory.serial_number })
        .from(inventory)
        .where(inArray(inventory.serial_number, serials))
    : [];
  const existingSerialSet = new Set(
    existingSerials.map((r) => r.serial_number).filter((s): s is string => !!s),
  );

  const existingImeis = imeis.length
    ? await db
        .select({ iot_imei_no: inventory.iot_imei_no })
        .from(inventory)
        .where(inArray(inventory.iot_imei_no, imeis))
    : [];
  const existingImeiSet = new Set(
    existingImeis.map((r) => r.iot_imei_no).filter((s): s is string => !!s),
  );

  // Product-master existence (active only).
  // Graceful fallback: if BRD product-master tables are not migrated yet,
  // use legacy `products` rows by asset_type and do not fail validation.
  const warnings: string[] = [];
  let batteryModels = new Set<string>();
  let chargerModels = new Set<string>();
  let paraItems = new Set<string>();

  try {
    const rows = await db
      .select({ model_id: productMasterBatteries.model_id })
      .from(productMasterBatteries)
      .where(eq(productMasterBatteries.status, "active"));
    batteryModels = new Set(rows.map((r) => r.model_id));
  } catch (error) {
    if (hasPgCode(error, "42P01")) {
      warnings.push("Battery product-master table not found; using legacy product catalog fallback.");
    } else {
      throw error;
    }
  }

  try {
    const rows = await db
      .select({ model_id: productMasterChargers.model_id })
      .from(productMasterChargers)
      .where(eq(productMasterChargers.status, "active"));
    chargerModels = new Set(rows.map((r) => r.model_id));
  } catch (error) {
    if (hasPgCode(error, "42P01")) {
      warnings.push("Charger product-master table not found; using legacy product catalog fallback.");
    } else {
      throw error;
    }
  }

  try {
    const rows = await db
      .select({ item_type_code: productMasterParaphernalia.item_type_code })
      .from(productMasterParaphernalia)
      .where(eq(productMasterParaphernalia.status, "active"));
    paraItems = new Set(rows.map((r) => r.item_type_code));
  } catch (error) {
    if (hasPgCode(error, "42P01")) {
      warnings.push("Paraphernalia product-master table not found; item-type master check skipped.");
    } else {
      throw error;
    }
  }

  if (batteryModels.size === 0 || chargerModels.size === 0) {
    const legacyRows = await db
      .select({
        sku: products.sku,
        asset_type: products.asset_type,
        status: products.status,
        is_active: products.is_active,
      })
      .from(products);

    const activeLegacy = legacyRows.filter((r) => {
      const activeByFlag = r.is_active !== false;
      const activeByStatus = !r.status || String(r.status).toLowerCase() === "active";
      return activeByFlag && activeByStatus && !!r.sku;
    });

    if (batteryModels.size === 0) {
      batteryModels = new Set(
        activeLegacy
          .filter((r) => String(r.asset_type || "").toLowerCase().includes("battery"))
          .map((r) => String(r.sku).trim())
          .filter(Boolean),
      );
    }

    if (chargerModels.size === 0) {
      chargerModels = new Set(
        activeLegacy
          .filter((r) => String(r.asset_type || "").toLowerCase().includes("charger"))
          .map((r) => String(r.sku).trim())
          .filter(Boolean),
      );
    }
  }

  const seenSerialsInBatch = new Set<string>();
  const seenImeisInBatch = new Set<string>();
  const validated: ValidatedRow[] = [];
  let validCount = 0;

  for (let i = 0; i < rawRows.length; i++) {
    const rowNumber = i + 2;
    const errors: string[] = [];
    let data: Record<string, unknown> | null = null;

    const parsed = schema.safeParse(rawRows[i]);
    if (!parsed.success) {
      errors.push(...formatZodErrors(parsed.error));
    } else {
      data = parsed.data as Record<string, unknown>;

      const serial =
        assetType === "battery"
          ? String(data.battery_id || "").trim()
          : assetType === "charger"
            ? String(data.serial_number || "").trim()
            : "";
      if (serial) {
        if (existingSerialSet.has(serial)) {
          errors.push(`serial: ${serial} already exists in the system`);
        }
        if (seenSerialsInBatch.has(serial)) {
          errors.push(`serial: ${serial} duplicated within this upload`);
        }
        seenSerialsInBatch.add(serial);
      }

      if (assetType === "battery") {
        const imei = String(data.imei_id || "").trim();
        if (imei) {
          if (existingImeiSet.has(imei)) errors.push(`imei_id: ${imei} already assigned`);
          if (seenImeisInBatch.has(imei)) errors.push(`imei_id: ${imei} duplicated within this upload`);
          seenImeisInBatch.add(imei);
        }
        const model = String(data.model_number || "");
        if (batteryModels.size > 0 && !batteryModels.has(model)) {
          errors.push(`model_number: ${model} not found in active battery product master`);
        }
      }

      if (assetType === "charger") {
        const model = String(data.charger_model || "");
        if (chargerModels.size > 0 && !chargerModels.has(model)) {
          errors.push(`charger_model: ${model} not found in active charger product master`);
        }
      }

      if (assetType === "paraphernalia") {
        const itemType = String(data.item_type || "");
        if (paraItems.size > 0 && !paraItems.has(itemType)) {
          errors.push(`item_type: ${itemType} not found in active paraphernalia product master`);
        }
      }
    }

    const status: "valid" | "error" = errors.length === 0 ? "valid" : "error";
    if (status === "valid") validCount++;
    validated.push({ rowIndex: rowNumber, status, data, errors });
  }

  return successResponse({
    assetType,
    previewRows: rawRows.slice(0, 10),
    summary: {
      total: validated.length,
      valid: validCount,
      errors: validated.length - validCount,
    },
    warnings,
    rows: validated,
  });
});

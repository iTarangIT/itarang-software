import { db } from "@/lib/db";
import { inventory } from "@/lib/db/schema";
import { inArray } from "drizzle-orm";
import { requireInventoryAdmin } from "@/lib/auth-utils";
import { successResponse, errorResponse, withErrorHandler } from "@/lib/api-utils";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { ASSET_TYPES, AssetType } from "@/lib/inventory/csv-templates";
import { formatZodErrors, getRowSchema, ValidatedRow } from "@/lib/inventory/validation";
import { loadProductMasterBatch } from "@/lib/inventory/product-master";

const MAX_ROWS = 500;
const MAX_BYTES = 5 * 1024 * 1024;

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

  // ── Pre-load Product Master rows referenced by this file ─────────────────
  const masterKeys =
    assetType === "paraphernalia"
      ? rawRows.map((r) => String(r.item_type_code || "").trim()).filter(Boolean)
      : rawRows.map((r) => String(r.model_id || "").trim()).filter(Boolean);

  // Single typed branch per asset — keeps the union narrow downstream.
  const batteryMaster =
    assetType === "battery" ? await loadProductMasterBatch("battery", masterKeys) : null;
  const chargerMaster =
    assetType === "charger" ? await loadProductMasterBatch("charger", masterKeys) : null;
  const paraMaster =
    assetType === "paraphernalia"
      ? await loadProductMasterBatch("paraphernalia", masterKeys)
      : null;

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

      const masterKey =
        assetType === "paraphernalia"
          ? String(data.item_type_code || "").trim()
          : String(data.model_id || "").trim();
      const lookup = masterKey.toLowerCase();

      if (assetType === "battery") {
        const master = batteryMaster?.get(lookup);
        if (!master) {
          errors.push(`model_id: '${masterKey}' is not in active battery Product Master`);
        } else {
          const cat = String(data.category || "");
          if (
            master.compatibleCategories.length &&
            !master.compatibleCategories.some((c) => c.toLowerCase() === cat.toLowerCase())
          ) {
            errors.push(
              `category: '${cat}' is not compatible with ${master.modelId}. Compatible: ${master.compatibleCategories.join(", ")}`,
            );
          }
          const imei = String(data.imei_id || "").trim();
          if (imei) {
            if (existingImeiSet.has(imei)) errors.push(`imei_id: ${imei} already assigned`);
            if (seenImeisInBatch.has(imei)) errors.push(`imei_id: ${imei} duplicated within this upload`);
            seenImeisInBatch.add(imei);
          }
          if (data.iot_enabled === true && !master.iotCompatible) {
            errors.push(
              `iot_enabled: model '${master.modelId}' is not IoT-compatible; cannot set iot_enabled=Yes`,
            );
          }
        }
      } else if (assetType === "charger") {
        const master = chargerMaster?.get(lookup);
        if (!master) {
          errors.push(`model_id: '${masterKey}' is not in active charger Product Master`);
        }
      } else {
        const master = paraMaster?.get(lookup);
        if (!master) {
          errors.push(
            `item_type_code: '${masterKey}' is not in active paraphernalia Product Master`,
          );
        } else {
          const cat = String(data.category || "");
          if (
            master.compatibleCategories.length &&
            !master.compatibleCategories.some((c) => c.toLowerCase() === cat.toLowerCase())
          ) {
            errors.push(
              `category: '${cat}' is not compatible with ${master.itemTypeCode}. Compatible: ${master.compatibleCategories.join(", ")}`,
            );
          }
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
    warnings: [],
    rows: validated,
  });
});

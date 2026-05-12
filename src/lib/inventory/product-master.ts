import { db } from "@/lib/db";
import {
  productMasterBatteries,
  productMasterChargers,
  productMasterParaphernalia,
} from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import { AssetType } from "./csv-templates";

export interface BatteryMaster {
  kind: "battery";
  modelId: string;
  modelName: string;
  compatibleCategories: string[];
  compatibleSubCategories: string[];
  voltageV: string | null;
  capacityAh: string | null;
  batteryChemistry: string | null;
  warrantyMonths: number;
  iotCompatible: boolean;
  compatibleChargerModels: string[];
  status: string;
}

export interface ChargerMaster {
  kind: "charger";
  modelId: string;
  modelName: string;
  outputVoltageV: string | null;
  outputCurrentA: string | null;
  chargingType: string | null;
  compatibleBatteryModels: string[];
  warrantyMonths: number;
  status: string;
}

export interface ParaphernaliaMaster {
  kind: "paraphernalia";
  itemTypeCode: string;
  displayLabel: string;
  compatibleCategories: string[];
  maxQtyPerLead: number;
  harnessVariant: boolean;
  status: string;
}

export type MasterRow = BatteryMaster | ChargerMaster | ParaphernaliaMaster;

export type ResolveReason = "NOT_FOUND" | "INACTIVE";
export type ResolveResult<T> = { ok: true; master: T } | { ok: false; reason: ResolveReason };

const toStringArray = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x)).filter(Boolean);
    } catch {
      // fall through
    }
  }
  return [];
};

function mapBattery(row: typeof productMasterBatteries.$inferSelect): BatteryMaster {
  return {
    kind: "battery",
    modelId: row.model_id,
    modelName: row.model_name,
    compatibleCategories: toStringArray(row.compatible_categories),
    compatibleSubCategories: toStringArray(row.compatible_sub_categories),
    voltageV: row.voltage_v ?? null,
    capacityAh: row.capacity_ah ?? null,
    batteryChemistry: row.battery_chemistry ?? null,
    warrantyMonths: row.warranty_months ?? 0,
    iotCompatible: !!row.iot_compatible,
    compatibleChargerModels: toStringArray(row.compatible_charger_models),
    status: row.status,
  };
}

function mapCharger(row: typeof productMasterChargers.$inferSelect): ChargerMaster {
  return {
    kind: "charger",
    modelId: row.model_id,
    modelName: row.model_name,
    outputVoltageV: row.output_voltage_v ?? null,
    outputCurrentA: row.output_current_a ?? null,
    chargingType: row.charging_type ?? null,
    compatibleBatteryModels: toStringArray(row.compatible_battery_models),
    warrantyMonths: row.warranty_months ?? 0,
    status: row.status,
  };
}

function mapParaphernalia(
  row: typeof productMasterParaphernalia.$inferSelect,
): ParaphernaliaMaster {
  return {
    kind: "paraphernalia",
    itemTypeCode: row.item_type_code,
    displayLabel: row.display_label,
    compatibleCategories: toStringArray(row.compatible_categories),
    maxQtyPerLead: row.max_qty_per_lead ?? 0,
    harnessVariant: !!row.harness_variant,
    status: row.status,
  };
}

export async function resolveProductMaster(
  assetType: "battery",
  key: string,
): Promise<ResolveResult<BatteryMaster>>;
export async function resolveProductMaster(
  assetType: "charger",
  key: string,
): Promise<ResolveResult<ChargerMaster>>;
export async function resolveProductMaster(
  assetType: "paraphernalia",
  key: string,
): Promise<ResolveResult<ParaphernaliaMaster>>;
export async function resolveProductMaster(
  assetType: AssetType,
  key: string,
): Promise<ResolveResult<MasterRow>> {
  const trimmed = String(key || "").trim();
  if (!trimmed) return { ok: false, reason: "NOT_FOUND" };

  if (assetType === "battery") {
    const [row] = await db
      .select()
      .from(productMasterBatteries)
      .where(eq(productMasterBatteries.model_id, trimmed))
      .limit(1);
    if (!row) return { ok: false, reason: "NOT_FOUND" };
    if (row.status !== "active") return { ok: false, reason: "INACTIVE" };
    return { ok: true, master: mapBattery(row) };
  }

  if (assetType === "charger") {
    const [row] = await db
      .select()
      .from(productMasterChargers)
      .where(eq(productMasterChargers.model_id, trimmed))
      .limit(1);
    if (!row) return { ok: false, reason: "NOT_FOUND" };
    if (row.status !== "active") return { ok: false, reason: "INACTIVE" };
    return { ok: true, master: mapCharger(row) };
  }

  const [row] = await db
    .select()
    .from(productMasterParaphernalia)
    .where(eq(productMasterParaphernalia.item_type_code, trimmed))
    .limit(1);
  if (!row) return { ok: false, reason: "NOT_FOUND" };
  if (row.status !== "active") return { ok: false, reason: "INACTIVE" };
  return { ok: true, master: mapParaphernalia(row) };
}

/**
 * Bulk loader for the bulk-upload pre-flight phase.
 * Returns a Map keyed by lower-cased model_id / item_type_code so per-row
 * lookups are O(1) and case-insensitive.
 */
export async function loadProductMasterBatch(
  assetType: "battery",
  keys: string[],
): Promise<Map<string, BatteryMaster>>;
export async function loadProductMasterBatch(
  assetType: "charger",
  keys: string[],
): Promise<Map<string, ChargerMaster>>;
export async function loadProductMasterBatch(
  assetType: "paraphernalia",
  keys: string[],
): Promise<Map<string, ParaphernaliaMaster>>;
export async function loadProductMasterBatch(
  assetType: AssetType,
  keys: string[],
): Promise<Map<string, MasterRow>> {
  const cleaned = Array.from(
    new Set(keys.map((k) => String(k || "").trim()).filter(Boolean)),
  );
  const result = new Map<string, MasterRow>();
  if (!cleaned.length) return result;

  if (assetType === "battery") {
    const rows = await db
      .select()
      .from(productMasterBatteries)
      .where(inArray(productMasterBatteries.model_id, cleaned));
    for (const row of rows) result.set(row.model_id.toLowerCase(), mapBattery(row));
    return result;
  }

  if (assetType === "charger") {
    const rows = await db
      .select()
      .from(productMasterChargers)
      .where(inArray(productMasterChargers.model_id, cleaned));
    for (const row of rows) result.set(row.model_id.toLowerCase(), mapCharger(row));
    return result;
  }

  const rows = await db
    .select()
    .from(productMasterParaphernalia)
    .where(inArray(productMasterParaphernalia.item_type_code, cleaned));
  for (const row of rows) result.set(row.item_type_code.toLowerCase(), mapParaphernalia(row));
  return result;
}

export function isCategoryCompatible(master: BatteryMaster | ChargerMaster | ParaphernaliaMaster, category: string): boolean {
  const target = category.trim().toLowerCase();
  if (!target) return false;
  if (master.kind === "battery" || master.kind === "paraphernalia") {
    return master.compatibleCategories.some((c) => c.toLowerCase() === target);
  }
  return true;
}

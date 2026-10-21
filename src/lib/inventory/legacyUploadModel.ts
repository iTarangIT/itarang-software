/**
 * Tracker ID 173 (item 2) — the model of a row in the older Inventory › Bulk
 * upload (/api/inventory/bulk-upload).
 *
 * The page now hands out the Admin template, whose model column is `model_id`
 * (battery, charger) or `item_type_code` (paraphernalia). The older route used
 * to read `model_number` / `charger_model` / `item_type`, found nothing and
 * saved the model as plain 'Battery'. Now:
 *   1. the row names a Product Master key  → the model comes from the Product
 *      Master (same as Admin › Inventory › Bulk Upload); a key that is not an
 *      active Product Master row refuses the row (MODEL_NOT_FOUND), as there;
 *   2. no key but an old column           → the old column, as before (an old
 *      file keeps working);
 *   3. neither                            → the old default label.
 *
 * Pure: the route loads the Product Master rows (loadProductMasterBatch) and
 * passes the one for this row. Unit-tested in __tests__/legacyUploadModel.test.ts.
 */
import type { BatteryMaster, ChargerMaster, ParaphernaliaMaster } from "./product-master";

export type LegacyAssetType = "battery" | "charger" | "paraphernalia";

type Row = Record<string, unknown>;

function clean(value: unknown): string | null {
    const v = String(value ?? "").trim();
    return v.length ? v : null;
}

/** The Product Master key a row names: model_id (battery, charger) or item_type_code (paraphernalia). */
export function legacyMasterKeyOf(assetType: LegacyAssetType, r: Row): string | null {
    return assetType === "paraphernalia" ? clean(r.item_type_code) : clean(r.model_id);
}

export type LegacyModelFields = {
    ok: true;
    source: "product_master" | "legacy_column" | "default";
    modelType: string;
    assetCategory: string;
    subCategory: string | null;
    voltageV: string | null;
    capacityAh: string | null;
    outputCurrentA: string | null;
    /** Customer warranty from the Product Master; null when the master did not decide the model. */
    warrantyMonths: number | null;
};

export type LegacyModelRefusal = { ok: false; field: string; code: "MODEL_NOT_FOUND"; message: string };

function num(value: unknown): string | null {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n.toString() : null;
}

/**
 * Decide the model fields for one row. `master` is the active Product Master
 * row for legacyMasterKeyOf(row), or null/undefined when there is none.
 */
export function resolveLegacyUploadModel(
    assetType: LegacyAssetType,
    r: Row,
    master: BatteryMaster | ChargerMaster | ParaphernaliaMaster | null | undefined,
): LegacyModelFields | LegacyModelRefusal {
    const key = legacyMasterKeyOf(assetType, r);

    if (key) {
        if (!master || master.kind !== assetType) {
            const field = assetType === "paraphernalia" ? "item_type_code" : "model_id";
            const what = assetType === "paraphernalia" ? "Item Type Code" : "Model ID";
            return {
                ok: false,
                field,
                code: "MODEL_NOT_FOUND",
                message: `${what} '${key}' not found or inactive in ${assetType} Product Master.`,
            };
        }
        if (master.kind === "battery") {
            return {
                ok: true,
                source: "product_master",
                modelType: master.modelId,
                assetCategory: clean(r.category) || "Battery",
                subCategory: clean(r.sub_category) ?? master.compatibleSubCategories[0] ?? null,
                voltageV: num(master.voltageV) ?? num(r.voltage_v),
                capacityAh: num(master.capacityAh) ?? num(r.capacity_ah),
                outputCurrentA: null,
                warrantyMonths: master.warrantyMonths > 0 ? master.warrantyMonths : null,
            };
        }
        if (master.kind === "charger") {
            return {
                ok: true,
                source: "product_master",
                modelType: master.modelId,
                assetCategory: clean(r.category) || "Charger",
                subCategory: master.modelName,
                voltageV: num(master.outputVoltageV) ?? num(r.voltage_v),
                capacityAh: null,
                outputCurrentA: num(master.outputCurrentA) ?? num(r.output_current_a),
                warrantyMonths: master.warrantyMonths > 0 ? master.warrantyMonths : null,
            };
        }
        return {
            ok: true,
            source: "product_master",
            modelType: master.displayLabel,
            assetCategory: clean(r.category) || clean(r.compatible_category) || "Accessory",
            subCategory: master.itemTypeCode,
            voltageV: null,
            capacityAh: null,
            outputCurrentA: null,
            warrantyMonths: null,
        };
    }

    // Older file without a Product Master key: the old columns, as before.
    const legacy =
        assetType === "battery"
            ? clean(r.model_number)
            : assetType === "charger"
              ? clean(r.charger_model)
              : clean(r.item_type);
    const fallback = assetType === "battery" ? "Battery" : assetType === "charger" ? "Charger" : "Paraphernalia";
    return {
        ok: true,
        source: legacy ? "legacy_column" : "default",
        modelType: legacy || fallback,
        assetCategory:
            assetType === "battery"
                ? clean(r.category) || "Battery"
                : assetType === "charger"
                  ? clean(r.category) || clean(r.compatible_battery_models) || "Charger"
                  : clean(r.category) || clean(r.compatible_category) || "Accessory",
        subCategory:
            assetType === "battery" ? clean(r.sub_category) : assetType === "charger" ? clean(r.charger_model) : clean(r.item_type),
        voltageV: num(r.voltage_v),
        capacityAh: num(r.capacity_ah),
        outputCurrentA: num(r.output_current_a),
        warrantyMonths: null,
    };
}

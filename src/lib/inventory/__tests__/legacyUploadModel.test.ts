import { describe, expect, it } from "vitest";

import { legacyMasterKeyOf, resolveLegacyUploadModel } from "@/lib/inventory/legacyUploadModel";
import type { BatteryMaster, ChargerMaster, ParaphernaliaMaster } from "@/lib/inventory/product-master";
import { canSubmitStockTransfer, decideStockTransfer } from "@/lib/inventory/stockUploadRules";

const battery: BatteryMaster = {
    kind: "battery",
    modelId: "TK-LIFE-5145",
    modelName: "LiFe 51.2V 45Ah",
    compatibleCategories: ["2W"],
    compatibleSubCategories: ["Scooter"],
    voltageV: "51.2",
    capacityAh: "45",
    batteryChemistry: "LFP",
    warrantyMonths: 36,
    iotCompatible: true,
    compatibleChargerModels: [],
    status: "active",
};

const charger: ChargerMaster = {
    kind: "charger",
    modelId: "TK840W",
    modelName: "840W charger",
    outputVoltageV: "58.4",
    outputCurrentA: "12",
    chargingType: null,
    compatibleBatteryModels: ["TK-LIFE-5145"],
    warrantyMonths: 12,
    status: "active",
};

const para: ParaphernaliaMaster = {
    kind: "paraphernalia",
    itemTypeCode: "HARNESS",
    displayLabel: "Wiring harness",
    compatibleCategories: [],
    maxQtyPerLead: 0,
    harnessVariant: true,
    status: "active",
};

describe("legacyMasterKeyOf (ID 173 item 2)", () => {
    it("reads the Admin template's model column", () => {
        expect(legacyMasterKeyOf("battery", { model_id: " TK-LIFE-5145 " })).toBe("TK-LIFE-5145");
        expect(legacyMasterKeyOf("charger", { model_id: "TK840W" })).toBe("TK840W");
        expect(legacyMasterKeyOf("paraphernalia", { item_type_code: "HARNESS" })).toBe("HARNESS");
    });
    it("is null when the row has only the old column", () => {
        expect(legacyMasterKeyOf("battery", { model_number: "X" })).toBeNull();
        expect(legacyMasterKeyOf("paraphernalia", { item_type: "X" })).toBeNull();
    });
});

describe("resolveLegacyUploadModel (ID 173 item 2)", () => {
    it("takes a battery's model from the Product Master, not plain 'Battery'", () => {
        const r = resolveLegacyUploadModel("battery", { model_id: "tk-life-5145", category: "2W" }, battery);
        expect(r).toMatchObject({
            ok: true,
            source: "product_master",
            modelType: "TK-LIFE-5145",
            assetCategory: "2W",
            subCategory: "Scooter",
            voltageV: "51.2",
            capacityAh: "45",
            warrantyMonths: 36,
        });
    });

    it("takes a charger's and an accessory's model from the Product Master", () => {
        expect(resolveLegacyUploadModel("charger", { model_id: "TK840W" }, charger)).toMatchObject({
            ok: true,
            modelType: "TK840W",
            subCategory: "840W charger",
            outputCurrentA: "12",
            voltageV: "58.4",
        });
        expect(resolveLegacyUploadModel("paraphernalia", { item_type_code: "HARNESS" }, para)).toMatchObject({
            ok: true,
            modelType: "Wiring harness",
            subCategory: "HARNESS",
        });
    });

    it("refuses a model id that is not an active Product Master row, as the Admin upload does", () => {
        expect(resolveLegacyUploadModel("battery", { model_id: "NOPE" }, null)).toEqual({
            ok: false,
            field: "model_id",
            code: "MODEL_NOT_FOUND",
            message: "Model ID 'NOPE' not found or inactive in battery Product Master.",
        });
        expect(resolveLegacyUploadModel("paraphernalia", { item_type_code: "NOPE" }, undefined)).toMatchObject({
            ok: false,
            field: "item_type_code",
        });
        // A master of the wrong kind is no match either.
        expect(resolveLegacyUploadModel("battery", { model_id: "TK840W" }, charger).ok).toBe(false);
    });

    it("keeps an older file's model column working", () => {
        expect(resolveLegacyUploadModel("battery", { model_number: "OLD-51", sub_category: "3W" }, null)).toMatchObject({
            ok: true,
            source: "legacy_column",
            modelType: "OLD-51",
            subCategory: "3W",
            warrantyMonths: null,
        });
        expect(resolveLegacyUploadModel("charger", { charger_model: "C-1" }, null)).toMatchObject({
            ok: true,
            modelType: "C-1",
        });
    });

    it("falls back to the old default label only when the row names no model at all", () => {
        expect(resolveLegacyUploadModel("battery", {}, null)).toMatchObject({ ok: true, source: "default", modelType: "Battery" });
        expect(resolveLegacyUploadModel("paraphernalia", {}, null)).toMatchObject({ ok: true, modelType: "Paraphernalia" });
    });
});

describe("canSubmitStockTransfer (ID 173 item 4)", () => {
    it("matches the server rule: the form shows exactly for the roles POST does not refuse outright", () => {
        for (const role of ["admin", "inventory_manager", "partner", "dealer", "sales_head", "ops_manager", "ceo", "", null]) {
            const refusedOutright =
                (() => {
                    const d = decideStockTransfer({ role, sourceDealerId: "A", targetDealerId: "B", ownDealerCode: "A" });
                    return !d.ok && d.status === 403 && /Only Admin/.test(d.message);
                })();
            expect(canSubmitStockTransfer(role), String(role)).toBe(!refusedOutright);
        }
    });
    it("hides the form from Sales Head and Ops", () => {
        expect(canSubmitStockTransfer("sales_head")).toBe(false);
        expect(canSubmitStockTransfer("ops_manager")).toBe(false);
        expect(canSubmitStockTransfer("admin")).toBe(true);
    });
});

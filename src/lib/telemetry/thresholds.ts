/**
 * The red-flag thresholds that colour the Battery Analytics tab.
 *
 * ## Where these live, and where they do NOT
 *
 * The Intellicar alert-config endpoints are dead: `fetchAlertConfig()` returns `[]` and
 * `updateAlertConfig()` throws, because the thresholds the *alerting* pipeline fires on live
 * in the Python poller in `iot_stack`, on AWS, outside this repo.
 *
 * So these are display thresholds. Editing them changes what this dashboard calls a breach;
 * it does **not** change what the poller alerts on. The settings UI says so out loud, because
 * a control that looks like it arms an alarm and doesn't is worse than no control at all.
 *
 * Resolution order (E-190): battery model spec > `app_settings` row > env var > hardcoded
 * default — per field, resolved by the pure `resolveThresholds` in thresholds-math.ts.
 * The model spec comes from `battery_spec_models` via `device_battery_map.battery_model`,
 * so it only applies when a vehicleno is given; fleet-wide callers resolve as before.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { appSettings, batterySpecModels, deviceBatteryMap } from "@/lib/db/schema";
import {
    defaultThresholds,
    resolveThresholds,
    type BatteryThresholds,
} from "./thresholds-math";

export {
    capacityBands,
    defaultThresholds,
    resolveThresholds,
    type BatteryThresholds,
} from "./thresholds-math";

const SETTINGS_KEY = "intellicar_battery_thresholds";

export interface ResolvedBatteryThresholds extends BatteryThresholds {
    /** Model the spec fields came from, when a vehicleno resolved to one. */
    modelName?: string | null;
    /** Which fields the model spec overrode — lets the UI attribute a band to the spec. */
    specKeys?: (keyof BatteryThresholds)[];
    /**
     * Nameplate Ah from the model spec, when a vehicleno resolved to one. Spec-only by
     * design — a nameplate is a property of the pack, not a display preference, so it has
     * no app_settings/env rung. Callers use it as the fallback where the CAN payload's
     * rated_capacity is absent (the discharge Ah-out series).
     */
    ratedCapacityAh?: number | null;
}

/** Drizzle returns numeric columns as strings; a NULL column means "no limit recorded". */
function toNum(raw: string | null | undefined): number | null {
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

async function fetchSettingsPatch(): Promise<Partial<BatteryThresholds> | null> {
    const [row] = await db
        .select()
        .from(appSettings)
        .where(eq(appSettings.key, SETTINGS_KEY))
        .limit(1);
    return row ? (row.value as Partial<BatteryThresholds>) : null;
}

async function fetchSpecPatch(vehicleno: string): Promise<{
    modelName: string | null;
    patch: Partial<Record<keyof BatteryThresholds, number | null>> | null;
    ratedCapacityAh: number | null;
}> {
    // A vehicle can appear more than once in device_battery_map (re-deployments);
    // the active row with the latest installed_at is the current pack.
    const [row] = await db
        .select({
            modelName: batterySpecModels.model_name,
            ratedCapacityAh: batterySpecModels.rated_capacity_ah,
            underVoltageV: batterySpecModels.under_voltage_v,
            overVoltageV: batterySpecModels.over_voltage_v,
            overCurrentA: batterySpecModels.over_current_a,
            overTemperatureC: batterySpecModels.over_temperature_c,
        })
        .from(deviceBatteryMap)
        .innerJoin(
            batterySpecModels,
            eq(deviceBatteryMap.battery_model, batterySpecModels.model_name),
        )
        .where(
            and(
                eq(deviceBatteryMap.vehicle_number, vehicleno),
                eq(deviceBatteryMap.status, "active"),
            ),
        )
        .orderBy(desc(deviceBatteryMap.installed_at))
        .limit(1);
    if (!row) return { modelName: null, patch: null, ratedCapacityAh: null };
    return {
        modelName: row.modelName,
        ratedCapacityAh: toNum(row.ratedCapacityAh),
        patch: {
            underVoltageV: toNum(row.underVoltageV),
            overVoltageV: toNum(row.overVoltageV),
            overCurrentA: toNum(row.overCurrentA),
            overTemperatureC: toNum(row.overTemperatureC),
            // weakChargeCurrentA and the capacity fractions stay fleet-wide by design:
            // they describe how this dashboard judges, not what the pack is rated for.
        },
    };
}

export async function getBatteryThresholds(
    vehicleno?: string,
): Promise<ResolvedBatteryThresholds> {
    const defaults = defaultThresholds();
    try {
        const [settingsPatch, spec] = await Promise.all([
            fetchSettingsPatch(),
            vehicleno
                ? fetchSpecPatch(vehicleno)
                : Promise.resolve({ modelName: null, patch: null, ratedCapacityAh: null }),
        ]);
        const { thresholds, specKeys } = resolveThresholds(
            defaults,
            settingsPatch,
            spec.patch,
        );
        return {
            ...thresholds,
            modelName: spec.modelName,
            specKeys,
            ratedCapacityAh: spec.ratedCapacityAh,
        };
    } catch (err) {
        console.error("[Thresholds] Failed to read battery thresholds:", err);
        return defaults;
    }
}

export async function setBatteryThresholds(
    patch: Partial<BatteryThresholds>,
): Promise<BatteryThresholds> {
    const current = await getBatteryThresholds();
    const next: BatteryThresholds = {
        underVoltageV: current.underVoltageV,
        overVoltageV: current.overVoltageV,
        overCurrentA: current.overCurrentA,
        weakChargeCurrentA: current.weakChargeCurrentA,
        overTemperatureC: current.overTemperatureC,
        capacityWarningFrac: current.capacityWarningFrac,
        capacityCriticalFrac: current.capacityCriticalFrac,
        ...patch,
    };
    await db
        .insert(appSettings)
        .values({ key: SETTINGS_KEY, value: next, updated_at: new Date() })
        .onConflictDoUpdate({
            target: appSettings.key,
            set: { value: next, updated_at: new Date() },
        });
    return next;
}

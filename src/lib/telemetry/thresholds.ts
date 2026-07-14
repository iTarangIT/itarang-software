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
 * Resolution order: `app_settings` row > env var > hardcoded default. `app_settings`
 * (key text PK, value jsonb) already exists, so this needs no migration.
 */
import { db } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

const SETTINGS_KEY = "intellicar_battery_thresholds";

export interface BatteryThresholds {
    /** Pack volts. Below this on a 48-60 V pack is a cell group collapsing under load. */
    underVoltageV: number;
    /** Pack volts. Above this is an overcharge or a BMS that has lost its reference. */
    overVoltageV: number;
    /** Amps. Above this on a pack that peaks near 57 A is abuse or a decode fault. */
    overCurrentA: number;
    /**
     * Amps. Average current *inside a detected charging cycle* below which the charge is
     * unusually weak — a failing charger or a high-resistance connection.
     *
     * NOT a naive "under current" test. A bare threshold on instantaneous current fires on
     * every parked vehicle and would count parked hours as faults. Scoping it to a charging
     * cycle is what turns a meaningless reading into a real, actionable one.
     */
    weakChargeCurrentA: number;
    /** °C. Pack temperature above this is a thermal event. */
    overTemperatureC: number;
    /** Fraction of the pack's own BMS nameplate below which capacity is a warning. */
    capacityWarningFrac: number;
    /** Fraction of nameplate below which capacity is critical. */
    capacityCriticalFrac: number;
}

function envNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw == null || raw.trim() === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Defaults.
 *
 * The voltage and current numbers are placeholders sized to what this fleet's telemetry
 * actually shows (packs peak near 57 A; rated capacity reads 105 Ah) — they are NOT from a
 * cell spec sheet, and they should be replaced with the manufacturer's limits before anyone
 * acts on a breach count. They are deliberately wide, so they flag the obvious and stay quiet
 * otherwise.
 *
 * The capacity bands ARE principled: 0.90x and 0.80x of each pack's own BMS nameplate. On the
 * 105 Ah packs in this fleet that is 94.5 Ah and 84 Ah — which is what was asked for (95/85)
 * — but expressed as a fraction it generalises to a pack of any rating, and a battery that
 * reports no nameplate simply gets no bands rather than being judged against someone else's.
 */
export function defaultThresholds(): BatteryThresholds {
    return {
        underVoltageV: envNumber("TELEMETRY_UNDER_VOLTAGE_V", 44),
        overVoltageV: envNumber("TELEMETRY_OVER_VOLTAGE_V", 60),
        overCurrentA: envNumber("TELEMETRY_OVER_CURRENT_A", 70),
        weakChargeCurrentA: envNumber("TELEMETRY_WEAK_CHARGE_CURRENT_A", 8),
        overTemperatureC: envNumber("TELEMETRY_OVER_TEMPERATURE_C", 55),
        capacityWarningFrac: envNumber("TELEMETRY_CAPACITY_WARNING_FRAC", 0.9),
        capacityCriticalFrac: envNumber("TELEMETRY_CAPACITY_CRITICAL_FRAC", 0.8),
    };
}

export async function getBatteryThresholds(): Promise<BatteryThresholds> {
    const defaults = defaultThresholds();
    try {
        const [row] = await db
            .select()
            .from(appSettings)
            .where(eq(appSettings.key, SETTINGS_KEY))
            .limit(1);
        if (!row) return defaults;
        // Merge rather than replace: a partial row must not blank the fields it omits.
        return { ...defaults, ...(row.value as Partial<BatteryThresholds>) };
    } catch (err) {
        console.error("[Thresholds] Failed to read battery thresholds:", err);
        return defaults;
    }
}

export async function setBatteryThresholds(
    patch: Partial<BatteryThresholds>,
): Promise<BatteryThresholds> {
    const current = await getBatteryThresholds();
    const next: BatteryThresholds = { ...current, ...patch };
    await db
        .insert(appSettings)
        .values({ key: SETTINGS_KEY, value: next, updated_at: new Date() })
        .onConflictDoUpdate({
            target: appSettings.key,
            set: { value: next, updated_at: new Date() },
        });
    return next;
}

/**
 * The capacity bands for one battery, from its own nameplate.
 *
 * Returns null when the BMS reports no rated capacity: a pack we cannot compare against
 * itself gets no bands at all, rather than being measured against a number invented for it.
 */
export function capacityBands(
    ratedAh: number | null,
    t: BatteryThresholds,
): { rated: number; warning: number; critical: number } | null {
    if (ratedAh == null || ratedAh <= 0) return null;
    return {
        rated: ratedAh,
        warning: Math.round(ratedAh * t.capacityWarningFrac * 10) / 10,
        critical: Math.round(ratedAh * t.capacityCriticalFrac * 10) / 10,
    };
}

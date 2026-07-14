/**
 * Pure threshold types and resolution — no DB imports, so tests and client code can
 * use these without a connection string. The async wrappers live in thresholds.ts.
 */

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

/**
 * Per-field threshold precedence: model spec > app_settings row > env/defaults.
 *
 * The settings patch is applied as a spread — exactly the pre-E-189 merge — so a fleet
 * with no spec rows resolves byte-for-byte as before. Spec fields are stricter: a spec
 * row is expected to be sparse (NULL columns mean "no manufacturer limit recorded"), so
 * only finite numbers override, and the keys that did are reported so the UI can say
 * which numbers came from the model spec rather than fleet settings.
 */
export function resolveThresholds(
    defaults: BatteryThresholds,
    settingsPatch: Partial<BatteryThresholds> | null | undefined,
    specPatch: Partial<Record<keyof BatteryThresholds, number | null>> | null | undefined,
): { thresholds: BatteryThresholds; specKeys: (keyof BatteryThresholds)[] } {
    const thresholds: BatteryThresholds = { ...defaults, ...(settingsPatch ?? {}) };
    const specKeys: (keyof BatteryThresholds)[] = [];
    for (const key of Object.keys(specPatch ?? {}) as (keyof BatteryThresholds)[]) {
        const value = specPatch?.[key];
        if (typeof value === "number" && Number.isFinite(value)) {
            thresholds[key] = value;
            specKeys.push(key);
        }
    }
    return { thresholds, specKeys };
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

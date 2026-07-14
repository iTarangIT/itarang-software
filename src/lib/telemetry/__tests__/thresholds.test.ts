import { describe, expect, it } from "vitest";
import {
    defaultThresholds,
    resolveThresholds,
    type BatteryThresholds,
} from "@/lib/telemetry/thresholds-math";

// resolveThresholds is the pure core of getBatteryThresholds: per-field precedence
// spec > app_settings > env/defaults. The async wrapper only fetches the two patches;
// every precedence rule lives here where it can be tested without a DB.

const defaults: BatteryThresholds = defaultThresholds();

describe("resolveThresholds", () => {
    it("returns the defaults untouched when there is no settings row and no spec", () => {
        const { thresholds, specKeys } = resolveThresholds(defaults, null, null);
        expect(thresholds).toEqual(defaults);
        expect(specKeys).toEqual([]);
    });

    it("matches the legacy settings merge exactly when no spec is present", () => {
        const patch = { underVoltageV: 46, weakChargeCurrentA: 6 };
        const { thresholds, specKeys } = resolveThresholds(defaults, patch, null);
        // Pre-E-189 behaviour was `{ ...defaults, ...settingsRow }`; a fleet with no
        // spec rows must resolve byte-for-byte the same as before.
        expect(thresholds).toEqual({ ...defaults, ...patch });
        expect(specKeys).toEqual([]);
    });

    it("a partial settings row overrides only the fields it names", () => {
        const { thresholds } = resolveThresholds(defaults, { overVoltageV: 58.4 }, null);
        expect(thresholds.overVoltageV).toBe(58.4);
        expect(thresholds.underVoltageV).toBe(defaults.underVoltageV);
        expect(thresholds.overCurrentA).toBe(defaults.overCurrentA);
    });

    it("spec fields win over both settings and defaults, and are reported in specKeys", () => {
        const { thresholds, specKeys } = resolveThresholds(
            defaults,
            { underVoltageV: 46, overVoltageV: 59 },
            { underVoltageV: 42.5 },
        );
        expect(thresholds.underVoltageV).toBe(42.5); // spec beats settings
        expect(thresholds.overVoltageV).toBe(59); // settings still apply where spec is silent
        expect(specKeys).toEqual(["underVoltageV"]);
    });

    it("null and non-finite spec values fall through instead of overriding", () => {
        const { thresholds, specKeys } = resolveThresholds(
            defaults,
            null,
            { underVoltageV: null, overVoltageV: Number.NaN, overCurrentA: 80 },
        );
        expect(thresholds.underVoltageV).toBe(defaults.underVoltageV);
        expect(thresholds.overVoltageV).toBe(defaults.overVoltageV);
        expect(thresholds.overCurrentA).toBe(80);
        expect(specKeys).toEqual(["overCurrentA"]);
    });
});

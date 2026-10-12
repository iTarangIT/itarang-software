import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
const { limitsOn } = await import("@/lib/timeLimits/store");
const { TIME_LIMIT_DEFAULTS } = await import("@/lib/timeLimits/registry");

const row = (limit_key: string, value: number, effective_from: string, changed_at = `${effective_from} 10:00`) => ({
    limit_key,
    value,
    effective_from,
    changed_at,
});

describe("time limits are dated (ID 85)", () => {
    it("no change rows = the defaults", () => {
        expect(limitsOn("2026-10-12", null)).toEqual(TIME_LIMIT_DEFAULTS);
    });

    it("a change applies from its effective day, earlier days keep the old value", () => {
        const rows = [row("idle_cc", 3, "2026-10-15")];
        expect(limitsOn("2026-10-14", rows).idle_cc).toBe(TIME_LIMIT_DEFAULTS.idle_cc);
        expect(limitsOn("2026-10-15", rows).idle_cc).toBe(3);
    });

    it("the latest change in force wins; unknown keys are ignored", () => {
        const rows = [row("idle_cc", 3, "2026-10-01"), row("idle_cc", 9, "2026-10-10"), row("retired_key", 1, "2026-10-01")];
        expect(limitsOn("2026-10-12", rows).idle_cc).toBe(9);
        expect(limitsOn("2026-10-12", rows)).not.toHaveProperty("retired_key");
    });
});

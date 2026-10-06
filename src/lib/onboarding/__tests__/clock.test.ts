import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { onboardingClockSql } from "../clock";

describe("the onboarding clock (ID 122)", () => {
    it("is last_action_at, falling back to updated_at, for the given alias", () => {
        expect(onboardingClockSql()).toBe("COALESCE(oa.last_action_at, oa.updated_at)");
        expect(onboardingClockSql("app")).toBe("COALESCE(app.last_action_at, app.updated_at)");
    });

    it("refuses anything that is not a plain SQL alias", () => {
        expect(() => onboardingClockSql("oa; DROP TABLE x")).toThrow();
        expect(() => onboardingClockSql("")).toThrow();
    });

    it("has one copy: no other file spells the expression out", { timeout: 60_000 }, () => {
        const SRC = join(process.cwd(), "src");
        const inlined: string[] = [];
        const walk = (dir: string) => {
            for (const entry of readdirSync(dir)) {
                const full = join(dir, entry);
                if (statSync(full).isDirectory()) walk(full);
                else if (/\.tsx?$/.test(entry) && !full.includes(`${sep}__tests__${sep}`)) {
                    const name = relative(SRC, full).split(sep).join("/");
                    if (name === "lib/onboarding/clock.ts") continue;
                    if (/COALESCE\(\s*\w+\.last_action_at\s*,\s*\w+\.updated_at\s*\)/.test(readFileSync(full, "utf8"))) {
                        inlined.push(name);
                    }
                }
            }
        };
        walk(SRC);
        expect(inlined).toEqual([]);
    });

    it("the sweep stamps its own column, and E-327 keeps it out of the clock", () => {
        const sweep = readFileSync(join(process.cwd(), "src", "lib", "agreement", "autoRefreshSweep.ts"), "utf8");
        expect(sweep).toMatch(/SET agreement_last_checked_at = NOW\(\)/);
        const migration = readFileSync(join(process.cwd(), "drizzle", "E-327_onboarding_last_real_action.sql"), "utf8");
        for (const ignored of ["updated_at", "agreement_last_checked_at", "provider_raw_response", "last_action_timestamp"]) {
            expect(migration, ignored).toContain(`'${ignored}'`);
        }
    });
});

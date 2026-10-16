import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// ID 11 — Finance is retired: an old link with business_type=finance reads as
// Battery sale on every report screen, never as an error or "every type".
vi.mock("@/lib/db", () => ({ db: {} }));
const { measureFiltersFrom } = await import("@/lib/dashboard/salesHeadMeasures");

const q = (s: string) => new URLSearchParams(s);

describe("business type from an old link (ID 11)", () => {
    it("Sales Head measures read finance as battery_sale", () => {
        expect(measureFiltersFrom(q("from=2026-10-01&to=2026-10-16&business_type=finance"))?.business_type).toBe("battery_sale");
        expect(measureFiltersFrom(q("from=2026-10-01&to=2026-10-16&business_type=Finance"))?.business_type).toBe("battery_sale");
        expect(measureFiltersFrom(q("from=2026-10-01&to=2026-10-16&business_type=buyback"))?.business_type).toBe("buyback");
        expect(measureFiltersFrom(q("from=2026-10-01&to=2026-10-16"))?.business_type).toBeNull();
    });

    it("no route or report reads business_type from the URL without the normaliser", () => {
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                const p = join(dir, name);
                if (statSync(p).isDirectory()) {
                    if (name !== "__tests__" && name !== "node_modules") walk(p);
                } else if (/\.(ts|tsx)$/.test(name)) {
                    const src = readFileSync(p, "utf8");
                    // A URL read of business_type that is not wrapped in businessTypeFilterParam.
                    for (const line of src.split(/\r?\n/)) {
                        if (/business_type:\s*(opt|get|str|p\.get|searchParams\.get)\(\s*["']business_type["']\s*\)/.test(line)) {
                            offenders.push(`${p}: ${line.trim()}`);
                        }
                    }
                }
            }
        };
        walk(join(process.cwd(), "src"));
        expect(offenders).toEqual([]);
    });
});

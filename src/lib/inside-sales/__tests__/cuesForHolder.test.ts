import { describe, expect, it } from "vitest";

import { cuesByRole, cuesForHolder, idleSeverity } from "@/lib/inside-sales/staleness";
import { TIME_LIMIT_DEFAULTS } from "@/lib/timeLimits/registry";

// ID 85 #5 (22 Oct) — the queue's row cues follow the person HOLDING the lead.
describe("queue row cues by the holder's role (ID 85 #5)", () => {
    const limits = {
        ...TIME_LIMIT_DEFAULTS,
        stale_yellow: 2,
        stale_red: 4,
        stale_critical: 6,
        stale_yellow_asm: 5,
        stale_red_asm: 10,
        stale_critical_asm: 14,
        idle_cc: 3,
        idle_asm: 7,
    };
    const byRole = cuesByRole(limits);

    it("an ASM-held lead gets the ASM set, whoever is looking", () => {
        expect(cuesForHolder(byRole, "asm")).toEqual({ stale: { yellow: 5, red: 10, critical: 14 }, idleDays: 7 });
        expect(cuesForHolder(byRole, "ASM").idleDays).toBe(7);
    });

    it("any other holder (ISR, manager, unassigned) gets the inside-sales set", () => {
        for (const role of ["inside_sales", "sales_manager", null, undefined, ""]) {
            expect(cuesForHolder(byRole, role)).toEqual({ stale: { yellow: 2, red: 4, critical: 6 }, idleDays: 3 });
        }
    });

    it("5 idle working days is past the limit for an ISR-held lead but not an ASM-held one", () => {
        expect(idleSeverity(5, cuesForHolder(byRole, "inside_sales").idleDays)).toBe("red");
        expect(idleSeverity(5, cuesForHolder(byRole, "asm").idleDays)).toBe("normal");
    });
});

import { describe, expect, it } from "vitest";

import { agentAlertKey, shouldAlertAgent } from "@/lib/neodove/agentAlert";

// A32 — an unmapped NeoDove agent alerts Admin once a day, not once a call.

describe("unmapped agent alert", () => {
    it("alerts once per agent per day, whatever the spelling", () => {
        const t0 = Date.UTC(2026, 9, 16, 10);
        expect(shouldAlertAgent("Nidhi  Pathak", t0)).toBe(true);
        expect(shouldAlertAgent("nidhi pathak", t0 + 60_000)).toBe(false);
        expect(shouldAlertAgent("NIDHI PATHAK", t0 + 23 * 3600_000)).toBe(false);
        expect(shouldAlertAgent("Nidhi Pathak", t0 + 24 * 3600_000 + 1)).toBe(true);
    });

    it("a call with no agent name raises nothing", () => {
        expect(shouldAlertAgent(null)).toBe(false);
        expect(shouldAlertAgent("   ")).toBe(false);
    });

    it("keys ignore case and extra spaces", () => {
        expect(agentAlertKey("  Chirag   Garg ")).toBe("chirag garg");
    });
});

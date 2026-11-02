// Territory routing — the pure rules: which ASM a qualified lead goes to.

import { describe, expect, it } from "vitest";
import {
    orderInTurn,
    placeKey,
    placeLabel,
    rankCandidates,
    routingApplies,
    type TerritoryCandidate,
} from "@/lib/ai-dialer/territoryRules";

const c = (asmId: string, territoryCity: string | null, lastRoutedAt: string | null = null, name = asmId): TerritoryCandidate => ({
    asmId,
    name,
    territoryId: `t-${asmId}-${territoryCity ?? "state"}`,
    territoryCity,
    lastRoutedAt,
});

describe("routingApplies", () => {
    it("routes qualified leads and callbacks, never complaints", () => {
        expect(routingApplies("qualified")).toBe(true);
        expect(routingApplies("sales")).toBe(true);
        expect(routingApplies("complaint")).toBe(false);
    });
});

describe("placeKey", () => {
    it("ignores case and stray spaces", () => {
        expect(placeKey("  Patna ")).toBe("patna");
        expect(placeKey("Navi   Mumbai")).toBe("navi mumbai");
        expect(placeKey(null)).toBe("");
    });
});

describe("rankCandidates", () => {
    it("a city mapping beats a whole-state mapping", () => {
        const r = rankCandidates([c("bihar-asm", null), c("patna-asm", "Patna")], ["patna"]);
        expect(r.rule).toBe("territory_city");
        expect(r.tied.map((x) => x.asmId)).toEqual(["patna-asm"]);
    });

    it("falls back to the state ASM when no one covers the city", () => {
        const r = rankCandidates([c("bihar-asm", null), c("patna-asm", "Patna")], ["Muzaffarpur"]);
        expect(r.rule).toBe("territory_state");
        expect(r.tied.map((x) => x.asmId)).toEqual(["bihar-asm"]);
    });

    it("matches any of the lead's city spellings, case-insensitively", () => {
        const r = rankCandidates([c("blr", " bengaluru ")], ["Bangalore", "Bengaluru"]);
        expect(r.rule).toBe("territory_city");
    });

    it("keeps every tied ASM once, even with a city and a state row", () => {
        const r = rankCandidates([c("a", "Patna"), c("a", null), c("b", "patna")], ["Patna"]);
        expect(r.tied.map((x) => x.asmId)).toEqual(["a", "b"]);
    });

    it("no match at all → no rule (caller falls back to the ISRs)", () => {
        expect(rankCandidates([c("pune", "Pune")], ["Patna"])).toEqual({ rule: null, tied: [] });
        expect(rankCandidates([], ["Patna"])).toEqual({ rule: null, tied: [] });
    });
});

describe("orderInTurn", () => {
    it("never-routed first, then the oldest last lead", () => {
        const order = orderInTurn([
            c("recent", "Patna", "2026-11-02T10:00:00Z"),
            c("older", "Patna", "2026-11-01T10:00:00Z"),
            c("never", "Patna", null),
        ]);
        expect(order.map((x) => x.asmId)).toEqual(["never", "older", "recent"]);
    });

    it("takes turns: after a lead, the same ASM moves to the back", () => {
        let pool = [c("a", "Patna"), c("b", "Patna")];
        const got: string[] = [];
        for (let i = 0; i < 4; i++) {
            const next = orderInTurn(pool)[0];
            got.push(next.asmId);
            const at = new Date(Date.UTC(2026, 10, 2, 10, i)).toISOString();
            pool = pool.map((x) => (x.asmId === next.asmId ? { ...x, lastRoutedAt: at } : x));
        }
        expect(got).toEqual(["a", "b", "a", "b"]);
    });

    it("breaks exact ties by name for a stable order", () => {
        const order = orderInTurn([c("2", null, null, "Zoya"), c("1", null, null, "Arun")]);
        expect(order.map((x) => x.name)).toEqual(["Arun", "Zoya"]);
    });
});

describe("placeLabel", () => {
    it("names the city for a city match, the state otherwise", () => {
        expect(placeLabel("Bihar", "Patna", "territory_city")).toBe("Patna");
        expect(placeLabel("Bihar", "Muzaffarpur", "territory_state")).toBe("Bihar");
    });
});

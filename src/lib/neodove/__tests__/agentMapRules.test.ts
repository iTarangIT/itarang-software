// Tests for the NeoDove agent → CRM user map rules (review R-03). The
// suggestion cases matter most: a wrong suggestion saved without a second look
// credits a rep with someone else's calls, and the numbers still look plausible.

import { describe, expect, it } from "vitest";
import { agentKey, parseAgentMap, suggestUserId } from "@/lib/neodove/agentMapRules";

const users = [
    { user_id: "u-nidhi", name: "Nidhi" },
    { user_id: "u-chirag", name: "Chirag" },
    { user_id: "u-jiten", name: "Jiten" },
];

describe("agentKey", () => {
    it("folds case and whitespace so one agent is one entry", () => {
        expect(agentKey("NIDHI PATHAK")).toBe("nidhi pathak");
        expect(agentKey("  Nidhi   Pathak ")).toBe("nidhi pathak");
    });

    it("treats blank and non-string names as no agent", () => {
        expect(agentKey("   ")).toBeNull();
        expect(agentKey(null)).toBeNull();
        expect(agentKey(undefined)).toBeNull();
    });
});

describe("parseAgentMap", () => {
    it("reads the stored blob and re-normalises keys", () => {
        expect(
            parseAgentMap({ agents: { "NIDHI PATHAK": "u-nidhi", "Chirag Garg": "u-chirag" } }),
        ).toEqual({ "nidhi pathak": "u-nidhi", "chirag garg": "u-chirag" });
    });

    it("drops malformed entries instead of throwing", () => {
        expect(parseAgentMap(null)).toEqual({});
        expect(parseAgentMap({ agents: ["x"] })).toEqual({});
        expect(parseAgentMap({ agents: { " ": "u-1", ok: 5, fine: "u-2" } })).toEqual({
            fine: "u-2",
        });
    });
});

describe("suggestUserId", () => {
    it("suggests the single user whose first name matches", () => {
        expect(suggestUserId("NIDHI PATHAK", users)).toBe("u-nidhi");
        expect(suggestUserId("Chirag Garg", users)).toBe("u-chirag");
    });

    it("refuses to guess between two candidates", () => {
        const twoNidhis = [...users, { user_id: "u-nidhi-2", name: "Nidhi Sharma" }];
        expect(suggestUserId("NIDHI PATHAK", twoNidhis)).toBeNull();
    });

    it("suggests nothing when nobody matches", () => {
        expect(suggestUserId("Rushikesh", users)).toBeNull();
    });
});

// ID 224 points 2 and 5 — downloads show words, not database codes.
import { describe, expect, it } from "vitest";

import { CLOSED_LEAD_STATUSES, contactabilityText, leadStatusText } from "@/lib/exports/datasets/labels";

describe("leadStatusText", () => {
    it("shows the Leads list's words", () => {
        expect(leadStatusText("Assigned_Not_Contacted")).toBe("Assigned");
        expect(leadStatusText("Transferred_to_ASM")).toBe("Awaiting field visit");
        expect(leadStatusText("Lost")).toBe("Lost");
    });
    it("no status = Not in pipeline; an unknown code is spaced out", () => {
        expect(leadStatusText(null)).toBe("Not in pipeline");
        expect(leadStatusText("")).toBe("Not in pipeline");
        expect(leadStatusText("Some_New_State")).toBe("Some New State");
    });
});

describe("contactabilityText", () => {
    it("words for the two marks, blank when reachable", () => {
        expect(contactabilityText("dead_number")).toBe("Dead number");
        expect(contactabilityText("non_responsive")).toMatch(/^Non-responsive/);
        expect(contactabilityText(null)).toBeNull();
    });
});

describe("CLOSED_LEAD_STATUSES", () => {
    it("treats Won as closed", () => {
        expect([...CLOSED_LEAD_STATUSES].sort()).toEqual(["Converted", "Lost", "Won"]);
    });
});

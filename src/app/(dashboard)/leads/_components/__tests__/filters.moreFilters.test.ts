// C37 (wording audit, 2 Nov): the Leads filter bar keeps only search, Status,
// Interest, Owner and the Created dates on top; everything else sits behind
// "More filters". These tests pin the rule that keeps a hidden filter visible:
// the badge counts it, and the panel opens when a link arrives with one set.

import { describe, expect, it } from "vitest";
import {
    countSecondary,
    EMPTY_FILTERS,
    fromSearchParams,
    shouldOpenMore,
    type LeadFilters,
} from "../filters";

const f = (patch: Partial<LeadFilters>): LeadFilters => ({ ...EMPTY_FILTERS, ...patch });

describe("More filters badge (countSecondary)", () => {
    it("is 0 with no filters", () => {
        expect(countSecondary(EMPTY_FILTERS)).toBe(0);
    });

    it("does not count the top-row filters", () => {
        expect(
            countSecondary(
                f({ search: "x", status: "Lost", intent: "hot", ownerId: "u1", from: "2026-11-01", to: "2026-11-03" }),
            ),
        ).toBe(0);
    });

    it.each([
        ["businessType", "retailer"],
        ["campaign", "c1"],
        ["sourceDoor", "scraper"],
        ["scrapeRun", "r1"],
        ["neodove", "1"],
        ["callback", "1"],
        ["needsMobile", "1"],
        ["readyNoOwner", "1"],
        ["showDead", "1"],
    ] as [keyof LeadFilters, string][])("counts %s, moved from the top row", (key, value) => {
        expect(countSecondary(f({ [key]: value } as Partial<LeadFilters>))).toBe(1);
    });

    it("counts the AI score range once, whichever end is set", () => {
        expect(countSecondary(f({ scoreMin: "40" }))).toBe(1);
        expect(countSecondary(f({ scoreMax: "90" }))).toBe(1);
        expect(countSecondary(f({ scoreMin: "40", scoreMax: "90" }))).toBe(1);
    });

    it("counts the Assigned range once", () => {
        expect(countSecondary(f({ assignedFrom: "2026-10-01", assignedTo: "2026-10-31" }))).toBe(1);
    });

    it("still counts the filters that were already there", () => {
        expect(countSecondary(f({ asmId: "a1", city: "Pune", aiBand: "Warm" }))).toBe(3);
    });
});

describe("More filters opens on load (shouldOpenMore)", () => {
    it("stays closed on a plain /leads", () => {
        expect(shouldOpenMore(fromSearchParams(new URLSearchParams("")))).toBe(false);
    });

    it("stays closed for a top-row filter in the URL", () => {
        expect(shouldOpenMore(fromSearchParams(new URLSearchParams("status=Lost")))).toBe(false);
    });

    it("opens for the Sales dashboard link ?ready_no_owner=1", () => {
        expect(shouldOpenMore(fromSearchParams(new URLSearchParams("ready_no_owner=1")))).toBe(true);
    });

    it("opens for ?neodove=1", () => {
        expect(shouldOpenMore(fromSearchParams(new URLSearchParams("neodove=1")))).toBe(true);
    });
});

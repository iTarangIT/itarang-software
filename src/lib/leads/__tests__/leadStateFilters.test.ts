// Tests for the lead-state filter vocabulary.
//
// The behaviour worth pinning is the sanitiser. `filters` arrives from two
// untrusted places — a POSTed campaign selection, and a region_filter jsonb blob
// written by an older build — and its output is composed into SQL. Everything
// except `disposition` must come out of a closed vocabulary, and `disposition`
// must survive as free text because a value NeoDove sent outside the CC sheet is
// legitimately filterable (leadListQuery's facets report what is actually in the
// data, not just what the sheet lists).

import { describe, expect, it } from "vitest";
import {
    AI_CALL_STATES,
    describeLeadStateFilters,
    hasLeadStateFilter,
    isAiCallState,
    sanitizeLeadStateFilters,
    summarizeLeadStateFilters,
} from "@/lib/leads/leadStateFilters";

describe("sanitizeLeadStateFilters", () => {
    it("drops keys it does not know", () => {
        const out = sanitizeLeadStateFilters({
            aiCallState: "never_called",
            somethingElse: "DROP TABLE leads",
            excludeAiConnected: false,
        });
        expect(out).toEqual({ aiCallState: "never_called" });
    });

    it("refuses an unknown aiCallState rather than passing it through", () => {
        expect(sanitizeLeadStateFilters({ aiCallState: "sometimes" })).toEqual({});
        expect(sanitizeLeadStateFilters({ aiCallState: 7 })).toEqual({});
    });

    it("accepts only the two real connect statuses", () => {
        expect(
            sanitizeLeadStateFilters({ connectStatus: "connected" }).connectStatus,
        ).toBe("connected");
        expect(
            sanitizeLeadStateFilters({ connectStatus: "not_connected" }).connectStatus,
        ).toBe("not_connected");
        expect(
            sanitizeLeadStateFilters({ connectStatus: "maybe" }).connectStatus,
        ).toBeUndefined();
    });

    // Free text on purpose — see the module header. It is parameterised at the
    // SQL layer, never interpolated.
    it("keeps a disposition outside the CC sheet", () => {
        expect(
            sanitizeLeadStateFilters({ disposition: "Some NeoDove Value" }).disposition,
        ).toBe("Some NeoDove Value");
    });

    it("coerces the attempts floor to a positive integer or nothing", () => {
        expect(sanitizeLeadStateFilters({ aiAttemptsMin: 3 }).aiAttemptsMin).toBe(3);
        expect(sanitizeLeadStateFilters({ aiAttemptsMin: "4" }).aiAttemptsMin).toBe(4);
        expect(sanitizeLeadStateFilters({ aiAttemptsMin: 2.7 }).aiAttemptsMin).toBe(2);
        // 0 and negatives mean "no floor", not "at least zero" — a floor of 0
        // would emit a predicate that matches everything AND costs a subquery.
        expect(sanitizeLeadStateFilters({ aiAttemptsMin: 0 }).aiAttemptsMin).toBeUndefined();
        expect(sanitizeLeadStateFilters({ aiAttemptsMin: -5 }).aiAttemptsMin).toBeUndefined();
        expect(sanitizeLeadStateFilters({ aiAttemptsMin: "lots" }).aiAttemptsMin).toBeUndefined();
    });

    it("survives junk input", () => {
        expect(sanitizeLeadStateFilters(null)).toEqual({});
        expect(sanitizeLeadStateFilters(undefined)).toEqual({});
        expect(sanitizeLeadStateFilters("nope")).toEqual({});
        expect(sanitizeLeadStateFilters(42)).toEqual({});
    });

    it("trims whitespace-only strings away entirely", () => {
        expect(sanitizeLeadStateFilters({ disposition: "   " })).toEqual({});
        expect(sanitizeLeadStateFilters({ dispositionBucket: "" })).toEqual({});
    });
});

describe("hasLeadStateFilter", () => {
    // "any" is the default and must not count, or the campaign modal would show
    // a filter badge before the user has touched anything.
    it("treats the default as no filter", () => {
        expect(hasLeadStateFilter({ aiCallState: "any" })).toBe(false);
        expect(hasLeadStateFilter({})).toBe(false);
        expect(hasLeadStateFilter(null)).toBe(false);
    });

    it("counts each real filter", () => {
        expect(hasLeadStateFilter({ aiCallState: "never_called" })).toBe(true);
        expect(hasLeadStateFilter({ aiAttemptsMin: 2 })).toBe(true);
        expect(hasLeadStateFilter({ connectStatus: "connected" })).toBe(true);
        expect(hasLeadStateFilter({ dispositionBucket: "Hot" })).toBe(true);
        expect(hasLeadStateFilter({ disposition: "Price High" })).toBe(true);
    });
});

describe("summarizeLeadStateFilters", () => {
    // At most one clause: this renders inside a table cell in the Campaigns
    // list, so joining every set filter would overflow it.
    it("returns one clause even when several filters are set", () => {
        const s = summarizeLeadStateFilters({
            aiCallState: "never_called",
            connectStatus: "connected",
            dispositionBucket: "Hot",
            disposition: "Price High",
        });
        expect(s).toBe("Price High");
        expect(s?.includes("·")).toBe(false);
    });

    it("is null when nothing is set", () => {
        expect(summarizeLeadStateFilters({ aiCallState: "any" })).toBeNull();
        expect(summarizeLeadStateFilters(null)).toBeNull();
    });

    it("folds the attempts floor into the no-connect label", () => {
        expect(
            summarizeLeadStateFilters({
                aiCallState: "attempted_not_connected",
                aiAttemptsMin: 3,
            }),
        ).toBe("No connect ×3+");
    });
});

describe("describeLeadStateFilters", () => {
    // The long form DOES join everything — it renders in a page header.
    it("joins every set clause", () => {
        const d = describeLeadStateFilters({
            aiCallState: "never_called",
            connectStatus: "connected",
            dispositionBucket: "Hot",
        });
        expect(d).toContain("Never called by AI");
        expect(d).toContain("Connected");
        expect(d).toContain("bucket Hot");
    });

    it("is null when nothing is set", () => {
        expect(describeLeadStateFilters({ aiCallState: "any" })).toBeNull();
    });
});

describe("isAiCallState", () => {
    it("accepts exactly the declared states", () => {
        for (const s of AI_CALL_STATES) expect(isAiCallState(s)).toBe(true);
        expect(isAiCallState("connected")).toBe(false);
        expect(isAiCallState(null)).toBe(false);
    });
});

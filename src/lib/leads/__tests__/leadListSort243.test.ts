// ID 243 — the Leads list header sort: the page and the API read the same
// column list, and a link only ever names one of them.
import { describe, expect, it } from "vitest";

import { LEAD_LIST_SORT_KEYS, LEAD_LIST_SORT_SPECS, leadSortFromParams } from "../leadListSort";
import { nextSortState } from "@/components/shared/tableSortCore";

describe("Leads list sort (ID 243)", () => {
    it("the header specs and the API allowlist name the same columns", () => {
        expect(LEAD_LIST_SORT_SPECS.map((s) => s.key).sort()).toEqual([...LEAD_LIST_SORT_KEYS].sort());
    });

    it("reads ?sort=&dir= only for an allowed column", () => {
        expect(leadSortFromParams(new URLSearchParams("sort=last_activity&dir=asc"))).toEqual({ key: "last_activity", dir: "asc" });
        expect(leadSortFromParams(new URLSearchParams("sort=dealer"))).toEqual({ key: "dealer", dir: "asc" });
        expect(leadSortFromParams(new URLSearchParams("sort=created&dir=desc"))).toEqual({ key: "created", dir: "desc" });
        expect(leadSortFromParams(new URLSearchParams("sort=phone;drop"))).toBeNull();
        expect(leadSortFromParams(new URLSearchParams(""))).toBeNull();
        expect(leadSortFromParams(null)).toBeNull();
    });

    it("Last activity opens newest first, then oldest first, then the list's own order", () => {
        const spec = LEAD_LIST_SORT_SPECS.find((s) => s.key === "last_activity")!;
        const first = nextSortState(null, "last_activity", spec.type);
        expect(first).toEqual({ key: "last_activity", dir: "desc" });
        const second = nextSortState(first, "last_activity", spec.type);
        expect(second).toEqual({ key: "last_activity", dir: "asc" });
        expect(nextSortState(second, "last_activity", spec.type)).toBeNull();
    });
});

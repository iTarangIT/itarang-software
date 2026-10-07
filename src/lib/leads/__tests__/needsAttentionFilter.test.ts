import { describe, expect, it } from "vitest";

import { filterNeedsAttention, needsAttentionFiltersFrom } from "../needsAttentionFilter";
import type { NeedsAttentionRow } from "../needsAttention";

const row = (o: Partial<NeedsAttentionRow>): NeedsAttentionRow => ({
    lead_id: "L",
    dealer: "Shop",
    city: null,
    holder_id: "u1",
    holder_name: "Nidhi",
    holder_role: "inside_sales_rep",
    lead_status: "Assigned_Not_Contacted",
    interest_level: null,
    days_idle: 6,
    last_worked_at: null,
    last_disposition: null,
    last_disposition_bucket: null,
    non_responsive: false,
    visit_overdue: false,
    ...o,
});

const rows = [
    row({ lead_id: "a", dealer: "Mishra Auto", city: "Kanpur", holder_name: "Sonu", holder_role: "asm", days_idle: 56 }),
    row({ lead_id: "b", dealer: "E Rikshaw", interest_level: "hot", days_idle: 8 }),
    row({ lead_id: "c", dealer: "Apna Motors", lead_status: "Commercials_Explained", days_idle: 20 }),
];
const ids = (r: NeedsAttentionRow[]) => r.map((x) => x.lead_id);

describe("filterNeedsAttention", () => {
    it("returns everything with no filters", () => {
        expect(ids(filterNeedsAttention(rows, {}))).toEqual(["a", "b", "c"]);
    });
    it("searches dealer, city and holder, case-insensitively", () => {
        expect(ids(filterNeedsAttention(rows, { q: "kanpur" }))).toEqual(["a"]);
        expect(ids(filterNeedsAttention(rows, { q: "SONU" }))).toEqual(["a"]);
    });
    it("filters by role, status, interest and minimum idle days", () => {
        expect(ids(filterNeedsAttention(rows, { role: "field" }))).toEqual(["a"]);
        expect(ids(filterNeedsAttention(rows, { role: "inside" }))).toEqual(["b", "c"]);
        expect(ids(filterNeedsAttention(rows, { status: "Commercials_Explained" }))).toEqual(["c"]);
        expect(ids(filterNeedsAttention(rows, { interest: "HOT" }))).toEqual(["b"]);
        expect(ids(filterNeedsAttention(rows, { minDays: 14 }))).toEqual(["a", "c"]);
    });
    it("reads the same keys from a URL", () => {
        expect(needsAttentionFiltersFrom(new URLSearchParams("q=x&role=field&min_days=14"))).toEqual({
            q: "x",
            role: "field",
            status: null,
            interest: null,
            minDays: 14,
        });
    });
});

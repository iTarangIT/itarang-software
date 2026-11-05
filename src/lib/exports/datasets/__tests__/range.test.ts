// ID 224 point 1 — every file states its real dates.
import { describe, expect, it } from "vitest";

import { defaultDates, effectiveRange, istToday, rangeFileTag, spanLabel } from "@/lib/exports/datasets/range";

const loans = { id: "customer_loan_files", dateFields: [{ value: "submitted", label: "Sent for review" }] };
const leads = { id: "leads", dateFields: [{ value: "created", label: "Lead created" }], allWhenNoDates: true };
const accounts = { id: "dealer_accounts", dateFields: [] };
const targets = { id: "targets", dateFields: [] };
const today = "2026-11-03";

describe("effectiveRange", () => {
    it("no dates: this month to today, said so", () => {
        const r = effectiveRange(loans, {}, today);
        expect(r).toMatchObject({ mode: "month", from: "2026-11-01", to: "2026-11-03" });
        expect(r.text).toBe("1 Nov – 3 Nov 2026: this month, no dates picked (by sent for review)");
    });

    it("From only runs to today", () => {
        const r = effectiveRange(loans, { from: "2026-04-01" }, today);
        expect(r).toMatchObject({ mode: "picked", from: "2026-04-01", to: "2026-11-03" });
        expect(r.text).toContain("1 Apr – 3 Nov 2026");
    });

    it("both dates are taken as picked; across years shows both years", () => {
        expect(effectiveRange(loans, { from: "2025-12-15", to: "2026-01-10" }, today).text).toBe(
            "15 Dec 2025 – 10 Jan 2026 (by sent for review)",
        );
    });

    it("datasets that default to every row say all dates", () => {
        expect(effectiveRange(leads, {}, today)).toMatchObject({ mode: "all", text: "All dates: no dates picked (by lead created)" });
    });

    it("undated datasets say so; Targets names its month", () => {
        expect(effectiveRange(accounts, {}, today).text).toMatch(/Not date-ranged/);
        expect(effectiveRange(targets, {}, today).text).toBe("Nov 2026 (this month; no month picked)");
        expect(effectiveRange(targets, { month: "2026-10" }, today).text).toBe("Oct 2026");
    });

    it("ignores malformed dates", () => {
        expect(effectiveRange(loans, { from: "3/11/2026" }, today).mode).toBe("month");
    });
});

describe("defaultDates", () => {
    it("pre-fills this month for month datasets only", () => {
        expect(defaultDates(loans, today)).toEqual({ from: "2026-11-01", to: "2026-11-03" });
        expect(defaultDates(leads, today)).toBeNull();
        expect(defaultDates(accounts, today)).toBeNull();
    });
});

describe("helpers", () => {
    it("istToday rolls over at IST midnight, not UTC", () => {
        expect(istToday(new Date("2026-11-03T18:29:00Z"))).toBe("2026-11-03");
        expect(istToday(new Date("2026-11-03T18:31:00Z"))).toBe("2026-11-04");
    });
    it("spanLabel and rangeFileTag", () => {
        expect(spanLabel("2026-11-01", "2026-11-05")).toBe("1 Nov – 5 Nov 2026");
        expect(rangeFileTag(effectiveRange(loans, {}, today))).toBe("2026-11-01_to_2026-11-03");
        expect(rangeFileTag(effectiveRange(leads, {}, today))).toBe("all-dates");
        expect(rangeFileTag(effectiveRange(accounts, {}, today))).toBe("");
    });
});

import { describe, expect, it } from "vitest";

import { paymentsStale, paymentsStaleText, type InvoiceFreshness } from "../invoiceFreshnessRules";

const f = (payments_as_of: string | null): InvoiceFreshness => ({
    read_up_to: null,
    last_read_at: null,
    working_days_since_read: null,
    stale_after: 3,
    stale: false,
    payments_as_of,
});
const now = new Date("2026-11-11T06:00:00Z");

describe("Vyapar payments out of date (ID 200 g)", () => {
    it("is red when no Sale Report was ever imported", () => {
        expect(paymentsStale(f(null), now)).toBe(true);
        expect(paymentsStaleText(f(null), now)).toMatch(/No Vyapar Sale Report uploaded yet/);
    });

    it("is fine up to 8 days after the export", () => {
        expect(paymentsStale(f("2026-11-03T06:00:00Z"), now)).toBe(false);
        expect(paymentsStaleText(f("2026-11-03T06:00:00Z"), now)).toBeNull();
    });

    it("is red after 8 days", () => {
        expect(paymentsStale(f("2026-11-02T05:00:00Z"), now)).toBe(true);
        expect(paymentsStaleText(f("2026-11-02T05:00:00Z"), now)).toBe("No Vyapar Sale Report for 9 days: payments may be out of date.");
    });

    it("stays quiet while loading", () => {
        expect(paymentsStale(undefined, now)).toBe(false);
    });
});

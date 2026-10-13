import { describe, expect, it } from "vitest";

import { isStale, readUpToText, staleAlertText, type InvoiceFreshness } from "../invoiceFreshnessRules";

const f = (over: Partial<InvoiceFreshness> = {}): InvoiceFreshness => ({
    read_up_to: "2026-10-09",
    last_read_at: "2026-10-09T05:00:00.000Z",
    working_days_since_read: 1,
    stale_after: 3,
    stale: false,
    ...over,
});

describe("invoice freshness (ID 171)", () => {
    it("stale from the limit's working day on (3 by default), never before", () => {
        expect(isStale(2, 3)).toBe(false);
        expect(isStale(3, 3)).toBe(true);
        expect(isStale(null, 3)).toBe(true);
    });

    it("the caption names the latest invoice date, and the gap when stale", () => {
        expect(readUpToText(f())).toBe("Invoices read up to 9 Oct 2026");
        expect(readUpToText(f({ stale: true, working_days_since_read: 4 }))).toBe(
            "Invoices read up to 9 Oct 2026 · no new invoice for 4 working days",
        );
        expect(readUpToText(f({ read_up_to: null }))).toBe("No invoices read yet");
    });

    it("an alert line only when stale", () => {
        expect(staleAlertText(f())).toBeNull();
        expect(staleAlertText(f({ stale: true, working_days_since_read: 3 }))).toMatch(/^No new invoice read for 3 working days \(last read 9 Oct 2026/);
    });
});

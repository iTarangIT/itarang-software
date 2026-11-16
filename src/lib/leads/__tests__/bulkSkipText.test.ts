import { describe, expect, it } from "vitest";
import { bulkSkipWarning } from "../bulkSkipText";

describe("bulkSkipWarning (ID 233)", () => {
    it("is null when nothing was skipped", () => {
        expect(bulkSkipWarning({ affected: 3, skipped: 0 })).toBeNull();
    });
    it("names every reason with its count", () => {
        expect(
            bulkSkipWarning({ affected: 1, skipped: 3, skip_reasons: { "Already Lost": 2, "Changed by someone else meanwhile": 1 } }),
        ).toBe("3 skipped — Already Lost: 2 · Changed by someone else meanwhile: 1");
    });
    it("falls back to the older counters and an Other line", () => {
        expect(bulkSkipWarning({ affected: 0, skipped: 3, skipped_visit_booked: 2 })).toBe(
            "3 skipped — Kept with the ASM, a visit is booked (cancel or complete it first): 2 · Other: 1",
        );
    });
});

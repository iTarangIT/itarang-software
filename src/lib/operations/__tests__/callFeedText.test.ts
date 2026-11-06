import { describe, expect, it } from "vitest";
import { istWhen, workingGapText } from "../callFeedText";

describe("ID 229: call feed text", () => {
    it("prints working time as hours and minutes", () => {
        expect(workingGapText(125)).toBe("2 h 5 m");
        expect(workingGapText(40)).toBe("40 m");
        expect(workingGapText(null)).toBe("—");
    });
    it("prints IST time, or never", () => {
        expect(istWhen(null)).toBe("never");
        expect(istWhen("2026-11-05T09:02:00Z")).toMatch(/5 Nov/);
    });
});

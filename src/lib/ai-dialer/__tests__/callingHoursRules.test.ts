import { describe, expect, it } from "vitest";

import {
    CALLING_HOURS_REASON_MESSAGE,
    callingHoursChanged,
    callingHoursReasonError,
    callingHoursText,
} from "../callingHoursRules";

describe("calling hours rules (ID 85, 30 Oct)", () => {
    it("a reason of under 3 characters is refused", () => {
        expect(callingHoursReasonError("")).toBe(CALLING_HOURS_REASON_MESSAGE);
        expect(callingHoursReasonError("  ok ")).toBe(CALLING_HOURS_REASON_MESSAGE);
        expect(callingHoursReasonError(null)).toBe(CALLING_HOURS_REASON_MESSAGE);
        expect(callingHoursReasonError("Dealers answer after 11")).toBeNull();
    });

    it("a change of hours counts; the same hours do not", () => {
        const before = { start: "10:00", end: "19:00", days: ["mon", "tue"] };
        expect(callingHoursChanged(before, { start: "11:00", end: "19:00", days: null })).toBe(true);
        expect(callingHoursChanged(before, { start: "10:00", end: "19:00", days: null })).toBe(false);
        expect(callingHoursChanged(null, { start: "10:00", end: "19:00", days: null })).toBe(true);
    });

    it("days count only when the change carries them, in any order", () => {
        const before = { start: "10:00", end: "19:00", days: ["mon", "tue"] };
        expect(callingHoursChanged(before, { start: "10:00", end: "19:00", days: ["tue", "mon"] })).toBe(false);
        expect(callingHoursChanged(before, { start: "10:00", end: "19:00", days: ["mon", "tue", "sat"] })).toBe(true);
    });

    it("reads as text for the log", () => {
        expect(callingHoursText({ start: "10:00", end: "19:00", days: null })).toBe("10:00–19:00");
        expect(callingHoursText({ start: "10:00", end: "19:00", days: ["mon", "sat"] })).toBe("10:00–19:00 · Mon, Sat");
        expect(callingHoursText(null)).toBe("—");
    });
});

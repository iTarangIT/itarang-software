import { describe, expect, it } from "vitest";

import { istMinute, limitPassedLabel, ownerInferredLabel } from "../eventClockFlags";

// ID 35 — lead clock / owner clock cells on the Lead events download.
describe("istMinute", () => {
    it("trims seconds and fractions", () => {
        expect(istMinute("2026-10-01 14:05:09.123456")).toBe("2026-10-01 14:05");
        expect(istMinute("2026-10-01T09:00:00")).toBe("2026-10-01 09:00");
    });
    it("blank stays blank", () => {
        expect(istMinute(null)).toBeNull();
        expect(istMinute("")).toBeNull();
    });
});

describe("limitPassedLabel", () => {
    it("is blank when no clock was running at the event", () => {
        expect(limitPassedLabel(null, null)).toBeNull();
        expect(limitPassedLabel(undefined, "2026-10-01 14:05:00")).toBeNull();
    });
    it("says No while the limit has not passed by the event", () => {
        expect(limitPassedLabel("2026-10-01 10:00:00", null)).toBe("No");
    });
    it("says Yes with when once it has", () => {
        expect(limitPassedLabel("2026-10-01 10:00:00", "2026-10-02 10:00:00.5")).toBe("Yes, 2026-10-02 10:00");
    });
});

describe("ownerInferredLabel", () => {
    it("is blank with no owner clock", () => {
        expect(ownerInferredLabel(null, true)).toBeNull();
    });
    it("reads booleans and pg text booleans", () => {
        expect(ownerInferredLabel("2026-10-01 10:00:00", true)).toBe("Yes");
        expect(ownerInferredLabel("2026-10-01 10:00:00", "t")).toBe("Yes");
        expect(ownerInferredLabel("2026-10-01 10:00:00", false)).toBe("No");
        expect(ownerInferredLabel("2026-10-01 10:00:00", null)).toBe("No");
    });
});

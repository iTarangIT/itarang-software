import { describe, expect, it } from "vitest";
import { collectedRupees } from "../settleCollectedPayment";

describe("ID 204: collectedRupees", () => {
    it("reads Razorpay paise as rupees", () => {
        expect(collectedRupees(250000, "paise")).toBe(2500);
        expect(collectedRupees("99", "paise")).toBe(0.99);
    });
    it("rounds rupees to the paisa", () => {
        expect(collectedRupees(1234.567, "rupees")).toBe(1234.57);
    });
    it("gives null for nothing usable, so the target EMI settles in full", () => {
        expect(collectedRupees(null, "paise")).toBeNull();
        expect(collectedRupees(0, "rupees")).toBeNull();
        expect(collectedRupees("abc", "paise")).toBeNull();
    });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/decentro", () => ({}));
vi.mock("@/lib/sms", () => ({}));
const { coBorrowerDigilockerRefused, coBorrowerDigilockerFailedKey } = await import("../coborrower-verification");

describe("co-borrower DigiLocker refused / failed (ID 201)", () => {
    it("is refused when the callback stored a denial and no consent", () => {
        expect(coBorrowerDigilockerRefused({ consent_status: "denied", consent_given_at: null })).toBe(true);
    });

    it("is not refused after consent, or while waiting", () => {
        expect(coBorrowerDigilockerRefused({ consent_status: "given", consent_given_at: "2026-11-03T05:00:00Z" })).toBe(false);
        expect(coBorrowerDigilockerRefused({})).toBe(false);
    });

    it("keys the history line by verification row and session start", () => {
        expect(coBorrowerDigilockerFailedKey("v1", "2026-11-03T05:00:00Z")).toBe("digilocker:v1:failed:2026-11-03T05:00:00Z");
        expect(coBorrowerDigilockerFailedKey("v1", null)).toBe("digilocker:v1:failed:");
    });
});

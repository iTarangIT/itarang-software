import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/decentro", () => ({}));
vi.mock("@/lib/sms", () => ({}));
const { coBorrowerDigilockerExpired, COBORROWER_DIGILOCKER_VALID_HOURS } = await import("../coborrower-verification");

describe("coBorrowerDigilockerExpired (ID 201 gap 3)", () => {
    const now = new Date("2026-10-30T12:00:00.000Z");
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString();

    it("a session past the link's validity has expired", () => {
        expect(COBORROWER_DIGILOCKER_VALID_HOURS).toBe(24);
        expect(coBorrowerDigilockerExpired(hoursAgo(25), now)).toBe(true);
    });
    it("a session inside it has not", () => {
        expect(coBorrowerDigilockerExpired(hoursAgo(23), now)).toBe(false);
    });
    it("a session with no recorded start never expires (rows before 30 Oct)", () => {
        expect(coBorrowerDigilockerExpired(undefined, now)).toBe(false);
        expect(coBorrowerDigilockerExpired(null, now)).toBe(false);
        expect(coBorrowerDigilockerExpired("not a date", now)).toBe(false);
    });
});

import { describe, expect, it } from "vitest";

import { decideAccountGate, gateRedirect } from "@/lib/auth/accountGate";

// A39 — leavers locked out, forced resets for every role, 90-day expiry.

const now = new Date("2026-10-16T10:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

describe("account gate (A39)", () => {
    it("a deactivated user is out, whatever else is true", () => {
        expect(decideAccountGate({ isActive: false, mustChangePassword: true, passwordChangedAt: daysAgo(1), now })).toBe("inactive");
    });

    it("a forced reset applies to every role", () => {
        expect(decideAccountGate({ isActive: true, mustChangePassword: true, passwordChangedAt: null, now })).toBe("must_change");
    });

    it("a password older than 90 days must be changed; 90 days exactly is fine", () => {
        expect(decideAccountGate({ isActive: true, mustChangePassword: false, passwordChangedAt: daysAgo(91), now })).toBe("expired");
        expect(decideAccountGate({ isActive: true, mustChangePassword: false, passwordChangedAt: daysAgo(90), now })).toBeNull();
    });

    it("no recorded change date = no expiry yet; null is_active (no users row) is not a deactivation", () => {
        expect(decideAccountGate({ isActive: true, mustChangePassword: false, passwordChangedAt: null, now })).toBeNull();
        expect(decideAccountGate({ isActive: null, mustChangePassword: false, passwordChangedAt: null, now })).toBeNull();
    });

    it("sends each case to the right page", () => {
        expect(gateRedirect("inactive")).toBe("/login?inactive=1");
        expect(gateRedirect("must_change")).toBe("/change-password");
        expect(gateRedirect("expired")).toBe("/change-password?expired=1");
    });
});

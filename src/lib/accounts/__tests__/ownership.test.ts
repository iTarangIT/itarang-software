import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { istDayStart, isoIstDay, windowOn } from "@/lib/accounts/ownership";
import { candidatePhones } from "@/lib/onboarding/linkToLead";

const w = (owner: string, from: string, to: string | null) => ({
    owner,
    effective_from: istDayStart(from),
    effective_to: to ? istDayStart(to) : null,
});

describe("owner on the invoice date (ID 68)", () => {
    const history = [w("A", "2026-01-01", "2026-06-01"), w("B", "2026-06-01", null)];

    it("credits the owner whose window holds the day", () => {
        expect(windowOn(history, "2026-03-15")?.owner).toBe("A");
        expect(windowOn(history, "2026-07-01")?.owner).toBe("B");
    });

    it("hands over cleanly on the change day (half-open window)", () => {
        expect(windowOn(history, "2026-05-31")?.owner).toBe("A");
        expect(windowOn(history, "2026-06-01")?.owner).toBe("B");
    });

    it("reassigning never moves past revenue: an older day keeps its owner", () => {
        const after = [
            w("A", "2026-01-01", "2026-06-01"),
            w("B", "2026-06-01", "2026-09-01"),
            w("C", "2026-09-01", null),
        ];
        expect(windowOn(after, "2026-03-15")?.owner).toBe("A");
        expect(windowOn(after, "2026-07-01")?.owner).toBe("B");
    });

    it("no owner before the first window", () => {
        expect(windowOn(history, "2025-12-31")).toBeNull();
    });
});

describe("IST day helpers", () => {
    it("istDayStart is IST midnight", () => {
        expect(istDayStart("2026-10-03").toISOString()).toBe("2026-10-02T18:30:00.000Z");
    });
    it("isoIstDay rolls UTC evening into the next IST day", () => {
        expect(isoIstDay(new Date("2026-10-02T19:00:00Z"))).toBe("2026-10-03");
    });
    it("rejects a malformed date", () => {
        expect(() => istDayStart("03-10-2026")).toThrow();
    });
});

describe("onboarding → lead phones (ID 67)", () => {
    it("tries owner, WhatsApp, contact — in order, de-duplicated by last 10 digits", () => {
        expect(
            candidatePhones({
                owner_phone: "+91 98765 43210",
                wa_phone: "919876543210",
                contact_phone: "9123456789",
            }).map((c) => c.via),
        ).toEqual(["owner_phone", "contact_phone"]);
    });
    it("skips masked and short numbers", () => {
        expect(candidatePhones({ owner_phone: "98XXXXXX10", wa_phone: "12345", contact_phone: null })).toEqual([]);
    });
});

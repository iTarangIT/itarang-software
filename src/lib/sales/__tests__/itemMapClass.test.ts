import { describe, expect, it, vi } from "vitest";

// A14 — Batteries sold: a line read with no HSN takes its class from Item
// mapping (as gross margin already did); an HSN still decides when present.
vi.mock("@/lib/db", () => ({ db: {} }));
const { classFor } = await import("@/lib/sales/itemMap");
const { classifyHsn } = await import("@/lib/sales/invoiceLines");

const map = (asset_type: string | null) => ({ asset_type, product_id: asset_type ? "p1" : null });

describe("invoice line class (A14)", () => {
    it("HSN decides when present: 8507 battery, 850790 (LCD box) other, 850440 charger", () => {
        expect(classFor(map(null), classifyHsn("85076000"), "85076000")).toBe("battery");
        expect(classFor(map("battery"), classifyHsn("85079090"), "85079090")).toBe("other");
        expect(classFor(map(null), classifyHsn("85044030"), "85044030")).toBe("charger");
    });

    it("no HSN: a line mapped to a battery counts as a battery, to a charger as a charger", () => {
        expect(classFor(map("battery"), classifyHsn(null), null)).toBe("battery");
        expect(classFor(map("charger"), classifyHsn(""), "")).toBe("charger");
        expect(classFor(map("paraphernalia"), classifyHsn(null), null)).toBe("other");
    });

    it("no HSN and not mapped: stays as read", () => {
        expect(classFor(map(null), "other", null)).toBe("other");
    });

    it("an onboarding fee is never a battery", () => {
        expect(classFor(map("onboarding_fee"), "battery", "85076000")).toBe("other");
        expect(classFor(map("onboarding_fee"), "other", null)).toBe("other");
    });

    it("callers that pass no HSN keep the old behaviour", () => {
        expect(classFor(map("battery"), "battery")).toBe("battery");
    });
});

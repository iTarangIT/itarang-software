// ID 234: the Leads list's Hide box also hides Lost leads; Status = Lost wins; a mobile-number
// search (ID 46) is never narrowed by it.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { execute: vi.fn(async () => []) } }));
const { hidesLost } = await import("../leadListQuery");

describe("hidesLost (234)", () => {
    it("hides Lost by default", () => {
        expect(hidesLost({} as never)).toBe(true);
        expect(hidesLost({ hideDead: true } as never)).toBe(true);
    });
    it("Status = Lost, an unticked box, or 'include' shows them", () => {
        expect(hidesLost({ status: "Lost" } as never)).toBe(false);
        expect(hidesLost({ hideDead: false } as never)).toBe(false);
        expect(hidesLost({ contactability: "include" } as never)).toBe(false);
    });
    it("a search by mobile numbers finds the lead whatever its status", () => {
        expect(hidesLost({ search: "9876543210, 9123456789" } as never)).toBe(false);
        expect(hidesLost({ search: "Gupta" } as never)).toBe(true);
    });
});

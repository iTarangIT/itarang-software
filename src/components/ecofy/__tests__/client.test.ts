import { describe, expect, it } from "vitest";
import { localToIso } from "../client";

describe("localToIso — DateTimeField value (IST) → ISO instant", () => {
    it("treats the typed value as IST regardless of the machine's zone", () => {
        expect(localToIso("2026-09-29T10:00")).toBe("2026-09-29T04:30:00.000Z");
        expect(localToIso("2026-01-01T00:15")).toBe("2025-12-31T18:45:00.000Z");
    });

    it("returns undefined for empty or half-filled values", () => {
        expect(localToIso("")).toBeUndefined();
        expect(localToIso("2026-09-29")).toBeUndefined();
        expect(localToIso("2026-09-29T")).toBeUndefined();
        expect(localToIso("garbage")).toBeUndefined();
    });
});

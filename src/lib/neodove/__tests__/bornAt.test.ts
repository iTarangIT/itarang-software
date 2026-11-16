import { describe, expect, it } from "vitest";
import { neodoveBornAt } from "../bornAt";

const now = new Date("2026-11-16T10:00:00Z");

describe("ID 224 neodoveBornAt", () => {
    it("dates the lead at the call, an hour before the event arrived", () => {
        const call = new Date("2026-11-16T09:00:00Z");
        expect(neodoveBornAt(call, now)).toEqual(call);
    });
    it("falls back to now for a missing, future or very old time", () => {
        expect(neodoveBornAt(null, now)).toEqual(now);
        expect(neodoveBornAt(new Date("2026-11-16T11:00:00Z"), now)).toEqual(now);
        expect(neodoveBornAt(new Date("2026-10-01T00:00:00Z"), now)).toEqual(now);
        expect(neodoveBornAt(new Date("bad"), now)).toEqual(now);
    });
});

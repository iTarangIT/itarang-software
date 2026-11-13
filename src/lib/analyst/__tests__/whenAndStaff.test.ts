import { describe, expect, it } from "vitest";

import { staffNameMatches, staffNamePatterns } from "../staffMatch";
import { formatWhen, formatWhenShort } from "../when";

describe("formatWhen (IST, 13 Nov)", () => {
    it("shows the IST date and time, whatever the machine's zone", () => {
        // 10:52 UTC is 4:22 pm IST.
        const s = formatWhen("2026-11-13T10:52:00Z");
        expect(s).toMatch(/13 Nov 2026/);
        expect(s).toMatch(/4:22\s?pm/i);
    });

    it("an IST midnight crossing lands on the IST day", () => {
        // 19:00 UTC on the 12th is 00:30 IST on the 13th.
        expect(formatWhen("2026-11-12T19:00:00Z")).toMatch(/13 Nov 2026/);
    });

    it("takes epoch milliseconds (a live turn's startedAt)", () => {
        expect(formatWhen(Date.parse("2026-11-13T10:52:00Z"))).toMatch(/13 Nov 2026/);
    });

    it("says nothing for a missing or broken time", () => {
        expect(formatWhen(null)).toBe("");
        expect(formatWhen(undefined)).toBe("");
        expect(formatWhen("not a date")).toBe("");
    });
});

describe("formatWhenShort (the conversation list)", () => {
    const now = new Date("2026-11-13T10:52:00Z"); // 4:22 pm IST, 13 Nov

    it("today and yesterday by IST day", () => {
        expect(formatWhenShort("2026-11-13T04:00:00Z", now)).toMatch(/^Today, 9:30\s?am$/i);
        expect(formatWhenShort("2026-11-12T04:00:00Z", now)).toMatch(/^Yesterday, 9:30\s?am$/i);
    });

    it("older ones get the full date", () => {
        expect(formatWhenShort("2026-11-01T04:00:00Z", now)).toMatch(/1 Nov 2026/);
    });
});

describe("staff name matching (13 Nov)", () => {
    it("every word must match, partially, ignoring case", () => {
        expect(staffNamePatterns("Biplabh Ghosh")).toEqual(["%Biplabh%", "%Ghosh%"]);
        expect(staffNameMatches("Biplabh Ghosh", "biplabh")).toBe(true);
        expect(staffNameMatches("Biplabh Ghosh", "Biplab Ghosh")).toBe(true);
        expect(staffNameMatches("Biplabh Ghosh", "Biplab Gosh")).toBe(false);
        expect(staffNameMatches("Biplabh Ghosh", "Biplabh Ghosh xyz")).toBe(false);
    });

    it("a name with no usable words matches no one (never everyone)", () => {
        expect(staffNamePatterns("  % _ ")).toEqual([]);
        expect(staffNameMatches("Biplabh Ghosh", "%")).toBe(false);
    });
});

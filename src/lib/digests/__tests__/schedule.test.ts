/**
 * E-287/E-288 — digest scheduling and settings normalisation.
 *
 * Pure, no I/O, which is the whole reason `slotsDueAt` takes `now` as an argument
 * instead of calling `Date.now()`. The interesting cases are all IST-vs-UTC: the
 * boxes run UTC, the schedule is stated in IST, and the 5h30m gap is where a
 * "9 AM digest" silently becomes a 2:30 PM one.
 */

import { describe, expect, it } from "vitest";

import {
    allSectionsOn,
    defaultSettings,
    digestDateForSlot,
    formatSlotTime,
    normalizeDetailLevel,
    normalizeRecipients,
    normalizeSections,
    normalizeSettings,
    slotsDueAt,
} from "../schedule";
import type { DigestSection } from "../types";

/** A stand-in descriptor's sections — deliberately not a real kind's. */
const SECTIONS: DigestSection[] = [
    { key: "a", label: "A", hint: "", group: "activity" },
    { key: "b", label: "B", hint: "", group: "activity" },
    { key: "backlog", label: "Backlog", hint: "", group: "backlog" },
];

/** A UTC instant for a given IST wall-clock time. IST is a fixed +5:30, no DST. */
function atIst(istDay: string, hour: number, minute: number): Date {
    const utcMinutes = hour * 60 + minute - (5 * 60 + 30);
    const base = new Date(`${istDay}T00:00:00Z`);
    return new Date(base.getTime() + utcMinutes * 60_000);
}

const ON = defaultSettings(SECTIONS);

describe("slotsDueAt", () => {
    it("owes nothing before the morning time", () => {
        expect(slotsDueAt(atIst("2026-09-07", 8, 59), ON)).toEqual([]);
    });

    it("owes the morning slot from 09:00 IST, covering yesterday", () => {
        expect(slotsDueAt(atIst("2026-09-07", 9, 1), ON)).toEqual([
            { slot: "morning", digestDate: "2026-09-06" },
        ]);
    });

    it("fires exactly on the configured minute", () => {
        expect(slotsDueAt(atIst("2026-09-07", 9, 0), ON).map((d) => d.slot)).toEqual([
            "morning",
        ]);
    });

    it("still owes the morning slot at 11:30 — a restart must not skip a day", () => {
        // This is the case the whole windowed design exists for: a PM2 box that
        // was restarting at 09:00. The claim in the database is what stops the
        // 09:05, 09:10 … ticks resending it, not the narrowness of this window.
        expect(slotsDueAt(atIst("2026-09-07", 11, 30), ON)).toEqual([
            { slot: "morning", digestDate: "2026-09-06" },
        ]);
    });

    it("owes both slots after 19:00 IST, each covering its own day", () => {
        expect(slotsDueAt(atIst("2026-09-07", 19, 5), ON)).toEqual([
            { slot: "morning", digestDate: "2026-09-06" },
            { slot: "evening", digestDate: "2026-09-07" },
        ]);
    });

    it("does not owe the evening slot at 18:59", () => {
        expect(slotsDueAt(atIst("2026-09-07", 18, 59), ON).map((d) => d.slot)).toEqual([
            "morning",
        ]);
    });

    it("owes nothing just after IST midnight — the UTC day is still yesterday", () => {
        // 00:30 IST on the 7th is 19:00 UTC on the 6th. A scheduler that read the
        // UTC clock would think it was mid-evening and fire both slots.
        expect(slotsDueAt(atIst("2026-09-07", 0, 30), ON)).toEqual([]);
    });

    it("owes nothing at 02:00 IST", () => {
        expect(slotsDueAt(atIst("2026-09-07", 2, 0), ON)).toEqual([]);
    });

    it("owes nothing at all while disabled", () => {
        expect(slotsDueAt(atIst("2026-09-07", 20, 0), { ...ON, enabled: false })).toEqual([]);
    });

    it("honours custom times", () => {
        const custom = { ...ON, morningHour: 7, morningMinute: 45 };
        expect(slotsDueAt(atIst("2026-09-07", 7, 44), custom)).toEqual([]);
        expect(slotsDueAt(atIst("2026-09-07", 7, 45), custom).map((d) => d.slot)).toEqual([
            "morning",
        ]);
    });

    it("crosses a month boundary correctly", () => {
        expect(slotsDueAt(atIst("2026-10-01", 9, 30), ON)).toEqual([
            { slot: "morning", digestDate: "2026-09-30" },
        ]);
    });
});

describe("digestDateForSlot", () => {
    it("maps morning to yesterday and evening to today, in IST", () => {
        const now = atIst("2026-09-07", 20, 0);
        expect(digestDateForSlot("morning", now)).toBe("2026-09-06");
        expect(digestDateForSlot("evening", now)).toBe("2026-09-07");
    });

    it("uses the IST day even when UTC is still on the previous date", () => {
        // 01:00 IST on the 7th == 19:30 UTC on the 6th.
        const now = atIst("2026-09-07", 1, 0);
        expect(digestDateForSlot("evening", now)).toBe("2026-09-07");
        expect(digestDateForSlot("morning", now)).toBe("2026-09-06");
    });
});

describe("normalizeRecipients", () => {
    const base = ["care.itarang@gmail.com"];

    it("keeps the base list when the patch is absent", () => {
        expect(normalizeRecipients(undefined, base)).toEqual(base);
    });

    it("lowercases, trims and dedupes", () => {
        expect(
            normalizeRecipients(["  Care.iTarang@Gmail.com ", "care.itarang@gmail.com"], base),
        ).toEqual(["care.itarang@gmail.com"]);
    });

    it("drops entries that are not plausible addresses", () => {
        expect(normalizeRecipients(["ok@example.com", "nope", "", 42, null], base)).toEqual([
            "ok@example.com",
        ]);
    });

    it("falls back to the base list rather than storing an empty one", () => {
        // A digest with no recipients still claims its slot and counts everything,
        // then mails nobody — indistinguishable on the ledger from a real send.
        expect(normalizeRecipients([], base)).toEqual(base);
        expect(normalizeRecipients(["not-an-email"], base)).toEqual(base);
    });

    it("caps the list", () => {
        const many = Array.from({ length: 25 }, (_, i) => `a${i}@example.com`);
        expect(normalizeRecipients(many, base)).toHaveLength(10);
    });
});

describe("sections", () => {
    it("defaults every declared section on", () => {
        expect(allSectionsOn(SECTIONS)).toEqual({ a: true, b: true, backlog: true });
    });

    it("merges a partial patch over the current set", () => {
        const next = normalizeSections({ b: false }, ON.sections, SECTIONS);
        expect(next).toEqual({ a: true, b: false, backlog: true });
    });

    it("refuses an all-off set", () => {
        // A mail with no blocks still claims its slot and still reads as a
        // successful send on the ledger — an empty mail, not a short one.
        const allOff = { a: false, b: false, backlog: false };
        expect(normalizeSections(allOff, ON.sections, SECTIONS)).toEqual(ON.sections);
    });

    it("allows exactly one section on", () => {
        const one = normalizeSections({ a: true, b: false, backlog: false }, ON.sections, SECTIONS);
        expect(one).toEqual({ a: true, b: false, backlog: false });
    });

    it("discards keys this kind does not declare", () => {
        // A stored section for a row that no longer exists would be a setting with
        // no effect — and worse, would keep an all-off set looking non-empty.
        const next = normalizeSections({ ghost: true, a: false }, ON.sections, SECTIONS);
        expect("ghost" in next).toBe(false);
        expect(next).toEqual({ a: false, b: true, backlog: true });
    });

    it("defaults a section the stored blob never heard of to on", () => {
        // A descriptor that gains a section must not have it silently hidden for
        // everyone who saved settings before it existed.
        const older = { a: true, b: true };
        const next = normalizeSections(undefined, older, SECTIONS);
        expect(next.backlog).toBe(true);
    });
});

describe("normalizeSettings", () => {
    it("returns the defaults for an absent row", () => {
        expect(normalizeSettings(undefined, SECTIONS)).toEqual(ON);
    });

    it("defaults to ON, addressed to care.itarang@gmail.com, plainest format", () => {
        const s = normalizeSettings(null, SECTIONS);
        expect(s.enabled).toBe(true);
        expect(s.recipients).toEqual(["care.itarang@gmail.com"]);
        expect(s.morningHour).toBe(9);
        expect(s.eveningHour).toBe(19);
        expect(s.detail).toBe("summary");
        expect(s.attachExcel).toBe(false);
    });

    it("merges a partial patch over the current value", () => {
        const current = { ...ON, morningHour: 7, recipients: ["a@example.com"] };
        const next = normalizeSettings({ enabled: false }, SECTIONS, current);
        expect(next.enabled).toBe(false);
        expect(next.morningHour).toBe(7);
        expect(next.recipients).toEqual(["a@example.com"]);
    });

    it("clamps out-of-range hours and minutes", () => {
        const s = normalizeSettings(
            { morningHour: 99, morningMinute: -5, eveningHour: -1, eveningMinute: 120 },
            SECTIONS,
        );
        expect(s.morningHour).toBe(23);
        expect(s.morningMinute).toBe(0);
        expect(s.eveningHour).toBe(0);
        expect(s.eveningMinute).toBe(59);
    });

    it("ignores unparseable values rather than storing NaN", () => {
        expect(normalizeSettings({ morningHour: "half nine" }, SECTIONS).morningHour).toBe(9);
    });

    it("survives a garbage jsonb blob", () => {
        expect(normalizeSettings("not an object", SECTIONS)).toEqual(ON);
        expect(normalizeSettings(42, SECTIONS)).toEqual(ON);
    });

    it("carries the format fields through", () => {
        const s = normalizeSettings(
            { detail: "detailed", attachExcel: true, sections: { backlog: false } },
            SECTIONS,
        );
        expect(s.detail).toBe("detailed");
        expect(s.attachExcel).toBe(true);
        expect(s.sections.backlog).toBe(false);
        expect(s.sections.a).toBe(true);
    });
});

describe("normalizeDetailLevel", () => {
    it("keeps an unknown level out of the stored settings", () => {
        expect(normalizeDetailLevel("verbose", "summary")).toBe("summary");
        expect(normalizeDetailLevel(null, "detailed")).toBe("detailed");
        expect(normalizeDetailLevel("detailed", "summary")).toBe("detailed");
    });
});

describe("formatSlotTime", () => {
    it("zero-pads to HH:MM", () => {
        expect(formatSlotTime(9, 0)).toBe("09:00");
        expect(formatSlotTime(19, 5)).toBe("19:05");
        expect(formatSlotTime(0, 0)).toBe("00:00");
    });
});

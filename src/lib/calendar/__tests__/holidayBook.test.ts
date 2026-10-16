import { describe, expect, it } from "vitest";

import { buildHolidayBook } from "@/lib/calendar/holidayBook";

const at = (iso: string) => new Date(iso);

describe("holidays as they stood at a moment (ID 85 item 7)", () => {
    it("holidays from before the log count always", () => {
        const book = buildHolidayBook([{ date: "2026-01-26", active: true }], []);
        expect(book(at("2020-01-01T00:00:00Z")).has("2026-01-26")).toBe(true);
    });

    it("a holiday added later counts only from the moment it was added", () => {
        const book = buildHolidayBook(
            [{ date: "2026-10-17", active: true }],
            [{ date: "2026-10-17", action: "add", at: at("2026-10-20T04:30:00Z") }],
        );
        expect(book(at("2026-10-19T12:00:00Z")).has("2026-10-17")).toBe(false);
        expect(book(at("2026-10-20T04:30:00Z")).has("2026-10-17")).toBe(true);
        expect(book(at("2026-10-25T00:00:00Z")).has("2026-10-17")).toBe(true);
    });

    it("a removed holiday still counts for moments before it was removed", () => {
        const book = buildHolidayBook(
            [{ date: "2026-11-09", active: false }],
            [{ date: "2026-11-09", action: "remove", at: at("2026-11-01T00:00:00Z") }],
        );
        expect(book(at("2026-10-31T00:00:00Z")).has("2026-11-09")).toBe(true);
        expect(book(at("2026-11-02T00:00:00Z")).has("2026-11-09")).toBe(false);
    });

    it("add, remove, add again follows each step; renames change nothing", () => {
        const book = buildHolidayBook(
            [{ date: "2026-12-25", active: true }],
            [
                { date: "2026-12-25", action: "add", at: at("2026-10-01T00:00:00Z") },
                { date: "2026-12-25", action: "rename", at: at("2026-10-02T00:00:00Z") },
                { date: "2026-12-25", action: "remove", at: at("2026-10-05T00:00:00Z") },
                { date: "2026-12-25", action: "add", at: at("2026-10-10T00:00:00Z") },
            ],
        );
        expect(book(at("2026-09-30T00:00:00Z")).has("2026-12-25")).toBe(false);
        expect(book(at("2026-10-03T00:00:00Z")).has("2026-12-25")).toBe(true);
        expect(book(at("2026-10-06T00:00:00Z")).has("2026-12-25")).toBe(false);
        expect(book(at("2026-10-11T00:00:00Z")).has("2026-12-25")).toBe(true);
    });

    it("an inactive holiday with no log never counts", () => {
        const book = buildHolidayBook([{ date: "2026-08-15", active: false }], []);
        expect(book(at("2026-08-15T00:00:00Z")).has("2026-08-15")).toBe(false);
    });
});

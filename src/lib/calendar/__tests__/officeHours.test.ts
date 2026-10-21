/**
 * ID 85 #8 — office hours as a dated setting: the pure resolver, the
 * office-calendar functions with custom hours, and the store's fallback when
 * E-354 is missing.
 */
import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// The store's reads all fail on this stub — exactly the "no E-354 / no DB" case.
vi.mock("@/lib/db", () => ({ db: { execute: () => Promise.reject(new Error("no db in tests")) } }));

const {
    DEFAULT_OFFICE_HOURS,
    describeOfficeHours,
    officeHoursOn,
    officeHoursProblem,
    officeHoursResolverFrom,
    shortOfficeHours,
} = await import("../officeHours");
const { addWorkingMinutes, isWorkingDay, workingDaysDueAt, workingDaysInRange, workingDaysSince, workingMinutesBetween, workingDaysElapsed } =
    await import("../officeCalendar");
const store = await import("../officeHoursStore");

const none = new Set<string>();
const row = (effective_from: string, start: number, end: number, days: number[] | string) => ({
    effective_from,
    start_hour: start,
    end_hour: end,
    working_weekdays: days,
});
// IST wall clock → instant.
const ist = (s: string) => new Date(`${s}+05:30`);

describe("officeHoursOn — the dated setting", () => {
    it("falls back to Mon–Sat 10–19 with no rows or no table", () => {
        expect(officeHoursOn("2026-10-21", null)).toEqual(DEFAULT_OFFICE_HOURS);
        expect(officeHoursOn("2026-10-21", [])).toEqual(DEFAULT_OFFICE_HOURS);
        expect(DEFAULT_OFFICE_HOURS).toMatchObject({ startHour: 10, endHour: 19, weekdays: [1, 2, 3, 4, 5, 6] });
    });
    it("uses the latest row dated on or before the day; earlier days keep the old hours", () => {
        const rows = [row("2026-11-01", 9, 18, [1, 2, 3, 4, 5]), row("2026-12-01", 11, 20, "{1,2,3,4,5,6}")];
        expect(officeHoursOn("2026-10-31", rows)).toEqual(DEFAULT_OFFICE_HOURS);
        expect(officeHoursOn("2026-11-01", rows)).toEqual({ startHour: 9, endHour: 18, weekdays: [1, 2, 3, 4, 5] });
        expect(officeHoursOn("2026-12-15", rows)).toEqual({ startHour: 11, endHour: 20, weekdays: [1, 2, 3, 4, 5, 6] });
    });
    it("skips an unusable row", () => {
        expect(officeHoursOn("2026-11-02", [row("2026-11-01", 19, 10, [1])])).toEqual(DEFAULT_OFFICE_HOURS);
    });
    it("memoises a resolver", () => {
        const r = officeHoursResolverFrom([row("2026-11-01", 9, 18, [1, 2, 3, 4, 5])]);
        expect(r("2026-11-02").startHour).toBe(9);
        expect(r("2026-10-02").startHour).toBe(10);
    });
    it("validates and describes", () => {
        expect(officeHoursProblem({ startHour: 10, endHour: 10, weekdays: [1] })).toMatch(/after opening/);
        expect(officeHoursProblem({ startHour: 10, endHour: 19, weekdays: [] })).toMatch(/at least one/);
        expect(officeHoursProblem(DEFAULT_OFFICE_HOURS)).toBeNull();
        expect(describeOfficeHours()).toBe("Monday to Saturday, 10:00 to 19:00");
        expect(describeOfficeHours({ startHour: 9, endHour: 18, weekdays: [0, 1, 2, 3, 4, 5] })).toBe(
            "Monday to Friday and Sunday, 09:00 to 18:00",
        );
        expect(shortOfficeHours()).toBe("Mon–Sat 10:00–19:00");
    });
});

describe("office calendar with custom hours", () => {
    const monFri = { startHour: 9, endHour: 18, weekdays: [1, 2, 3, 4, 5] };

    it("defaults are unchanged for callers that pass no hours", () => {
        // Sat 2026-10-03 is a working day by default, Sunday is not.
        expect(isWorkingDay("2026-10-03", none)).toBe(true);
        expect(isWorkingDay("2026-10-04", none)).toBe(false);
        expect(workingMinutesBetween(ist("2026-10-05T09:00:00"), ist("2026-10-05T12:00:00"))).toBe(120);
    });
    it("Mon–Fri 9–18: Saturday is off, the day starts at 9", () => {
        expect(isWorkingDay("2026-10-03", none, monFri)).toBe(false);
        expect(workingMinutesBetween(ist("2026-10-05T08:00:00"), ist("2026-10-05T12:00:00"), none, monFri)).toBe(180);
        // Fri 17:00 + 2 working hours = Mon 10:00 (Saturday skipped).
        expect(addWorkingMinutes(ist("2026-10-02T17:00:00"), 120, none, monFri)?.toISOString()).toBe(ist("2026-10-05T10:00:00").toISOString());
        // Fri → Mon: Saturday no longer counts.
        expect(workingDaysSince(ist("2026-10-02T12:00:00"), ist("2026-10-05T12:00:00"), none, monFri)).toBe(1);
        expect(workingDaysSince(ist("2026-10-02T12:00:00"), ist("2026-10-05T12:00:00"), none)).toBe(2);
        expect(workingDaysInRange("2026-10-01", "2026-10-31", none, monFri)).toBe(22);
        expect(workingDaysElapsed(ist("2026-10-05T09:00:00"), ist("2026-10-05T13:30:00"), none, monFri)).toBeCloseTo(0.5, 5);
    });
    it("a per-day resolver follows a dated change inside one span", () => {
        const r = officeHoursResolverFrom([row("2026-10-05", 9, 18, [1, 2, 3, 4, 5])]);
        // Sat 3 Oct still worked (old hours), the following Saturday not.
        expect(workingDaysInRange("2026-10-03", "2026-10-10", none, r)).toBe(6);
        // Due: 1 working day after Fri 9 Oct under the new hours is Mon 12 Oct.
        expect(workingDaysDueAt(ist("2026-10-09T12:00:00"), 1, none, r)?.toISOString()).toBe(new Date("2026-10-12T18:29:59.999Z").toISOString());
    });
});

describe("officeHoursStore without E-354", () => {
    it("reads fall back to the default and never throw", async () => {
        expect(await store.getOfficeHours("2026-10-21")).toEqual(DEFAULT_OFFICE_HOURS);
        expect(await store.hasOfficeHoursTable()).toBe(false);
        expect((await store.officeHoursResolver())("2026-10-21")).toEqual(DEFAULT_OFFICE_HOURS);
        expect(await store.officeHoursLog()).toEqual([]);
    });
    it("a save says the setting is not available", async () => {
        await expect(
            store.setOfficeHours({ startHour: 9, endHour: 18, weekdays: [1, 2, 3, 4, 5], effectiveFrom: "2999-01-01", note: "test", actorId: "x" }),
        ).rejects.toBeInstanceOf(store.OfficeHoursUnavailableError);
        await expect(
            store.setOfficeHours({ startHour: 9, endHour: 18, weekdays: [1], effectiveFrom: "2000-01-01", note: "test", actorId: "x" }),
        ).rejects.toThrow(/never in the past/);
    });
    it("the weekday SQL is Mon–Sat by default and dated with rows", () => {
        const d = new PgDialect();
        const plain = d.sqlToQuery(store.__weekdayPredicateForTest(sql`gs`, null));
        expect(plain.sql).toBe("EXTRACT(DOW FROM (gs))::int IN (1, 2, 3, 4, 5, 6)");
        const dated = d.sqlToQuery(store.__weekdayPredicateForTest(sql`gs`, [row("2026-11-01", 9, 18, [1, 2, 3, 4, 5])]));
        expect(dated.sql).toContain("WHEN (gs)::date >= $1::date THEN EXTRACT(DOW FROM (gs))::int IN (1, 2, 3, 4, 5)");
        expect(dated.sql).toContain("ELSE EXTRACT(DOW FROM (gs))::int IN (1, 2, 3, 4, 5, 6) END");
        expect(dated.params).toEqual(["2026-11-01"]);
        // The lazy wrapper renders inside a query.
        const lazy = d.sqlToQuery(sql`WHERE ${store.workingWeekdaySql(sql`gs`)}`);
        expect(lazy.sql).toContain("EXTRACT(DOW FROM (gs))::int IN (1, 2, 3, 4, 5, 6)");
    });
});

import { describe, expect, it } from "vitest";
import { addDays, istToday, isVisitKind, MAX_RANGE_DAYS, resolveTeamFilters, teamFiltersFromParams } from "../teamFilters";

// 24 Nov (CRM items 5 + 7).
const scope = { ownerIds: ["me", "rep-1", "rep-2"] };
const NOW = new Date("2026-11-24T20:00:00Z"); // 25 Nov 01:30 IST

describe("Team page filters", () => {
    it("reads the query, dropping malformed dates", () => {
        const f = teamFiltersFromParams(new URLSearchParams("member=rep-1&city=%20Pune%20&from=2026-11-01&to=nope&business_type=solar"));
        expect(f).toMatchObject({ member: "rep-1", city: "Pune", businessType: "solar", from: "2026-11-01", to: null });
    });

    it("a member outside the scope is ignored (whole team), never trusted", () => {
        expect(resolveTeamFilters(scope, { member: "rep-2" }).member).toBe("rep-2");
        expect(resolveTeamFilters(scope, { member: "stranger" }).member).toBeNull();
    });

    it("team leads: no date range unless asked; a reversed range is put in order", () => {
        expect(resolveTeamFilters(scope, {})).toMatchObject({ from: null, to: null });
        expect(resolveTeamFilters(scope, { from: "2026-11-10" })).toMatchObject({ from: "2026-11-10", to: null });
        expect(resolveTeamFilters(scope, { from: "2026-11-10", to: "2026-11-01" })).toMatchObject({ from: "2026-11-01", to: "2026-11-10" });
    });

    it("visits: the range defaults to the last 30 days, IST", () => {
        expect(istToday(NOW)).toBe("2026-11-25");
        expect(resolveTeamFilters(scope, {}, { defaultRange: true, now: NOW })).toMatchObject({ from: "2026-10-26", to: "2026-11-25" });
        expect(resolveTeamFilters(scope, { from: "2026-11-01" }, { defaultRange: true, now: NOW })).toMatchObject({
            from: "2026-11-01",
            to: "2026-12-01",
        });
    });

    it("visits: a range longer than a year is cut to the last MAX_RANGE_DAYS", () => {
        const r = resolveTeamFilters(scope, { from: "2020-01-01", to: "2026-11-24" }, { defaultRange: true, now: NOW });
        expect(r.to).toBe("2026-11-24");
        expect(r.from).toBe(addDays("2026-11-24", -MAX_RANGE_DAYS));
    });

    it("knows the two visit lists", () => {
        expect(isVisitKind("scheduled")).toBe(true);
        expect(isVisitKind("completed")).toBe(true);
        expect(isVisitKind("visited")).toBe(false);
    });
});

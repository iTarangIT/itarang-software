import { describe, expect, it } from "vitest";
import {
    CHARGING_SPOT_MIN_SESSIONS,
    DWELL_RADIUS_M,
    DWELL_TRUST_GAP_S,
    GRID_DEG,
    MOVE_MIN_M,
    NIGHT_END_HOUR,
    NIGHT_START_HOUR,
    SECONDARY_OVERNIGHT_MIN_NIGHTS,
    haversineM,
    isDwell,
    isNightHour,
    isObserved,
    isTravel,
    pickChargingCluster,
    pickSecondaryOvernight,
    snapToGrid,
} from "@/lib/telemetry/geo-math";

describe("haversineM", () => {
    it("is zero for a point against itself, and never NaN", () => {
        // Load-bearing: floating-point error can push asin's argument a hair above 1 for two
        // identical points, and sqrt of that is NaN — which then poisons every sum it touches.
        // The SQL clamps with LEAST(1, ...) for exactly this reason.
        const d = haversineM(25.457, 81.829, 25.457, 81.829);
        expect(Number.isNaN(d)).toBe(false);
        expect(d).toBe(0);
    });

    it("measures a known distance", () => {
        // One degree of latitude is ~111 km anywhere on the globe.
        expect(haversineM(25.0, 81.0, 26.0, 81.0)).toBeGreaterThan(110_000);
        expect(haversineM(25.0, 81.0, 26.0, 81.0)).toBeLessThan(112_000);
    });

    it("shrinks a degree of longitude with latitude", () => {
        // A degree of longitude is ~111 km at the equator but only ~101 km at 25°N (the fleet's
        // latitude). Getting this wrong is how a naive lat/lon grid ends up non-square.
        const atEquator = haversineM(0, 81.0, 0, 82.0);
        const atFleet = haversineM(25.4, 81.0, 25.4, 82.0);
        expect(atFleet).toBeLessThan(atEquator);
        expect(atFleet / atEquator).toBeCloseTo(Math.cos((25.4 * Math.PI) / 180), 2);
    });

    it("is symmetric", () => {
        const a = haversineM(25.457, 81.829, 25.303, 81.892);
        const b = haversineM(25.303, 81.892, 25.457, 81.829);
        expect(a).toBeCloseTo(b, 6);
    });

    it("resolves the fleet's two dwell clusters as ~19 km apart", () => {
        // The reference battery's parking spot and its second base. If the maths were wrong,
        // these would collapse into one cluster or fly apart.
        const d = haversineM(25.457, 81.829, 25.303, 81.892);
        expect(d).toBeGreaterThan(15_000);
        expect(d).toBeLessThan(22_000);
    });
});

describe("dwell vs travel classification", () => {
    it("calls two fixes within the dwell radius the same place", () => {
        expect(isDwell(0)).toBe(true);
        expect(isDwell(DWELL_RADIUS_M - 1)).toBe(true);
        expect(isDwell(DWELL_RADIUS_M)).toBe(false);
        expect(isDwell(500)).toBe(false);
    });

    it("does not accrue distance from GPS jitter around a parked vehicle", () => {
        // Without this floor, a stationary vehicle earns kilometres from its own noise: a 10 m
        // wobble every 4 minutes is ~3.6 km/day of phantom travel, and it would light the heat
        // map brightest exactly where the vehicle never moved.
        expect(isTravel(5)).toBe(false);
        expect(isTravel(MOVE_MIN_M - 1)).toBe(false);
        expect(isTravel(MOVE_MIN_M)).toBe(true);
        expect(isTravel(1200)).toBe(true);
    });

    it("leaves a band between jitter and dwell — they are different questions", () => {
        // 30-100 m is neither confident travel nor confident dwell. It counts as dwell (the
        // vehicle is essentially here) but earns no distance. Overlapping the two thresholds
        // is deliberate; treating them as one number is how a car park becomes a highway.
        expect(MOVE_MIN_M).toBeLessThan(DWELL_RADIUS_M);
        expect(isDwell(50)).toBe(true);
        expect(isTravel(50)).toBe(true); // still earns its distance...
        expect(isDwell(150)).toBe(false); // ...but 150 m is a real move, not a dwell
    });

    it("separates observed dwell from dwell inferred across a gap", () => {
        expect(isObserved(60)).toBe(true);
        expect(isObserved(DWELL_TRUST_GAP_S)).toBe(true);
        // The tracker went quiet for ten days and came back to the same spot. It very probably
        // stayed — but nobody watched, and that distinction must survive to the UI.
        expect(isObserved(10 * 86400)).toBe(false);
    });
});

describe("snapToGrid", () => {
    it("collapses nearby fixes into one cell", () => {
        const a = snapToGrid(25.45701, 81.82903);
        const b = snapToGrid(25.45718, 81.82897);
        expect(a).toEqual(b);
    });

    it("keeps genuinely different places apart", () => {
        expect(snapToGrid(25.457, 81.829)).not.toEqual(snapToGrid(25.303, 81.892));
    });

    it("uses a cell about 111 m across", () => {
        expect(GRID_DEG).toBe(0.001);
        expect(haversineM(25.4, 81.0, 25.4 + GRID_DEG, 81.0)).toBeCloseTo(111, 0);
    });
});

describe("isNightHour", () => {
    it("wraps midnight", () => {
        // 22:00 → 05:00 IST. A window that wraps is the whole reason this is a function and not
        // a `BETWEEN`: `hour >= 22 AND hour < 5` is never true.
        expect(NIGHT_START_HOUR).toBe(22);
        expect(NIGHT_END_HOUR).toBe(5);
        expect(isNightHour(23)).toBe(true);
        expect(isNightHour(0)).toBe(true);
        expect(isNightHour(4)).toBe(true);
    });

    it("excludes the working day", () => {
        expect(isNightHour(5)).toBe(false);
        expect(isNightHour(12)).toBe(false);
        expect(isNightHour(21)).toBe(false);
        expect(isNightHour(22)).toBe(true);
    });
});

describe("pickChargingCluster", () => {
    const cell = (lat: number, chargeHours: number, chargeSessions: number) => ({
        lat,
        lon: 81.0,
        chargeHours,
        chargeSessions,
    });

    it("picks the cell with the most stationary charge time", () => {
        const picked = pickChargingCluster([cell(25.1, 4, 3), cell(25.2, 9, 2), cell(25.3, 2, 5)]);
        expect(picked?.lat).toBe(25.2);
    });

    it("ignores cells below the session floor — one session at a spot is an anecdote", () => {
        // 25.2 has the most hours but only ONE distinct charge session there.
        const picked = pickChargingCluster([cell(25.1, 4, 2), cell(25.2, 9, 1)]);
        expect(picked?.lat).toBe(25.1);
        expect(CHARGING_SPOT_MIN_SESSIONS).toBeGreaterThanOrEqual(2);
    });

    it("returns null when no cell qualifies", () => {
        expect(pickChargingCluster([cell(25.1, 9, 1)])).toBeNull();
        expect(pickChargingCluster([])).toBeNull();
    });

    it("is deterministic on a tie — the first-seen cell wins", () => {
        const picked = pickChargingCluster([cell(25.1, 5, 2), cell(25.2, 5, 2)]);
        expect(picked?.lat).toBe(25.1);
    });
});

describe("pickSecondaryOvernight", () => {
    const spot = (lat: number, nightHours: number, nights: number) => ({
        lat,
        lon: 81.0,
        nightHours,
        nights,
    });

    it("returns the top overnight cluster that is NOT the home cell", () => {
        const home = spot(25.1, 90, 20);
        const picked = pickSecondaryOvernight([home, spot(25.2, 30, 6), spot(25.3, 12, 4)], home);
        expect(picked?.lat).toBe(25.2);
    });

    it("applies the nights floor — one night somewhere is a stopover, not a pattern", () => {
        const home = spot(25.1, 90, 20);
        const picked = pickSecondaryOvernight([home, spot(25.2, 30, 1)], home);
        expect(picked).toBeNull();
        expect(SECONDARY_OVERNIGHT_MIN_NIGHTS).toBeGreaterThanOrEqual(2);
    });

    it("returns null when the only overnight place IS home", () => {
        const home = spot(25.1, 90, 20);
        expect(pickSecondaryOvernight([home], home)).toBeNull();
    });

    it("works without a home — the top qualified cluster wins", () => {
        const picked = pickSecondaryOvernight([spot(25.2, 30, 6), spot(25.3, 40, 3)], null);
        expect(picked?.lat).toBe(25.3);
    });
});

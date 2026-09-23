import { describe, expect, it } from "vitest";
import {
    freshnessPill,
    relativeAge,
    silenceBucket,
    socBucket,
    summariseVehicleStates,
    type VehicleStateRow,
} from "@/lib/telemetry/monitor-math";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A vehicle that last reported `agoMs` ago on both channels. */
function veh(
    vehicleno: string,
    agoMs: number | null,
    extra: Partial<VehicleStateRow> = {},
): VehicleStateRow {
    const at = agoMs === null ? null : new Date(NOW.getTime() - agoMs).toISOString();
    return {
        vehicleno,
        online: agoMs !== null && agoMs < HOUR,
        soc_pct: 55,
        last_battery_at: at,
        last_gps_at: at,
        open_alert_count: 0,
        ...extra,
    };
}

describe("silenceBucket", () => {
    it("buckets by age, newest first", () => {
        expect(silenceBucket(new Date(NOW.getTime() - 5 * 60_000), NOW)).toBe("under_1h");
        expect(silenceBucket(new Date(NOW.getTime() - 6 * HOUR), NOW)).toBe("1h_24h");
        expect(silenceBucket(new Date(NOW.getTime() - 3 * DAY), NOW)).toBe("1d_7d");
        expect(silenceBucket(new Date(NOW.getTime() - 30 * DAY), NOW)).toBe("over_7d");
    });

    it("treats a missing timestamp as never, not as infinitely old", () => {
        // The distinction matters: "never reported" is usually a device that was
        // never installed, while "silent 30 days" is one that broke.
        expect(silenceBucket(null, NOW)).toBe("never");
        expect(silenceBucket(undefined, NOW)).toBe("never");
    });

    it("puts each boundary in the younger bucket", () => {
        expect(silenceBucket(new Date(NOW.getTime() - HOUR), NOW)).toBe("under_1h");
        expect(silenceBucket(new Date(NOW.getTime() - DAY), NOW)).toBe("1h_24h");
        expect(silenceBucket(new Date(NOW.getTime() - 7 * DAY), NOW)).toBe("1d_7d");
    });

    it("accepts an ISO string as well as a Date", () => {
        expect(silenceBucket(new Date(NOW.getTime() - 6 * HOUR).toISOString(), NOW)).toBe("1h_24h");
    });

    it("does not report a clock-skewed future timestamp as stale", () => {
        expect(silenceBucket(new Date(NOW.getTime() + 5 * 60_000), NOW)).toBe("under_1h");
    });

    it("returns never for an unparseable timestamp rather than NaN-bucketing it", () => {
        expect(silenceBucket("not-a-date", NOW)).toBe("never");
    });
});

describe("socBucket", () => {
    it("buckets state of charge in twenties", () => {
        expect(socBucket(0)).toBe("0-20");
        expect(socBucket(12.5)).toBe("0-20");
        expect(socBucket(35)).toBe("20-40");
        expect(socBucket(55)).toBe("40-60");
        expect(socBucket(75)).toBe("60-80");
        expect(socBucket(99.9)).toBe("80-100");
        expect(socBucket(100)).toBe("80-100");
    });

    it("puts an exact boundary in the higher bucket", () => {
        expect(socBucket(20)).toBe("20-40");
        expect(socBucket(80)).toBe("80-100");
    });

    it("distinguishes a missing reading from zero charge", () => {
        // 0% is an emergency; null is a silent sensor. Conflating them would put
        // every unreporting pack into the "critically low" count.
        expect(socBucket(null)).toBeNull();
        expect(socBucket(undefined)).toBeNull();
        expect(socBucket(Number.NaN)).toBeNull();
        expect(socBucket(0)).toBe("0-20");
    });

    it("clamps readings outside 0-100 instead of inventing a bucket", () => {
        expect(socBucket(-5)).toBe("0-20");
        expect(socBucket(140)).toBe("80-100");
    });
});

describe("freshnessPill", () => {
    it("grades the newest signal in the whole fleet", () => {
        expect(freshnessPill(60_000).kind).toBe("live");
        expect(freshnessPill(3 * HOUR).kind).toBe("stale");
        expect(freshnessPill(9 * DAY).kind).toBe("frozen");
        expect(freshnessPill(null).kind).toBe("never");
    });

    it("carries a human label", () => {
        expect(freshnessPill(null).label).toBe("NO DATA");
        expect(freshnessPill(60_000).label).toBe("LIVE");
    });
});

describe("relativeAge", () => {
    it("scales the unit to the magnitude", () => {
        expect(relativeAge(5_000)).toBe("just now");
        expect(relativeAge(90_000)).toBe("1 min ago");
        expect(relativeAge(45 * 60_000)).toBe("45 min ago");
        expect(relativeAge(5 * HOUR)).toBe("5 h ago");
        expect(relativeAge(3 * DAY)).toBe("3 d ago");
    });

    it("renders an absent timestamp as a dash, not as 1970", () => {
        expect(relativeAge(null)).toBe("—");
    });
});

describe("summariseVehicleStates", () => {
    const rows: VehicleStateRow[] = [
        veh("A", 2 * 60_000), // live
        veh("B", 10 * 60_000), // live
        veh("C", 3 * HOUR), // reported today, not live
        veh("D", 3 * DAY), // silent
        veh("E", 40 * DAY), // silent, worst
        veh("F", null), // never reported
        veh("G", null), // never reported
    ];

    it("partitions the fleet exactly once across the three headline tiles", () => {
        const s = summariseVehicleStates(rows, NOW);
        expect(s.fleetSize).toBe(7);
        // This invariant is the whole point: every vehicle is counted once, so
        // the tiles can never sum to more or less than the fleet.
        expect(s.reportedLast24h + s.silentOver24h + s.neverReported).toBe(s.fleetSize);
        expect(s.reportedLast24h).toBe(3);
        expect(s.silentOver24h).toBe(2);
        expect(s.neverReported).toBe(2);
    });

    it("counts live from the online flag, not from a timestamp guess", () => {
        const s = summariseVehicleStates(rows, NOW);
        expect(s.liveNow).toBe(2);
        expect(s.livePct).toBe(28.6);
    });

    it("reports the newest signal across the whole fleet", () => {
        const s = summariseVehicleStates(rows, NOW);
        expect(s.newestSignalAgeMs).toBe(2 * 60_000);
    });

    it("buckets battery and GPS silence independently", () => {
        // A device can hold GPS while its BMS link drops; collapsing the two
        // would hide exactly that failure.
        const split = [
            veh("H", 5 * 60_000, {
                last_gps_at: new Date(NOW.getTime() - 10 * DAY).toISOString(),
            }),
        ];
        const s = summariseVehicleStates(split, NOW);
        expect(s.silence.battery.under_1h).toBe(1);
        expect(s.silence.gps.over_7d).toBe(1);
    });

    it("counts low charge only among packs that actually reported one", () => {
        const withSoc = [
            veh("I", HOUR, { soc_pct: 8 }),
            veh("J", HOUR, { soc_pct: 64 }),
            veh("K", HOUR, { soc_pct: null }),
        ];
        const s = summariseVehicleStates(withSoc, NOW);
        expect(s.soc.withReading).toBe(2);
        expect(s.soc.below20).toBe(1);
        expect(s.soc.buckets["0-20"]).toBe(1);
        expect(s.soc.buckets["60-80"]).toBe(1);
        expect(s.soc.avg).toBe(36);
    });

    it("lists the longest-silent vehicles first and leaves out the never-reported", () => {
        // The never-reported have their own tile. Repeating them here would crowd
        // out the vehicles that were working and have just stopped, which is the
        // list an operator can act on.
        const s = summariseVehicleStates(rows, NOW, { attentionLimit: 10 });
        expect(s.attention.map((r) => r.vehicleno)).toEqual(["E", "D", "C"]);
        expect(s.attention[0].ageMs).toBe(40 * DAY);
    });

    it("honours the attention limit", () => {
        const s = summariseVehicleStates(rows, NOW, { attentionLimit: 1 });
        expect(s.attention).toHaveLength(1);
        expect(s.attention[0].vehicleno).toBe("E");
    });

    it("survives an empty fleet without dividing by zero", () => {
        const s = summariseVehicleStates([], NOW);
        expect(s.fleetSize).toBe(0);
        expect(s.livePct).toBe(0);
        expect(s.newestSignalAgeMs).toBeNull();
        expect(s.soc.avg).toBeNull();
        expect(s.attention).toEqual([]);
    });
});

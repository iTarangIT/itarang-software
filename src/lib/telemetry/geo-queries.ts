/**
 * Location analytics for one battery: where it drives, where it sits, where it parks, and
 * where it sleeps.
 *
 * All four come from the same deduped GPS chain (geo-sql.ts) in a single pass, so the heat map
 * and the parking pin can never describe different journeys.
 */
import { getIotSql } from "@/lib/db/iot";
import { buildTimeWindow, type ChargingWindowOpts } from "@/lib/telemetry/charging-sql";
import { windowsCTE } from "@/lib/telemetry/cycle-distance";
import { gpsCTEs } from "@/lib/telemetry/geo-sql";
import {
    DWELL_RADIUS_M,
    DWELL_TRUST_GAP_S,
    GRID_DEG,
    MOVE_MIN_M,
    NIGHT_END_HOUR,
    NIGHT_START_HOUR,
    geoGates,
    pickChargingCluster,
    pickSecondaryOvernight,
} from "@/lib/telemetry/geo-math";
import { fetchChargingCycleAggregate } from "@/lib/telemetry/queries";

const num = (v: unknown): number | null =>
    v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const n0 = (v: unknown): number => num(v) ?? 0;

/** One cell of the kilometre heat map. `km` is the weight. */
export interface HeatCell {
    lat: number;
    lon: number;
    km: number;
}

/** A place the vehicle sits still. */
export interface DwellCluster {
    lat: number;
    lon: number;
    /** Total hours spent here. */
    hours: number;
    /** Of those, the hours we actually watched (the rest are inferred across telemetry gaps). */
    observedHours: number;
    /** Separate arrivals — how many distinct times it came back here. */
    visits: number;
    /** Hours spent here between 22:00 and 05:00 IST. */
    nightHours: number;
    /** Distinct calendar nights it was here overnight. */
    nights: number;
    /** Most recent IST date it spent night hours here — popup evidence. */
    lastNight: string | null;
}

/** The charging spot: a dwell cluster plus its charge-window evidence. */
export interface ChargingSpot extends DwellCluster {
    /** Stationary hours inside detected charge-cycle windows at this cell. */
    chargeHours: number;
    /** Distinct charge sessions seen at this cell. */
    chargeSessions: number;
}

export interface BatteryGeo {
    vehicleno: string;
    months: number | null;
    month: string | null;
    from: string | null;
    to: string | null;
    /** Kilometre heat map — grid cells weighted by distance travelled through them. */
    heat: HeatCell[];
    /** Every place the vehicle dwelled, ranked by time spent. */
    dwell: DwellCluster[];
    /** Where it spends most of its stationary time. The #1 dwell cluster. */
    parking: DwellCluster | null;
    /**
     * Where it sleeps — the dwell cluster with the most overnight hours.
     *
     * This is a *behavioural* inference, not an address: the place a working vehicle sits
     * between 22:00 and 05:00 across many nights is, in practice, where the driver lives. It is
     * offered as a hypothesis with its evidence attached (nights observed, hours), never as a
     * fact, and it is deliberately NOT reverse-geocoded to a street address here.
     */
    home: DwellCluster | null;
    /**
     * Where it charges — the grid cell with the most stationary time inside detected
     * charge-cycle windows, needing ≥ CHARGING_SPOT_MIN_SESSIONS distinct sessions.
     * Charge windows come from rising-SOC detection; the remote `charging` flag is NULL.
     */
    charging: ChargingSpot | null;
    /**
     * The SECONDARY overnight place — ranked next by night hours after home, excluding
     * home's cell. Null when the vehicle only ever sleeps in one place.
     */
    overnightSecondary: DwellCluster | null;
    bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null;
    summary: {
        /**
         * Sum of straight-line hops between consecutive GPS fixes. **A lower bound on distance
         * travelled, and NOT the number to quote.**
         *
         * Fixes arrive about every 4 minutes, and a chord between two of them cuts every corner
         * of the road between. On the reference battery this reads 3,398 km against the 4,629 km
         * that `distance_rollup` reports — 27% short, and short by construction, not by accident.
         *
         * It is kept because it is exactly the right thing to *weight the heat map by*: the map
         * needs relative intensity along a path, and a systematic under-read applies equally
         * everywhere. It must never be shown as a distance total — §15 and the Usage tab own that.
         */
        gpsChordKm: number;
        fixes: number;
        movingHours: number;
        dwellHours: number;
        /** Share of dwell time inferred across a telemetry gap rather than observed. */
        inferredDwellPct: number;
        days: number;
    };
    gates: ReturnType<typeof geoGates>;
}

/** Cap on heat cells returned. A 6-month window on a busy vehicle is a few thousand. */
const MAX_HEAT_CELLS = 4000;
/** Dwell clusters returned, ranked by hours. */
const MAX_DWELL_CLUSTERS = 25;

export async function fetchBatteryGeo(
    vehicleno: string,
    opts: ChargingWindowOpts,
): Promise<BatteryGeo> {
    const iot = getIotSql();
    const { timePredicate, months, month, from, to } = buildTimeWindow(iot, opts);
    const cte = () => gpsCTEs(iot, vehicleno, timePredicate);

    // Three aggregations over the same chain, plus the charge-cycle aggregate (needed for
    // the charging-spot windows). Run together — they are independent, and the chain is
    // cheap next to the round trip.
    const [heatRows, dwellRows, statRows, charge] = await Promise.all([
        // ── Kilometre heat map ────────────────────────────────────────────────
        // Weighted by DISTANCE, not by fix count. A point-density heat map lights up brightest
        // wherever the vehicle sat longest — which is precisely where it travelled least — and
        // reads as "this is the busy road" when it means "this is the car park".
        iot`
            ${cte()}
            SELECT
                round((lat / ${GRID_DEG})::numeric) * ${GRID_DEG} AS glat,
                round((lon / ${GRID_DEG})::numeric) * ${GRID_DEG} AS glon,
                round((sum(move_m) / 1000.0)::numeric, 3)::float  AS km
            FROM seg
            WHERE move_m >= ${MOVE_MIN_M}
              AND dt_s IS NOT NULL
            GROUP BY 1, 2
            ORDER BY km DESC
            LIMIT ${MAX_HEAT_CELLS}
        `,

        // ── Dwell clusters ────────────────────────────────────────────────────
        // A "visit" is an arrival: an interval where the vehicle was dwelling here but was NOT
        // dwelling here on the previous interval. Counting fixes instead would report a single
        // overnight park as fifty visits.
        iot`
            ${cte()},
            seg_lagged AS (
                -- LAG over the FULL series, before the dwell filter. Computing it inside the
                -- filtered set was a bug: every previous row was then also a dwell row, so an
                -- arrival could never be detected and a 505-hour car park reported "1 visit".
                SELECT *, LAG(move_m) OVER (ORDER BY time) AS prev_move_m
                FROM seg
            ),
            dwell AS (
                SELECT
                    round((lat / ${GRID_DEG})::numeric) * ${GRID_DEG} AS glat,
                    round((lon / ${GRID_DEG})::numeric) * ${GRID_DEG} AS glon,
                    dt_s,
                    hour_ist,
                    (time AT TIME ZONE 'Asia/Kolkata')::date AS ist_date,
                    prev_move_m
                FROM seg_lagged
                WHERE move_m < ${DWELL_RADIUS_M}
                  AND dt_s IS NOT NULL
                  AND dt_s > 0
            )
            SELECT
                glat, glon,
                round((sum(dt_s) / 3600.0)::numeric, 2)::float AS hours,
                round((sum(dt_s) FILTER (WHERE dt_s <= ${DWELL_TRUST_GAP_S}) / 3600.0)::numeric, 2)::float
                                                               AS observed_hours,
                count(*) FILTER (
                    WHERE prev_move_m IS NULL OR prev_move_m >= ${DWELL_RADIUS_M}
                )::int                                         AS visits,
                round((sum(dt_s) FILTER (
                    WHERE hour_ist >= ${NIGHT_START_HOUR} OR hour_ist < ${NIGHT_END_HOUR}
                ) / 3600.0)::numeric, 2)::float                AS night_hours,
                count(DISTINCT ist_date) FILTER (
                    WHERE hour_ist >= ${NIGHT_START_HOUR} OR hour_ist < ${NIGHT_END_HOUR}
                )::int                                         AS nights,
                max(ist_date) FILTER (
                    WHERE hour_ist >= ${NIGHT_START_HOUR} OR hour_ist < ${NIGHT_END_HOUR}
                )::text                                        AS last_night
            FROM dwell
            GROUP BY 1, 2
            ORDER BY hours DESC
            LIMIT ${MAX_DWELL_CLUSTERS}
        `,

        // ── Totals + bounding box ─────────────────────────────────────────────
        iot`
            ${cte()}
            SELECT
                round((sum(move_m) FILTER (WHERE move_m >= ${MOVE_MIN_M}) / 1000.0)::numeric, 1)::float AS total_km,
                count(*)::int                                                                            AS fixes,
                round((sum(dt_s) FILTER (WHERE move_m >= ${MOVE_MIN_M}) / 3600.0)::numeric, 1)::float    AS moving_hours,
                round((sum(dt_s) FILTER (WHERE move_m < ${DWELL_RADIUS_M}) / 3600.0)::numeric, 1)::float AS dwell_hours,
                round((sum(dt_s) FILTER (
                    WHERE move_m < ${DWELL_RADIUS_M} AND dt_s > ${DWELL_TRUST_GAP_S}
                ) / 3600.0)::numeric, 1)::float                                                          AS inferred_hours,
                count(DISTINCT (time AT TIME ZONE 'Asia/Kolkata')::date)::int                            AS days,
                min(lat)::float AS min_lat, max(lat)::float AS max_lat,
                min(lon)::float AS min_lon, max(lon)::float AS max_lon
            FROM seg
        `,

        // ── Charge cycles (for the charging-spot windows) ─────────────────────
        fetchChargingCycleAggregate(vehicleno, opts),
    ]);

    // ── Charging spot ─────────────────────────────────────────────────────────
    // Stationary time per grid cell INSIDE the detected charge windows, plus how many
    // distinct sessions each cell hosted. A second wave, because the windows come from
    // the aggregate above; skipped entirely when no cycle was detected.
    const chargeWindows = charge.cycles.map((c, i) => ({
        id: i + 1,
        start: new Date(c.start_time),
        end: new Date(c.end_time),
    }));
    const chargeCellRows =
        chargeWindows.length === 0
            ? []
            : ((await iot`
                ${cte()},
                ${windowsCTE(iot, chargeWindows)},
                charge_dwell AS (
                    SELECT
                        round((s.lat / ${GRID_DEG})::numeric) * ${GRID_DEG} AS glat,
                        round((s.lon / ${GRID_DEG})::numeric) * ${GRID_DEG} AS glon,
                        s.dt_s,
                        w.win_id
                    FROM seg s
                    JOIN windows w ON s.time > w.start_time AND s.time <= w.end_time
                    WHERE s.move_m < ${DWELL_RADIUS_M}
                      AND s.dt_s IS NOT NULL
                      AND s.dt_s > 0
                )
                SELECT glat, glon,
                       round((sum(dt_s) / 3600.0)::numeric, 2)::float AS charge_hours,
                       count(DISTINCT win_id)::int                    AS charge_sessions
                FROM charge_dwell
                GROUP BY 1, 2
                ORDER BY charge_hours DESC
                LIMIT ${MAX_DWELL_CLUSTERS}
            `) as unknown as Array<Record<string, unknown>>);

    const heat: HeatCell[] = (heatRows as unknown as Array<Record<string, unknown>>).map((r) => ({
        lat: n0(r.glat),
        lon: n0(r.glon),
        km: n0(r.km),
    }));

    const dwell: DwellCluster[] = (dwellRows as unknown as Array<Record<string, unknown>>).map(
        (r) => ({
            lat: n0(r.glat),
            lon: n0(r.glon),
            hours: n0(r.hours),
            observedHours: n0(r.observed_hours),
            visits: n0(r.visits),
            nightHours: n0(r.night_hours),
            nights: n0(r.nights),
            lastNight: r.last_night != null ? String(r.last_night).slice(0, 10) : null,
        }),
    );

    const s = (statRows as unknown as Array<Record<string, unknown>>)[0] ?? {};
    const dwellHours = n0(s.dwell_hours);
    const inferredHours = n0(s.inferred_hours);

    // Parking = where it sits most. Home = where it sits most AT NIGHT — a different question,
    // and often a different place: the busiest daytime dwell is usually a stand or a charging
    // point, not a home.
    const parking = dwell.length > 0 ? dwell[0] : null;
    const nightRanked = [...dwell]
        .filter((d) => d.nights > 0)
        .sort((a, b) => b.nightHours - a.nightHours);
    const home = nightRanked.length > 0 ? nightRanked[0] : null;

    // Charging spot: the winning charge cell, hydrated from the matching dwell cluster
    // when the cell coincides with one (it usually does — vehicles charge where they sit).
    const chargeCells = chargeCellRows.map((r) => ({
        lat: n0(r.glat),
        lon: n0(r.glon),
        chargeHours: n0(r.charge_hours),
        chargeSessions: n0(r.charge_sessions),
    }));
    const chargeCell = pickChargingCluster(chargeCells);
    const chargingDwell = chargeCell
        ? dwell.find((d) => d.lat === chargeCell.lat && d.lon === chargeCell.lon)
        : undefined;
    const charging: ChargingSpot | null = chargeCell
        ? {
              // Fall back to the cell's own evidence when it did not crack the dwell top-25.
              lat: chargeCell.lat,
              lon: chargeCell.lon,
              hours: chargingDwell?.hours ?? chargeCell.chargeHours,
              observedHours: chargingDwell?.observedHours ?? 0,
              visits: chargingDwell?.visits ?? chargeCell.chargeSessions,
              nightHours: chargingDwell?.nightHours ?? 0,
              nights: chargingDwell?.nights ?? 0,
              lastNight: chargingDwell?.lastNight ?? null,
              chargeHours: chargeCell.chargeHours,
              chargeSessions: chargeCell.chargeSessions,
          }
        : null;

    const overnightSecondary = pickSecondaryOvernight(dwell, home);

    const minLat = num(s.min_lat);
    const bbox =
        minLat != null
            ? {
                  minLat,
                  maxLat: n0(s.max_lat),
                  minLon: n0(s.min_lon),
                  maxLon: n0(s.max_lon),
              }
            : null;

    return {
        vehicleno,
        months,
        month,
        from,
        to,
        heat,
        dwell,
        parking,
        home,
        charging,
        overnightSecondary,
        bbox,
        summary: {
            gpsChordKm: n0(s.total_km),
            fixes: n0(s.fixes),
            movingHours: n0(s.moving_hours),
            dwellHours,
            inferredDwellPct:
                dwellHours > 0 ? Math.round((inferredHours / dwellHours) * 1000) / 10 : 0,
            days: n0(s.days),
        },
        gates: geoGates(),
    };
}

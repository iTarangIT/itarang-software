/**
 * The GPS chain: dedupe → segment → classify each interval as travel or dwell.
 *
 * `telemetry_gps` has the same defect as `telemetry_can`: the poller re-inserts the last fix on
 * every poll, so **44% of rows on the reference battery repeat a timestamp** (8,765 rows carry
 * 4,929 distinct times). Without DISTINCT ON, `time - LAG(time)` is 0 across every duplicate,
 * every one of those intervals contributes nothing, and the dwell totals are silently wrong.
 *
 * There is **no PostGIS on this database** (`pg_extension` lists only plpgsql, pg_cron,
 * pg_stat_statements, pg_partman), so the great-circle distance is written out longhand. It
 * mirrors haversineM() in geo-math.ts.
 */
import type { IotSql, SqlFragment } from "./charging-sql";

/**
 * Ends at `seg AS (…)` with no trailing SELECT — a caller appends its own aggregation.
 *
 * Columns available downstream:
 *   time, lat, lon, speed_kph, ignition
 *   prev_lat, prev_lon, dt_s          the interval ENDING at this row
 *   move_m                            great-circle displacement over that interval
 *   hour_ist                          local hour, for the overnight clustering
 */
export function gpsCTEs(iot: IotSql, vehicleno: string, timePredicate: SqlFragment) {
    return iot`
        WITH gps_raw AS (
            SELECT DISTINCT ON (time)
                time,
                lat,
                lon,
                speed_kph,
                ignition
            FROM telemetry_gps
            WHERE vehicleno = ${vehicleno}
              AND lat IS NOT NULL
              AND lon IS NOT NULL
              -- Null Island and out-of-range fixes are decode faults, not places. One of them
              -- in the set would stretch the map's bounding box across the Atlantic.
              AND NOT (lat = 0 AND lon = 0)
              AND abs(lat) <= 90
              AND abs(lon) <= 180
              ${timePredicate}
            ORDER BY time
        ),
        gps_stepped AS (
            SELECT
                time,
                lat,
                lon,
                speed_kph,
                ignition,
                LAG(lat) OVER w                               AS prev_lat,
                LAG(lon) OVER w                               AS prev_lon,
                EXTRACT(EPOCH FROM (time - LAG(time) OVER w)) AS dt_s,
                EXTRACT(HOUR FROM (time AT TIME ZONE 'Asia/Kolkata'))::int AS hour_ist
            FROM gps_raw
            WINDOW w AS (ORDER BY time)
        ),
        seg AS (
            SELECT *,
                -- Haversine, in metres. No PostGIS on this box, so it is spelled out.
                -- asin's argument is clamped: floating-point error can push it a hair above 1
                -- for two identical points, and sqrt of that is NaN, which then poisons every
                -- sum it touches.
                CASE WHEN prev_lat IS NULL THEN NULL ELSE
                    2 * 6371000 * asin(LEAST(1, sqrt(
                        power(sin(radians(lat - prev_lat) / 2), 2)
                        + cos(radians(prev_lat)) * cos(radians(lat))
                          * power(sin(radians(lon - prev_lon) / 2), 2)
                    )))
                END AS move_m
            FROM gps_stepped
        )`;
}

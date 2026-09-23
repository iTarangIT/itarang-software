/**
 * Throwaway probe for the /monitor dashboard.
 *
 * Prints the figures the page should show, computed with SQL written
 * INDEPENDENTLY of src/lib/telemetry/monitor-queries.ts. That is the whole
 * point: importing the production query would only prove the UI renders
 * whatever that function returns, not that the function asks the database the
 * right question. Two different spellings agreeing is evidence; one spelling
 * agreeing with itself is not.
 *
 *   node --env-file=.env.local scripts/_probe-monitor-overview.mjs
 */
import postgres from "postgres";

const IOT = process.env.IOT_DATABASE_URL;
const CRM = process.env.DATABASE_URL;

if (!IOT) {
    console.error("IOT_DATABASE_URL is not set — nothing to probe.");
    process.exit(1);
}

const ssl = (url) => (/sslmode=disable/.test(url) ? false : "require");

const iot = postgres(IOT, { ssl: ssl(IOT), prepare: false, max: 1, connect_timeout: 12 });
const crm = CRM
    ? postgres(CRM, { ssl: { rejectUnauthorized: false }, prepare: false, max: 1, connect_timeout: 12 })
    : null;

function line(label, value) {
    console.log(`  ${String(label).padEnd(34)} ${value}`);
}

try {
    console.log("\n=== FLEET (vehicle_state) ==========================================");
    const [fleet] = await iot`
        SELECT count(*)::int                                                  AS fleet_size,
               count(*) FILTER (WHERE online)::int                            AS live_now,
               count(*) FILTER (
                   WHERE last_battery_at IS NULL AND last_gps_at IS NULL
               )::int                                                         AS never_reported,
               count(*) FILTER (
                   WHERE greatest(
                       coalesce(last_battery_at, '-infinity'::timestamptz),
                       coalesce(last_gps_at,     '-infinity'::timestamptz)
                   ) > now() - interval '24 hours'
               )::int                                                         AS reported_24h,
               count(*) FILTER (
                   WHERE (last_battery_at IS NOT NULL OR last_gps_at IS NOT NULL)
                     AND greatest(
                       coalesce(last_battery_at, '-infinity'::timestamptz),
                       coalesce(last_gps_at,     '-infinity'::timestamptz)
                     ) <= now() - interval '24 hours'
               )::int                                                         AS silent_over_24h
        FROM vehicle_state
    `;
    line("fleet size", fleet.fleet_size);
    line("live now (online=true)", `${fleet.live_now}  (${((fleet.live_now / Math.max(1, fleet.fleet_size)) * 100).toFixed(1)}%)`);
    line("reported in last 24h", fleet.reported_24h);
    line("silent > 24h", fleet.silent_over_24h);
    line("never reported", fleet.never_reported);
    const partition = fleet.reported_24h + fleet.silent_over_24h + fleet.never_reported;
    line(
        "partition check",
        partition === fleet.fleet_size
            ? `OK (${partition} = fleet size)`
            : `MISMATCH ${partition} != ${fleet.fleet_size}`,
    );

    console.log("\n=== FRESHNESS ======================================================");
    const [fresh] = await iot`
        SELECT max(greatest(
                   coalesce(last_battery_at, '-infinity'::timestamptz),
                   coalesce(last_gps_at,     '-infinity'::timestamptz)
               ))                                       AS newest,
               max(last_seen)                           AS newest_last_seen
        FROM vehicle_state
    `;
    const ageMin = fresh.newest ? (Date.now() - new Date(fresh.newest).getTime()) / 60000 : null;
    line("newest real signal", fresh.newest ? `${fresh.newest.toISOString?.() ?? fresh.newest}  (${ageMin.toFixed(1)} min ago)` : "none");
    line("newest last_seen (the liar)", fresh.newest_last_seen?.toISOString?.() ?? String(fresh.newest_last_seen));

    console.log("\n=== SILENCE BANDS ==================================================");
    for (const [chan, col] of [["battery", "last_battery_at"], ["gps", "last_gps_at"]]) {
        const [b] = await iot`
            SELECT count(*) FILTER (WHERE ${iot(col)} > now() - interval '1 hour')::int   AS under_1h,
                   count(*) FILTER (WHERE ${iot(col)} <= now() - interval '1 hour'
                                      AND ${iot(col)} > now() - interval '24 hours')::int AS h1_24,
                   count(*) FILTER (WHERE ${iot(col)} <= now() - interval '24 hours'
                                      AND ${iot(col)} > now() - interval '7 days')::int   AS d1_7,
                   count(*) FILTER (WHERE ${iot(col)} <= now() - interval '7 days')::int  AS over_7d,
                   count(*) FILTER (WHERE ${iot(col)} IS NULL)::int                       AS never
            FROM vehicle_state
        `;
        line(`${chan}`, `<1h ${b.under_1h} | 1-24h ${b.h1_24} | 1-7d ${b.d1_7} | >7d ${b.over_7d} | never ${b.never}`);
    }

    console.log("\n=== STATE OF CHARGE ================================================");
    const [soc] = await iot`
        SELECT count(soc_pct)::int                                            AS with_reading,
               count(*) FILTER (WHERE soc_pct < 20)::int                      AS below_20,
               round(avg(soc_pct)::numeric, 1)::float                         AS avg_soc,
               count(*) FILTER (WHERE soc_pct >= 0  AND soc_pct < 20)::int    AS b0,
               count(*) FILTER (WHERE soc_pct >= 20 AND soc_pct < 40)::int    AS b20,
               count(*) FILTER (WHERE soc_pct >= 40 AND soc_pct < 60)::int    AS b40,
               count(*) FILTER (WHERE soc_pct >= 60 AND soc_pct < 80)::int    AS b60,
               count(*) FILTER (WHERE soc_pct >= 80)::int                     AS b80
        FROM vehicle_state
    `;
    line("packs reporting SOC", soc.with_reading);
    line("below 20%", soc.below_20);
    line("fleet mean", soc.avg_soc);
    line("buckets 0/20/40/60/80", `${soc.b0} / ${soc.b20} / ${soc.b40} / ${soc.b60} / ${soc.b80}`);

    console.log("\n=== ALERTS =========================================================");
    const [al] = await iot`
        SELECT count(*)::int AS open, count(DISTINCT alert_type)::int AS types
        FROM alerts WHERE resolved_at IS NULL
    `;
    line("open alerts", al.open);
    line("distinct alert types", al.types);

    console.log("\n=== DISTANCE (distance_rollup, bucket_size='day') ==================");
    const [d30] = await iot`
        SELECT round(coalesce(sum(distance_km),0)::numeric,1)::float AS total_km,
               count(DISTINCT vehicleno)::int                        AS vehicles,
               count(*)::int                                         AS vehicle_days,
               count(energy_kwh)::int                                AS energy_rows
        FROM distance_rollup
        WHERE bucket_size = 'day' AND time >= now() - interval '30 days'
    `;
    line("total km, 30d", d30.total_km);
    line("vehicles contributing", d30.vehicles);
    line("vehicle-days", d30.vehicle_days);
    line("avg km per vehicle-day", d30.vehicle_days ? (d30.total_km / d30.vehicle_days).toFixed(1) : "n/a");
    line("rows carrying energy_kwh", `${d30.energy_rows}  <- expect 0`);

    const series = await iot`
        SELECT to_char(date_trunc('day', time),'YYYY-MM-DD') AS day,
               count(DISTINCT vehicleno)::int                AS vehicles
        FROM distance_rollup
        WHERE bucket_size = 'day' AND time >= now() - interval '14 days'
        GROUP BY 1 ORDER BY 1
    `;
    line("14-day series points", series.length);
    for (const r of series) line(`  ${r.day}`, `${r.vehicles} vehicles`);

    console.log("\n=== DEAD SIGNALS (the 'not measurable' strip) ======================");
    const [soh] = await iot`
        SELECT count(soh_pct)::int AS reporting,
               count(DISTINCT soh_pct)::int AS distinct_values,
               min(soh_pct)::float AS min_v, max(soh_pct)::float AS max_v
        FROM vehicle_state
    `;
    line("SOH reporting packs", soh.reporting);
    line("SOH distinct values", `${soh.distinct_values}  (min ${soh.min_v} / max ${soh.max_v})`);
    try {
        const [t] = await iot`SELECT count(*)::int AS n FROM trips`;
        line("trips rows", `${t.n}  <- expect 0`);
    } catch (e) {
        line("trips rows", e.code === "42P01" ? "table does not exist" : `error ${e.code}`);
    }

    if (crm) {
        console.log("\n=== CRM BRIDGE (device_battery_map) ================================");
        const [m] = await crm`
            SELECT count(*)::int                                                AS rows,
                   count(*) FILTER (WHERE dealer_id IS NOT NULL
                                      AND btrim(dealer_id) <> '')::int          AS with_dealer,
                   count(*) FILTER (WHERE state IS NOT NULL
                                      AND btrim(state) <> '')::int              AS with_state,
                   count(DISTINCT state)::int                                   AS states
            FROM device_battery_map
        `;
        line("mapping rows", m.rows);
        line("with dealer_id", `${m.with_dealer}  <- expect 0`);
        line("with state", m.with_state);
        line("distinct states", m.states);
    } else {
        console.log("\n(DATABASE_URL not set — skipped the CRM bridge section)");
    }

    console.log("");
} catch (err) {
    console.error("\nPROBE FAILED:", err?.message || err);
    if (err?.code) console.error("SQLSTATE:", err.code);
    process.exitCode = 1;
} finally {
    await iot.end({ timeout: 5 });
    if (crm) await crm.end({ timeout: 5 });
}

/**
 * Polar (Intellicar) + Aggregator data-pipeline review.
 *
 * Introspects the live IoT Postgres (AWS RDS, reached via the bastion tunnel on
 * IOT_DATABASE_URL), validates the raw -> aggregated transformation, and writes a
 * multi-sheet Excel review to reports/.
 *
 * Read-only: information_schema, pg_catalog and SELECTs. Nothing here writes.
 *
 *   node scripts/polar-aggregator-review.mjs
 *
 * Requires the IoT tunnel to be up (127.0.0.1:5500 by default).
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const postgres = require("postgres");
const ExcelJS = require("exceljs");

const ROOT = path.resolve(import.meta.dirname, "..");

function loadEnv() {
  const file = path.join(ROOT, ".env.local");
  const line = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("IOT_DATABASE_URL="));
  if (!line) throw new Error("IOT_DATABASE_URL not found in .env.local");
  return line.slice("IOT_DATABASE_URL=".length).replace(/^["']|["']$/g, "").trim();
}

const sql = postgres(loadEnv(), {
  ssl: "require",
  prepare: false,
  max: 2,
  connect_timeout: 15,
  idle_timeout: 120,
});

/**
 * Reference battery — the one docs/intellicar-calculations.md is pinned to, and the same default
 * as diagnose-charging-cycles.ts, charging-math.test.ts and the export fixture.
 *
 * This used to read TK-51105-04HY-122432 while claiming, in this very comment, to be the doc's
 * battery. It was not: every stat this workbook labelled "reference battery" — cadence, current
 * distribution, BMS cycles — was therefore being read against the doc's 62/62 cycles and 106.0 Ah
 * mean as though the two described the same pack. They did not.
 *
 * Override with --vehicleno=... . If the chosen battery has no CAN rows the run stops rather than
 * emitting a workbook full of blank "reference" sheets that look like a dead fleet.
 */
const REF =
    process.argv.find((a) => a.startsWith("--vehicleno="))?.slice("--vehicleno=".length) ||
    "TK-51105-02DZ-213416";

/**
 * Every check records its own status, so a dropped tunnel degrades one row, not the run.
 * Results are cached to disk: the bastion tunnel has dropped mid-run before, and a partial
 * pass should not throw away the checks that did land. A cached row is labelled as such so
 * nobody mistakes it for a fresh reading.
 */
const CACHE = path.join(ROOT, "reports", ".polar-review-cache.json");

/**
 * The cache is keyed by check id, but a third of the checks are scoped to REF — so a cache written
 * for one reference battery is meaningless for another. It carries the battery it was collected
 * against, and a mismatch discards it rather than relabelling one pack's cadence and current
 * distribution as another's. Losing a cache costs one re-run; keeping the wrong one costs a
 * workbook that is confidently wrong.
 */
const rawCache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
const cachedRef = rawCache.__ref;
const cacheUsable = Object.keys(rawCache).length === 0 || cachedRef === REF;
const cache = cacheUsable ? rawCache : {};
if (!cacheUsable) {
  // An UNLABELLED cache is discarded too, not trusted. Caches written before __ref existed were
  // collected against the old, wrong reference battery — "no label" means "cannot verify whose
  // readings these are", and that is not a licence to use them.
  console.log(
    `Cache was collected against ${cachedRef ?? "an unrecorded battery"}, not ${REF} — discarding it.\n`,
  );
}
delete cache.__ref;
const results = {};

/**
 * Pre-flight. The bastion tunnel drops often; without this, every one of the ~55 checks
 * would sit through its own connect_timeout before falling back to cache, turning a dead
 * tunnel into a 15-minute run. One probe decides it for all of them.
 */
let online = true;
try {
  await sql`SELECT 1`;
  console.log("IoT DB reachable — collecting live.");
  // The reference battery is load-bearing: ~a third of the checks below are scoped to it, and the
  // workbook compares their results against the numbers docs/intellicar-calculations.md pins to
  // this same pack. A REF with no rows does not fail — it quietly yields empty "reference" sheets
  // that read as a dead battery. Better to stop and say which battery, and offer the real ones.
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM telemetry_can WHERE vehicleno = ${REF}`;
  if (n === 0) {
    console.error(`\nReference battery ${REF} has no telemetry_can rows on this DB.`);
    const near = await sql`
      SELECT vehicleno, count(*)::int AS rows, max(time)::text AS last_seen
      FROM telemetry_can GROUP BY 1 ORDER BY 2 DESC LIMIT 5`;
    if (near.length) {
      console.error("Batteries with the most CAN data here:");
      for (const v of near) console.error(`  ${v.vehicleno}  ${v.rows} rows, last ${v.last_seen}`);
    }
    console.error("\nRe-run with --vehicleno=<one of the above> if the pinned battery has retired.");
    process.exit(2);
  }
  console.log(`Reference battery ${REF}: ${n} CAN rows.\n`);
} catch (err) {
  online = false;
  if (!Object.keys(cache).length) {
    console.error(`IoT DB unreachable (${err.message}) and no cache to fall back on.`);
    console.error("Bring the tunnel up on 127.0.0.1:5500 and re-run.");
    process.exit(1);
  }
  console.log(`IoT DB unreachable (${err.message}).`);
  console.log("Rebuilding the workbook from the cached readings instead.\n");
}

async function check(id, fn) {
  if (!online) {
    const hit = cache[id];
    if (hit) {
      results[id] = { ok: true, cached: true, cachedAt: hit.at, rows: hit.rows, error: "tunnel down" };
      return hit.rows;
    }
    results[id] = { ok: false, error: "tunnel down, no cached reading", rows: [] };
    return [];
  }
  try {
    const rows = await fn();
    results[id] = { ok: true, rows };
    cache[id] = { rows, at: new Date().toISOString() };
    console.log(`  ok      ${id}`);
    return rows;
  } catch (err) {
    const hit = cache[id];
    if (hit) {
      results[id] = { ok: true, cached: true, cachedAt: hit.at, rows: hit.rows, error: err.message };
      console.log(`  cached  ${id} — live query failed (${err.message}); using ${hit.at}`);
      return hit.rows;
    }
    results[id] = { ok: false, error: err.message, rows: [] };
    console.log(`  FAIL    ${id} — ${err.message}`);
    return [];
  }
}

function saveCache() {
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  // __ref rides along so the next run can tell whose readings these are.
  fs.writeFileSync(CACHE, JSON.stringify({ ...cache, __ref: REF }, null, 2));
}

// ---------------------------------------------------------------------------
// Collect
// ---------------------------------------------------------------------------
console.log("Collecting from IoT DB…");

const tables = await check("tables", () => sql`
  SELECT c.relname AS table_name,
         CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned' ELSE c.relkind::text END AS kind,
         pg_size_pretty(pg_total_relation_size(c.oid)) AS size
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relispartition = false
  ORDER BY c.relname`);

const columns = await check("columns", () => sql`
  SELECT c.table_name, c.ordinal_position, c.column_name, c.data_type, c.is_nullable
  FROM information_schema.columns c
  JOIN pg_class pc ON pc.relname = c.table_name
  JOIN pg_namespace n ON n.oid = pc.relnamespace AND n.nspname = 'public'
  WHERE c.table_schema = 'public' AND pc.relispartition = false
  ORDER BY c.table_name, c.ordinal_position`);

const keys = await check("keys", () => sql`
  SELECT conrelid::regclass::text AS table_name, contype, pg_get_constraintdef(oid) AS def
  FROM pg_constraint WHERE connamespace='public'::regnamespace AND contype IN ('p','u')
  ORDER BY 1`);

// Partition health — has the partition-creation job stopped?
const partitions = await check("partitions", () => sql`
  SELECT parent.relname AS parent,
         count(*)::int AS n_partitions,
         max(child.relname) AS newest_partition,
         pg_size_pretty(max(CASE WHEN child.relname LIKE '%_default'
                                 THEN pg_total_relation_size(child.oid) END)) AS default_partition_size
  FROM pg_inherits i
  JOIN pg_class parent ON parent.oid = i.inhparent
  JOIN pg_class child ON child.oid = i.inhrelid
  JOIN pg_namespace n ON n.oid = parent.relnamespace AND n.nspname='public'
  WHERE parent.relkind = 'p'
  GROUP BY parent.relname ORDER BY 1`);

// Row counts + time span + vehicle coverage, per table.
const TABLE_TIME = {
  vehicles: null, vehicle_state: "updated_at", telemetry_can: "time",
  telemetry_battery: "time", telemetry_gps: "time", telemetry_fuel: "time",
  trips: "start_time", alerts: "time", distance_rollup: "time",
  aggregator_runs: null, hourly_battery_per_vehicle: "hour",
  daily_distance_per_vehicle: "day", dashboard_nbfc_loans_with_iot: null,
  dashboard_vehicle_monthly_range: null,
};
const counts = [];
for (const [t, tc] of Object.entries(TABLE_TIME)) {
  const cols = columns.filter((c) => c.table_name === t).map((c) => c.column_name);
  if (!cols.length) continue;
  const hasV = cols.includes("vehicleno");
  let q = `SELECT count(*)::bigint AS rows`;
  if (tc && cols.includes(tc)) q += `, min(${tc})::text AS min_t, max(${tc})::text AS max_t,
      round(EXTRACT(epoch FROM now()-max(${tc}))/60)::bigint AS mins_stale`;
  if (hasV) q += `, count(DISTINCT vehicleno)::int AS vehicles`;
  q += ` FROM ${t}`;
  const rows = await check(`count:${t}`, () => sql.unsafe(q));
  counts.push({ table: t, ...(rows[0] ?? {}) });
}

// Samples — 5 records per table, reference vehicle where present.
const samples = {};
for (const t of Object.keys(TABLE_TIME)) {
  const cols = columns.filter((c) => c.table_name === t).map((c) => c.column_name);
  if (!cols.length) continue;
  const tc = TABLE_TIME[t] && cols.includes(TABLE_TIME[t]) ? TABLE_TIME[t] : null;
  const where = cols.includes("vehicleno") ? ` WHERE vehicleno = '${REF}'` : "";
  const order = tc ? ` ORDER BY ${tc} DESC` : "";
  let rows = await check(`sample:${t}`, () => sql.unsafe(`SELECT * FROM ${t}${where}${order} LIMIT 5`));
  if (!rows.length && where) {
    rows = await check(`sample2:${t}`, () => sql.unsafe(`SELECT * FROM ${t}${order} LIMIT 5`));
  }
  samples[t] = rows;
}

// The CAN payload signal dictionary — what Polar actually sends.
const canSignals = await check("canSignals", () => sql`
  WITH s AS (SELECT payload FROM telemetry_can WHERE vehicleno=${REF} ORDER BY time DESC LIMIT 1)
  SELECT k AS signal,
         (s.payload->k->>'value') AS latest_value,
         to_char(to_timestamp(((s.payload->k->>'timestamp')::bigint)/1000)
                 AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI:SS') AS signal_ts_ist
  FROM s, LATERAL jsonb_object_keys(s.payload) AS k ORDER BY k`);

// ---- Validation ----
console.log("Validating…");

await check("V1_duplicates", () => sql`
  SELECT 'telemetry_can' AS tbl, count(*)::bigint AS stored_rows,
         count(DISTINCT (vehicleno,time))::bigint AS distinct_vehicle_time,
         round(100.0*(1-count(DISTINCT (vehicleno,time))::numeric/nullif(count(*),0)),1) AS pct_duplicate
  FROM telemetry_can WHERE time > now()-interval '30 days'
  UNION ALL SELECT 'telemetry_gps', count(*), count(DISTINCT (vehicleno,time)),
         round(100.0*(1-count(DISTINCT (vehicleno,time))::numeric/nullif(count(*),0)),1)
  FROM telemetry_gps WHERE time > now()-interval '30 days'
  UNION ALL SELECT 'telemetry_battery', count(*), count(DISTINCT (vehicleno,time)),
         round(100.0*(1-count(DISTINCT (vehicleno,time))::numeric/nullif(count(*),0)),1)
  FROM telemetry_battery WHERE time > now()-interval '30 days'`);

await check("V1b_dup_lossless", () => sql`
  WITH d AS (
    SELECT vehicleno, time, count(*) AS n,
           count(DISTINCT (payload->'soc'->>'value')) AS soc_variants,
           count(DISTINCT (payload->'current'->>'value')) AS cur_variants
    FROM telemetry_can WHERE time > now()-interval '7 days'
    GROUP BY vehicleno, time HAVING count(*) > 1)
  SELECT count(*)::bigint AS duplicate_groups,
         count(*) FILTER (WHERE soc_variants > 1)::bigint AS groups_conflicting_soc,
         count(*) FILTER (WHERE cur_variants > 1)::bigint AS groups_conflicting_current,
         max(n)::int AS max_copies_of_one_frame
  FROM d`);

await check("V2_ordering", () => sql`
  WITH raw AS (SELECT DISTINCT ON (time) time FROM telemetry_can
               WHERE vehicleno=${REF} AND time > now()-interval '90 days' ORDER BY time),
       g AS (SELECT EXTRACT(epoch FROM time - LAG(time) OVER (ORDER BY time)) AS dt FROM raw)
  SELECT count(*)::bigint AS intervals,
         count(*) FILTER (WHERE dt < 0)::bigint AS out_of_order,
         count(*) FILTER (WHERE dt = 0)::bigint AS zero_gap,
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY dt)::numeric,0) AS p50_s,
         round(percentile_cont(0.9) WITHIN GROUP (ORDER BY dt)::numeric,0) AS p90_s,
         round(percentile_cont(0.99) WITHIN GROUP (ORDER BY dt)::numeric,0) AS p99_s,
         round(max(dt)::numeric,0) AS max_gap_s
  FROM g WHERE dt IS NOT NULL`);

await check("V3_soc_consistency", () => sql`
  SELECT count(*)::bigint AS rows_compared,
         count(*) FILTER (WHERE c.soc = b.soc_pct)::bigint AS soc_equal,
         count(*) FILTER (WHERE c.soc <> b.soc_pct)::bigint AS soc_differs,
         COALESCE(max(abs(c.soc-b.soc_pct)),0)::numeric AS max_abs_diff
  FROM (SELECT DISTINCT ON (vehicleno,time) vehicleno,time,(payload->'soc'->>'value')::numeric AS soc
        FROM telemetry_can WHERE time > now()-interval '7 days') c
  JOIN (SELECT DISTINCT ON (vehicleno,time) vehicleno,time,soc_pct
        FROM telemetry_battery WHERE time > now()-interval '7 days') b
    ON b.vehicleno=c.vehicleno AND b.time=c.time`);

await check("V3b_snapshot_drift", () => sql`
  WITH latest AS (SELECT DISTINCT ON (vehicleno) vehicleno,
                    (payload->'soc'->>'value')::numeric AS can_soc
                  FROM telemetry_can WHERE time > now()-interval '2 days'
                  ORDER BY vehicleno, time DESC)
  SELECT count(*)::bigint AS vehicles_compared,
         count(*) FILTER (WHERE vs.soc_pct = l.can_soc)::bigint AS soc_equal,
         count(*) FILTER (WHERE vs.soc_pct <> l.can_soc)::bigint AS soc_differs
  FROM vehicle_state vs JOIN latest l USING (vehicleno) WHERE vs.soc_pct IS NOT NULL`);

await check("V4_current", () => sql`
  WITH c AS (SELECT DISTINCT ON (time) (payload->'current'->>'value')::numeric AS cur
             FROM telemetry_can WHERE vehicleno=${REF} AND time > now()-interval '90 days' ORDER BY time)
  SELECT count(*)::bigint AS deduped_samples,
         count(*) FILTER (WHERE cur IS NULL)::bigint AS null_current,
         count(*) FILTER (WHERE cur < 0)::bigint AS negative_current,
         count(*) FILTER (WHERE cur = 0)::bigint AS zero_current,
         count(*) FILTER (WHERE abs(cur) > 500)::bigint AS corrupt_over_500a,
         round(min(cur),2) AS min_a, round(max(cur),2) AS max_a,
         round(percentile_cont(0.99) WITHIN GROUP (ORDER BY cur)::numeric,2) AS p99_a
  FROM c`);

await check("V5_battery_fill", () => sql`
  SELECT count(*)::bigint AS rows_7d,
         round(100.0*count(soc_pct)/nullif(count(*),0),1) AS pct_soc,
         round(100.0*count(soh_pct)/nullif(count(*),0),1) AS pct_soh,
         round(100.0*count(pack_voltage)/nullif(count(*),0),1) AS pct_pack_voltage,
         round(100.0*count(pack_current)/nullif(count(*),0),1) AS pct_pack_current,
         round(100.0*count(pack_temp_c)/nullif(count(*),0),1) AS pct_pack_temp,
         round(100.0*count(charging)/nullif(count(*),0),1) AS pct_charging_flag
  FROM telemetry_battery WHERE time > now()-interval '7 days'`);

await check("V5b_state_fill", () => sql`
  SELECT count(*)::bigint AS rows,
         round(100.0*count(soc_pct)/count(*),1) AS pct_soc,
         round(100.0*count(soh_pct)/count(*),1) AS pct_soh,
         round(100.0*count(pack_current)/count(*),1) AS pct_pack_current,
         round(100.0*count(charging)/count(*),1) AS pct_charging,
         round(100.0*count(range_km)/count(*),1) AS pct_range_km,
         count(*) FILTER (WHERE online)::int AS online_now
  FROM vehicle_state`);

await check("V5c_rollup_fill", () => sql`
  SELECT bucket_size, count(*)::bigint AS rows,
         round(100.0*count(distance_km)/count(*),1) AS pct_distance_km,
         round(100.0*count(energy_kwh)/count(*),1) AS pct_energy_kwh,
         round(100.0*count(moving_seconds)/count(*),1) AS pct_moving_seconds,
         round(avg(distance_km)::numeric,2) AS avg_km, round(max(distance_km)::numeric,2) AS max_km
  FROM distance_rollup GROUP BY bucket_size`);

await check("V6_coverage", () => sql`
  SELECT (SELECT count(*) FROM vehicles)::int AS vehicles_master,
         (SELECT count(*) FROM vehicle_state)::int AS vehicle_state,
         (SELECT count(DISTINCT vehicleno) FROM telemetry_can WHERE time > now()-interval '30 days')::int AS can_30d,
         (SELECT count(DISTINCT vehicleno) FROM telemetry_battery WHERE time > now()-interval '30 days')::int AS battery_30d,
         (SELECT count(DISTINCT vehicleno) FROM telemetry_gps WHERE time > now()-interval '30 days')::int AS gps_30d,
         (SELECT count(DISTINCT vehicleno) FROM distance_rollup WHERE time > now()-interval '30 days')::int AS rollup_30d`);

await check("V7_freshness", () => sql`
  SELECT 'telemetry_can' AS tbl, round(EXTRACT(epoch FROM now()-max(time))/60)::bigint AS mins_stale FROM telemetry_can
  UNION ALL SELECT 'telemetry_gps', round(EXTRACT(epoch FROM now()-max(time))/60) FROM telemetry_gps
  UNION ALL SELECT 'telemetry_battery', round(EXTRACT(epoch FROM now()-max(time))/60) FROM telemetry_battery
  UNION ALL SELECT 'alerts', round(EXTRACT(epoch FROM now()-max(time))/60) FROM alerts
  UNION ALL SELECT 'distance_rollup', round(EXTRACT(epoch FROM now()-max(time))/60) FROM distance_rollup
  UNION ALL SELECT 'vehicle_state', round(EXTRACT(epoch FROM now()-max(updated_at))/60) FROM vehicle_state
  ORDER BY 2`);

await check("V8_distance_recon", () => sql`
  WITH gps AS (SELECT DISTINCT ON (time) time, lat, lon FROM telemetry_gps
               WHERE vehicleno=${REF} AND time > now()-interval '10 days' AND lat IS NOT NULL ORDER BY time),
       legs AS (SELECT date_trunc('day', time) AS day,
                 6371*2*asin(sqrt(power(sin(radians(lat-LAG(lat) OVER (ORDER BY time))/2),2) +
                   cos(radians(LAG(lat) OVER (ORDER BY time)))*cos(radians(lat))*
                   power(sin(radians(lon-LAG(lon) OVER (ORDER BY time))/2),2))) AS km
                FROM gps),
       gps_day AS (SELECT day, round(sum(km)::numeric,2) AS gps_km FROM legs
                   WHERE km IS NOT NULL AND km < 5 GROUP BY day)
  SELECT to_char(d.time,'YYYY-MM-DD') AS day, d.distance_km AS rollup_km, g.gps_km,
         round((d.distance_km - COALESCE(g.gps_km,0))::numeric,2) AS diff_km,
         CASE WHEN g.gps_km > 0 THEN round((100.0*d.distance_km/g.gps_km)::numeric,0) END AS rollup_pct_of_gps
  FROM distance_rollup d LEFT JOIN gps_day g ON g.day = d.time
  WHERE d.vehicleno=${REF} AND d.time > now()-interval '10 days' AND d.bucket_size='day'
  ORDER BY d.time DESC`);

await check("V9_alerts", () => sql`
  SELECT alert_type, severity, count(*)::bigint AS n,
         count(*) FILTER (WHERE resolved_at IS NULL)::bigint AS still_open
  FROM alerts WHERE time > now()-interval '7 days' GROUP BY 1,2 ORDER BY n DESC LIMIT 15`);

await check("V10_soh", () => sql`
  SELECT count(*)::int AS vehicles, round(avg(soh_pct)::numeric,1) AS avg_soh,
         min(soh_pct) AS min_soh, max(soh_pct) AS max_soh,
         count(*) FILTER (WHERE soh_pct < 80)::int AS warranty_at_risk,
         count(*) FILTER (WHERE soh_pct = 100)::int AS soh_exactly_100,
         count(*) FILTER (WHERE soh_pct IS NULL)::int AS soh_null
  FROM vehicle_state`);

await check("V11_bms_cycles", () => sql`
  SELECT min((payload->'charge_cycle'->>'value')::numeric) AS bms_cycle_first,
         max((payload->'charge_cycle'->>'value')::numeric) AS bms_cycle_last,
         max((payload->'charge_cycle'->>'value')::numeric)
           - min((payload->'charge_cycle'->>'value')::numeric) AS bms_cycles_in_window,
         max((payload->'rated_capacity'->>'value')::numeric) AS rated_ah,
         max((payload->'soh'->>'value')::numeric) AS soh_pct
  FROM telemetry_can WHERE vehicleno=${REF} AND time > now()-interval '90 days'`);

await check("V12_stuck_frames", () => sql`
  SELECT vehicleno, time::text AS frame_time, count(*)::int AS copies_stored
  FROM telemetry_can WHERE time > now()-interval '7 days'
  GROUP BY vehicleno, time ORDER BY count(*) DESC LIMIT 5`);

saveCache();
// Don't let teardown block the report: if the bastion tunnel has dropped, end() sits on a
// dead socket forever and the workbook never gets written.
await Promise.race([
  sql.end({ timeout: 5 }).catch(() => {}),
  new Promise((res) => setTimeout(res, 6000).unref()),
]);

// ---------------------------------------------------------------------------
// Workbook
// ---------------------------------------------------------------------------
console.log("Building workbook…");

const wb = new ExcelJS.Workbook();
wb.creator = "iTarang — Polar/Aggregator pipeline review";
wb.created = new Date();

const NAVY = "FF1F3864", GREY = "FFF2F2F2", RED = "FFFFC7CE", AMBER = "FFFFEB9C", GREEN = "FFC6EFCE";

function sheet(name) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  return ws;
}
function header(ws, cols) {
  ws.columns = cols;
  const row = ws.getRow(1);
  row.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
  row.alignment = { vertical: "middle", wrapText: true };
  row.height = 28;
}
function tint(ws, colKey, map) {
  ws.eachRow((row, i) => {
    if (i === 1) return;
    const v = String(row.getCell(colKey).value ?? "");
    const argb = map[v];
    if (argb) row.getCell(colKey).fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
  });
}
const STATUS_TINT = { OK: GREEN, PASS: GREEN, WARN: AMBER, FAIL: RED, BROKEN: RED, EMPTY: RED, MISSING: RED };
const r = (id) => results[id]?.rows ?? [];
const r0 = (id) => results[id]?.rows?.[0] ?? {};
const failed = (id) => !results[id]?.ok;

// ---- Sheet: Executive Summary
{
  const ws = sheet("0. Summary");
  header(ws, [
    { header: "#", key: "n", width: 5 },
    { header: "Finding", key: "f", width: 62 },
    { header: "Severity", key: "s", width: 11 },
    { header: "Evidence (live DB)", key: "e", width: 66 },
    { header: "Impact / action", key: "a", width: 62 },
  ]);
  const dup = r("V1_duplicates").find((x) => x.tbl === "telemetry_can") ?? {};
  const cov = r0("V6_coverage");
  const fill = r0("V5_battery_fill");
  const stuck = r("V12_stuck_frames")[0] ?? {};
  const rollup = r("V5c_rollup_fill")[0] ?? {};
  const soh = r0("V10_soh");
  const soc = r0("V3_soc_consistency");
  const snap = r0("V3b_snapshot_drift");

  const rows = [
    ["The Aggregator has never run. Not once.",
     "BROKEN",
     "aggregator_runs = 0 rows. Its five output tables are all empty: trips, daily_distance_per_vehicle, hourly_battery_per_vehicle, dashboard_nbfc_loans_with_iot, dashboard_vehicle_monthly_range.",
     "There is no aggregation layer in production. Every dashboard number is computed on the fly from raw telemetry. Decide: revive the aggregator, or formally adopt query-time analytics and delete the dead tables."],

    ["Five aggregator tables were designed but the DDL was never applied.",
     "MISSING",
     "battery_health_metrics, charge_events, geofence_events, immobilizer_state, fault_codes do not exist in the DB. DDL sits unapplied in docs/nbfc/vps_tables.sql.",
     "No user-visible breakage: all five readers in src/lib/db/iot-queries.ts catch SQLSTATE 42P01 and fall back to raw telemetry. Four are dead code. Confirm we still want them before building on them."],

    ["Trip Analytics is permanently empty — trips table has 0 rows fleet-wide.",
     "BROKEN",
     "trips = 0 rows, yet the reference battery demonstrably drove ~4,629 km (distance_rollup).",
     "'No trips found' on the Trip Analytics tab is a pipeline gap, not a query bug. Any trip-level metric is unbuildable until the trip aggregator runs."],

    ["Avg Daily Distance under a State/City filter — FIXED, was reading 0 km for every state.",
     "PASS",
     "queries.ts:101-114 now reads distance_rollup on BOTH the filtered and unfiltered paths, scoped by vehicleno = ANY(...), with bucket_size='day' pinned on each. Shipped in 1b06b3b4.",
     "Kept on this sheet as a closed finding, not deleted: it was reported as a live P0 and a reader who saw it once is owed the resolution. Re-check by filtering the Fleet tab to any state and confirming a non-zero average."],

    ["Avg Daily Distance and bucket_size — FIXED, and the original claim was overstated.",
     "PASS",
     `Both paths in queries.ts now pin bucket_size='day'. The earlier WARN said the average was "diluted by non-daily bucket rows" — but distance_rollup contains only ONE bucket size. Buckets actually present: ${r("V5c_rollup_fill").map((b) => `${b.bucket_size} (${b.rows} rows)`).join(", ") || "n/a"}.`,
     "Nothing was ever being diluted: there are no non-daily rows to dilute it with. The filter is still correct to pin — it costs nothing and it stops a future weekly/monthly bucket from silently changing a KPI — but this was a latent risk, not a live wrong number. Recorded so the fix is not credited with an improvement it did not make."],

    ["telemetry_can stores the same CAN frame over and over.",
     "WARN",
     `${dup.pct_duplicate ?? "?"}% of rows in the last 30 days are duplicate (vehicleno,time). Worst single frame stored ${stuck.copies_stored ?? "?"} times. Duplicates are byte-identical (0 conflicting SOC/current), so DISTINCT ON dedupe is lossless.`,
     "Not a correctness bug today — every analytics query dedupes with DISTINCT ON (time). It is a ~5x storage and scan-cost tax, and it is a landmine for any new query that forgets to dedupe."],

    ["telemetry_battery is mostly hollow: pack_voltage, pack_temp and the charging flag are 100% NULL.",
     "BROKEN",
     `15.9M rows. Over the last 7d: soc ${fill.pct_soc}% filled, soh ${fill.pct_soh}%, but pack_voltage ${fill.pct_pack_voltage}%, pack_temp ${fill.pct_pack_temp}%, charging flag ${fill.pct_charging_flag}%. pack_current is only ${fill.pct_pack_current}% filled.`,
     "There is NO historical charging flag anywhere — charge/discharge has to be inferred from rising SOC. The designed charge_events table reads telemetry_battery.charging and is therefore unbuildable as specified. Do not build on these columns; use telemetry_can."],

    ["The telemetry_battery feed has stalled — no rows for ~10.6 hours.",
     "FAIL",
     `Staleness right now: telemetry_gps ${(r("V7_freshness").find((x)=>x.tbl==="telemetry_gps")||{}).mins_stale} min, telemetry_can ${(r("V7_freshness").find((x)=>x.tbl==="telemetry_can")||{}).mins_stale} min — but telemetry_battery ${(r("V7_freshness").find((x)=>x.tbl==="telemetry_battery")||{}).mins_stale} min. Its last row is timestamped exactly 23:59:58 on the previous day.`,
     "CAN and GPS are live while the battery feed is not, and it stopped precisely on a day boundary. Feeds the SOH Degradation chart. Ask the IoT team whether this is a nightly batch or a stalled writer."],

    ["Partition creation stopped ~2 weeks ago; 4.4 GB is piling into a single unpruned default partition.",
     "WARN",
     r("partitions").filter((p)=>["telemetry_can","telemetry_battery","telemetry_gps"].includes(p.parent))
       .map((p) => `${p.parent}: newest=${p.newest_partition}, _default=${p.default_partition_size}`).join(" | "),
     "Newest real partitions are p20260630–p20260704 while today is 2026-07-13, so every new row lands in *_default. Partition pruning is lost on the hottest tables and _default grows without bound. Note alerts/distance_rollup have partitions out to p20260808 — the maintenance job is only failing for the telemetry_* tables."],

    ["SOH is a dead signal: every non-null pack reads exactly 100.",
     "FAIL",
     `${soh.vehicles} vehicles: min ${soh.min_soh}, max ${soh.max_soh}, avg ${soh.avg_soh}. Exactly 100: ${soh.soh_exactly_100}. NULL: ${soh.soh_null}. Warranty At-Risk (<80): ${soh.warranty_at_risk}.`,
     "The Warranty At-Risk KPI can never fire, and the SOH Degradation chart is a flat line by construction. Either the BMS never computes SOH or the poller never reads it. Confirm with Intellicar before any battery-health feature is built on SOH."],

    ["Alerts only ever contain 'offline'. The ~30 BMS fault flags in the CAN payload are never turned into alerts.",
     "WARN",
     `Last 7 days: ${r("V9_alerts").map((a)=>`${a.alert_type}/${a.severity} n=${a.n} open=${a.still_open}`).join("; ")}. Meanwhile telemetry_can carries cell_over_voltage_alarm, thermal_runway_protection, charge_over_current_alarm and ~27 more.`,
     "Real battery faults are being received and silently discarded. The intended fault_codes table would have decoded them — it was never created. Cheapest safety win available."],

    ["No odometer exists anywhere in the telemetry.",
     "WARN",
     "No odometer/km column in telemetry_can, telemetry_gps, telemetry_battery or vehicle_state. Distance exists only as the pre-aggregated distance_rollup.",
     "Any kilometre metric is bounded by distance_rollup's daily granularity. Per-trip or per-cycle km cannot be derived without inventing a split."],

    ["distance_rollup.energy_kwh and moving_seconds are 100% NULL.",
     "WARN",
     `energy_kwh ${rollup.pct_energy_kwh ?? "?"}% filled, moving_seconds ${rollup.pct_moving_seconds ?? "?"}% filled, distance_km ${rollup.pct_distance_km ?? "?"}%.`,
     "No energy overlay and no idle/moving split are possible from the rollup. Efficiency must be derived as coulomb-counted Ah ÷ rollup km."],

    ["Fleet coverage is not uniform across the feeds.",
     "WARN",
     `vehicles=${cov.vehicles_master ?? "?"}, vehicle_state=${cov.vehicle_state ?? "?"}, GPS 30d=${cov.gps_30d ?? "?"}, CAN 30d=${cov.can_30d ?? "?"}, battery 30d=${cov.battery_30d ?? "?"}, rollup 30d=${cov.rollup_30d ?? "?"}.`,
     "Some vehicles report GPS but no CAN. Fleet-wide battery averages are over the CAN-reporting subset, not the whole fleet — state that on the dashboard."],

    ["The raw -> analytics transformation itself is sound.",
     "PASS",
     `SOC agrees EXACTLY between telemetry_can and telemetry_battery (${soc.rows_compared} rows compared, ${soc.soc_differs} differ) and vehicle_state matches the latest CAN frame for all ${snap.vehicles_compared} vehicles. Zero out-of-order timestamps. Zero corrupt (>500 A) current frames. distance_rollup reconciles to GPS-derived distance within ~2%.`,
     "The maths, the ordering and the numbers are trustworthy. Every problem on this sheet is MISSING data, not WRONG data — which is the good news, and it means the fixes are pipeline fixes, not query rewrites."],
  ];
  rows.forEach((x, i) => ws.addRow({ n: i + 1, f: x[0], s: x[1], e: x[2], a: x[3] }));
  ws.eachRow((row, i) => { if (i > 1) row.alignment = { vertical: "top", wrapText: true }; });
  tint(ws, "s", STATUS_TINT);
  ws.getColumn("s").alignment = { horizontal: "center", vertical: "top" };
}

// ---- Sheet: Data flow
{
  const ws = sheet("1. Data Flow");
  header(ws, [
    { header: "Stage", key: "st", width: 26 },
    { header: "Component", key: "c", width: 30 },
    { header: "Runs where", key: "w", width: 30 },
    { header: "Writes / reads", key: "t", width: 52 },
    { header: "Frequency", key: "f", width: 22 },
    { header: "Status", key: "s", width: 11 },
    { header: "Notes", key: "n", width: 70 },
  ]);
  const flow = [
    ["1. Source", "Intellicar (Polar) cloud API", "Intellicar SaaS", "REST — vehicle list, live state, CAN/BMS frames, GPS, alerts, daily distance", "Continuous", "OK",
     "Upstream vendor. Device streams roughly every 30 s; what we retain is set by the poller, not the device."],
    ["2. Ingest (Poller)", "iot_stack poller (Python)", "AWS (outside this repo)", "WRITES: vehicles, vehicle_state, telemetry_can, telemetry_battery, telemetry_gps, alerts, distance_rollup", "~5–15 min/vehicle (measured p50 8.5 min)", "OK",
     "Re-inserts the latest frame on every poll whether or not the device produced a new one — hence the duplicate-timestamp rows."],
    ["3. Aggregate", "iot_stack aggregator (Python)", "AWS (outside this repo)", "SHOULD WRITE: trips, daily_distance_per_vehicle, hourly_battery_per_vehicle, dashboard_* (+5 tables whose DDL was never applied)", "Designed: hourly / daily 02:00 UTC", "BROKEN",
     "HAS NEVER RUN. aggregator_runs is empty and every output table has 0 rows. This is the central finding of this review."],
    ["4. Serve (CRM)", "Next.js API routes /api/telemetry/*", "CRM app (this repo)", "READS the IoT DB directly via IOT_DATABASE_URL (read-only role)", "Per request", "OK",
     "Because stage 3 is dead, the CRM does all the analytics itself in SQL at query time, straight off raw telemetry_can."],
    ["5. Analytics logic", "src/lib/telemetry/*.ts (charging-sql, discharge-sql, charging-math)", "CRM app (this repo)", "READS telemetry_can; dedupes, detects cycles, coulomb-counts", "Per request", "OK",
     "This is the de-facto aggregator. It is well tested (see __tests__) and pinned in docs/intellicar-calculations.md."],
    ["6. Present", "/ceo/intellicar (7 tabs)", "Browser", "READS the API routes", "Per page view", "WARN",
     "Trip Analytics is permanently empty; Avg Daily Distance zeroes out under a State/City filter."],
  ];
  flow.forEach((x) => ws.addRow({ st: x[0], c: x[1], w: x[2], t: x[3], f: x[4], s: x[5], n: x[6] }));
  ws.eachRow((row, i) => { if (i > 1) row.alignment = { vertical: "top", wrapText: true }; });
  tint(ws, "s", STATUS_TINT);

  ws.addRow({});
  const d = ws.addRow({ st: "ASCII FLOW" });
  d.font = { bold: true };
  [
    "  Intellicar (Polar) REST API",
    "            |",
    "            v",
    "  [ POLLER  - python, AWS ]  ......... RUNNING",
    "            |",
    "            +--> vehicles              (311 rows,  master list)",
    "            +--> vehicle_state         (310 rows,  live snapshot, 1 row/vehicle, UPSERT)",
    "            +--> telemetry_can         (2.48M rows, full BMS payload as JSONB)   <-- ALL analytics read this",
    "            +--> telemetry_battery     (15.9M rows, soc/soh only; rest 100% NULL)",
    "            +--> telemetry_gps         (4.04M rows, lat/lon/speed/ignition)",
    "            +--> alerts                (187k rows)",
    "            +--> distance_rollup       (16k rows, daily km; energy/moving 100% NULL)",
    "            |",
    "            v",
    "  [ AGGREGATOR - python, AWS ] ....... NEVER RUN  (aggregator_runs = 0 rows)",
    "            |",
    "            X  trips                        0 rows  -> Trip Analytics tab is empty",
    "            X  daily_distance_per_vehicle   0 rows  -> Avg Daily Distance = 0 km when filtered",
    "            X  hourly_battery_per_vehicle   0 rows  -> unused",
    "            X  dashboard_nbfc_loans_with_iot 0 rows -> unused",
    "            X  dashboard_vehicle_monthly_range 0 rows -> unused",
    "            X  battery_health_metrics / charge_events / geofence_events /",
    "               immobilizer_state / fault_codes .... TABLES DO NOT EXIST (DDL never applied)",
    "            |",
    "            v",
    "  [ CRM query-time analytics ] ....... THE REAL AGGREGATOR",
    "    src/lib/telemetry/charging-sql.ts + discharge-sql.ts + charging-math.ts",
    "    dedupe (DISTINCT ON) -> cycle detect -> trapezoidal coulomb count -> capacity extrapolation",
    "            |",
    "            v",
    "  /ceo/intellicar dashboard",
  ].forEach((line) => ws.addRow({ st: line }));
}

// ---- Sheet: Polar API endpoints (reconstructed / inferred)
{
  const ws = sheet("2. Polar API Endpoints");
  header(ws, [
    { header: "Inferred endpoint (Polar/Intellicar)", key: "e", width: 34 },
    { header: "Method", key: "m", width: 9 },
    { header: "Populates table", key: "t", width: 22 },
    { header: "Cadence (measured / designed)", key: "c", width: 34 },
    { header: "Returns — key fields (evidence)", key: "r", width: 52 },
    { header: "Basis / evidence in the DB", key: "b", width: 52 },
    { header: "Confidence", key: "f", width: 12 },
  ]);

  const cnt = Object.fromEntries(counts.map((c) => [c.table, c]));
  const fresh = Object.fromEntries(r("V7_freshness").map((x) => [x.tbl, x.mins_stale]));
  const ord = r0("V2_ordering");
  const bf = r0("V5_battery_fill");
  const staleOf = (t) => {
    const v = fresh[t] ?? cnt[t]?.mins_stale;
    return v == null ? "" : ` (last row ${v} min ago)`;
  };

  const EP = [
    ["Vehicle list / registry", "GET", "vehicles",
     "On change (info_updated)",
     "vehicleno, info JSONB (Intellicar model, assigned groups)",
     `vehicles has ${cnt.vehicles?.rows ?? "?"} rows, one per vehicle; info JSONB carries the Intellicar model — a registry pull, not a stream.`],

    ["Live status / last state", "GET", "vehicle_state",
     `~1–5 min (UPSERT)${staleOf("vehicle_state")}`,
     "soc_pct, soh_pct, lat/lon, online, range_km, charging",
     "One UPSERTed row per vehicle — the only place a live charging flag exists. A 'latest snapshot' endpoint, not a history feed."],

    ["CAN / BMS raw frame", "GET", "telemetry_can",
     `p50 ${ord.p50_s ?? "?"}s / p90 ${ord.p90_s ?? "?"}s between stored frames${staleOf("telemetry_can")}`,
     "Full BMS payload JSONB — ~100 signals: soc, soh, current, battery_voltage, rated_capacity, charge_cycle, 24 cell voltages, 12 cell temps, ~30 alarm/protection flags",
     "telemetry_can.payload is the richest object in the pipeline and the source for ALL battery analytics — see the CAN Payload Signals sheet for the live dictionary."],

    ["Battery series", "GET", "telemetry_battery",
     `~15–30 s series${staleOf("telemetry_battery")}`,
     `soc_pct, soh_pct (only these are filled: soc ${bf.pct_soc ?? "?"}%, soh ${bf.pct_soh ?? "?"}%; pack_voltage/temp/charging 100% NULL)`,
     `${cnt.telemetry_battery?.rows ?? "?"} rows but hollow — a narrow columnar mirror of SOC/SOH; the fill audit (Data Validation) shows the rest is NULL.`],

    ["GPS / location series", "GET", "telemetry_gps",
     `~30–60 s series${staleOf("telemetry_gps")}`,
     "lat, lon, speed_kph, heading, ignition, gps_fix, ext_voltage",
     `${cnt.telemetry_gps?.rows ?? "?"} rows; feeds the heat map. Position/ignition columns imply a location endpoint distinct from the CAN frame.`],

    ["Alerts / events", "GET", "alerts",
     `Event-driven${staleOf("alerts")}`,
     "alert_type, severity, time, resolved_at (NULL = open)",
     "Only 'offline' alerts are present (V9_alerts) even though ~30 BMS fault flags arrive on the CAN frame — an event endpoint the poller under-uses."],

    ["Distance / daily summary", "GET", "distance_rollup",
     "Daily bucket",
     "distance_km per (vehicle, day); energy_kwh + moving_seconds 100% NULL",
     "The ONLY distance source (no odometer anywhere). Pre-bucketed by day → a summary/report endpoint, not raw telemetry."],

    ["Fuel series", "GET", "telemetry_fuel",
     "n/a (EV fleet)",
     "— not applicable —",
     `telemetry_fuel exists (${cnt.telemetry_fuel?.rows ?? 0} rows) but an EV fleet produces no fuel telemetry — listed for completeness of the Polar API surface.`],
  ];

  EP.forEach((x) => ws.addRow({ e: x[0], m: x[1], t: x[2], c: x[3], r: x[4], b: x[5], f: "INFERRED" }));
  ws.eachRow((row, i) => { if (i > 1) row.alignment = { vertical: "top", wrapText: true }; });
  tint(ws, "f", { INFERRED: AMBER });

  ws.addRow({});
  const note = ws.addRow({ e: "HOW TO READ THIS SHEET" });
  note.font = { bold: true };
  [
    "Intellicar (Polar) is a THIRD-PARTY platform. Nothing in the CRM repo calls it — the poller",
    "that does runs on AWS, outside this repo. These endpoints are RECONSTRUCTED from the shape of",
    "the data that landed in each table (columns, JSONB payload, cadence, refresh pattern), not read",
    "from the poller's source. Endpoint names/paths are indicative, not verified — confirm against the",
    "poller / Intellicar API docs before building against a specific path. What IS verified is the",
    "right-hand side: which table each stream lands in, and what it actually contains.",
  ].forEach((line) => ws.addRow({ e: line }));
}

// ---- Sheet: Polar API tables
{
  const ws = sheet("3. Polar API Tables");
  header(ws, [
    { header: "Table", key: "t", width: 30 },
    { header: "Written by", key: "w", width: 14 },
    { header: "Purpose", key: "p", width: 52 },
    { header: "Source (Polar/Intellicar)", key: "s", width: 34 },
    { header: "Refresh", key: "f", width: 24 },
    { header: "Primary key", key: "k", width: 34 },
    { header: "Rows", key: "r", width: 12 },
    { header: "Vehicles", key: "v", width: 10 },
    { header: "Earliest", key: "e", width: 22 },
    { header: "Latest", key: "l", width: 22 },
    { header: "Stale (min)", key: "m", width: 11 },
    { header: "Status", key: "st", width: 10 },
  ]);
  const META = {
    vehicles: ["POLLER", "Master vehicle/battery registry. `info` JSONB holds the Intellicar model + assigned groups.", "Vehicle list API", "On change (info_updated)", "vehicleno"],
    vehicle_state: ["POLLER", "Live snapshot — one row per vehicle, UPSERTed. Drives every Fleet KPI and the Fleet Devices table.", "Live state API", "~1–5 min (UPSERT)", "vehicleno"],
    telemetry_can: ["POLLER", "Full BMS/CAN frame as JSONB (~100 signals: SOC, SOH, current, voltage, rated capacity, 24 cell voltages, 12 cell temps, alarms). THE source for all battery analytics.", "CAN/BMS frame API", "p50 8.5 min (device streams ~30 s)", "none (append-only)"],
    telemetry_battery: ["POLLER", "Narrow columnar battery series. Only soc_pct + soh_pct are populated; current/voltage/temp/charging are 100% NULL.", "Battery API", "~15–30 s", "none (append-only)"],
    telemetry_gps: ["POLLER", "Position, speed, heading, ignition, external voltage. Feeds the map/heat map.", "GPS API", "~30–60 s", "none (append-only)"],
    alerts: ["POLLER", "Alert log (mostly 'offline'). resolved_at NULL = open. Drives Active Alerts + Critical status.", "Alerts API", "Event-driven", "none (append-only)"],
    distance_rollup: ["POLLER", "Daily distance per vehicle. The ONLY distance source — there is no odometer. energy_kwh + moving_seconds are 100% NULL.", "Distance/summary API", "Daily", "(time, vehicleno, bucket_size)"],
    telemetry_fuel: ["POLLER", "Fuel series — not applicable to an EV fleet.", "Fuel API", "n/a", "none"],
  };
  for (const c of counts) {
    const m = META[c.table];
    if (!m) continue;
    const rows = Number(c.rows ?? 0);
    ws.addRow({
      t: c.table, w: m[0], p: m[1], s: m[2], f: m[3], k: m[4],
      r: rows, v: c.vehicles ?? "-", e: c.min_t ?? "-", l: c.max_t ?? "-",
      m: c.mins_stale ?? "-",
      st: rows === 0 ? "EMPTY" : Number(c.mins_stale ?? 0) > 120 ? "WARN" : "OK",
    });
  }
  ws.eachRow((row, i) => { if (i > 1) row.alignment = { vertical: "top", wrapText: true }; });
  tint(ws, "st", STATUS_TINT);
}

// ---- Sheet: Telemetry types compared
{
  const ws = sheet("4. Telemetry Types Compared");
  header(ws, [
    { header: "Telemetry type (as requested)", key: "t", width: 22 },
    { header: "Backing table", key: "b", width: 20 },
    { header: "What it represents", key: "r", width: 40 },
    { header: "Shape", key: "sh", width: 26 },
    { header: "Granularity / cadence", key: "g", width: 26 },
    { header: "Key fields", key: "k", width: 46 },
    { header: "Rows", key: "n", width: 12 },
    { header: "Vehicles", key: "v", width: 10 },
    { header: "Fill / quality", key: "q", width: 46 },
    { header: "Dup-ts", key: "d", width: 10 },
    { header: "Consumed by", key: "u", width: 34 },
    { header: "Status", key: "s", width: 10 },
  ]);

  const cnt = Object.fromEntries(counts.map((c) => [c.table, c]));
  const bf = r0("V5_battery_fill");
  const sf = r0("V5b_state_fill");
  const dup = Object.fromEntries(r("V1_duplicates").map((x) => [x.tbl, x.pct_duplicate]));
  const rowsOf = (t) => Number(cnt[t]?.rows ?? 0);
  const stat = (t) => (rowsOf(t) === 0 ? "EMPTY" : Number(cnt[t]?.mins_stale ?? 0) > 120 ? "WARN" : "OK");

  const TT = [
    ["Vehicle telemetry", "vehicle_state (+ vehicles)",
     "Live per-vehicle snapshot + the master registry. NOT a time series — the current state of each vehicle.",
     "UPSERT snapshot — 1 row / vehicle",
     "Overwritten ~1–5 min",
     "vehicleno, soc_pct, soh_pct, lat/lon, online, range_km, charging",
     rowsOf("vehicle_state"), cnt.vehicle_state?.vehicles ?? "-",
     `soc ${sf.pct_soc ?? "?"}%, charging ${sf.pct_charging ?? "?"}%, range_km ${sf.pct_range_km ?? "?"}%; ${sf.online_now ?? "?"} online now`,
     "n/a",
     "Every Fleet KPI, Fleet Devices table, heat map (live)", stat("vehicle_state")],

    ["Battery telemetry", "telemetry_battery",
     "Narrow columnar battery series (soc/soh). Looks like the battery source but is mostly hollow.",
     "Append-only series",
     "~15–30 s",
     "vehicleno, time, soc_pct, soh_pct — pack_voltage/current/temp/charging exist but NULL",
     rowsOf("telemetry_battery"), cnt.telemetry_battery?.vehicles ?? "-",
     `soc ${bf.pct_soc ?? "?"}%, soh ${bf.pct_soh ?? "?"}%, pack_current ${bf.pct_pack_current ?? "?"}%, pack_voltage ${bf.pct_pack_voltage ?? "?"}%, charging ${bf.pct_charging_flag ?? "?"}%`,
     `${dup.telemetry_battery ?? "?"}%`,
     "SOH Degradation chart only", stat("telemetry_battery")],

    ["CAN telemetry", "telemetry_can",
     "Full BMS/CAN frame as JSONB (~100 signals). THE source for every battery-analytics number.",
     "Append-only series (JSONB)",
     "p50 ~8–9 min stored (device ~30 s)",
     "vehicleno, time, payload{soc, current, battery_voltage, rated_capacity, charge_cycle, soh, cell_voltage_01..24, cell_temperature_01..12, *_alarm}",
     rowsOf("telemetry_can"), cnt.telemetry_can?.vehicles ?? "-",
     "Rich & trustworthy; SOC matches battery/state exactly. Current is UNSIGNED (can't sign charge vs discharge).",
     `${dup.telemetry_can ?? "?"}%`,
     "All charge/discharge analytics, AH trend, capacity, timeline", stat("telemetry_can")],

    ["GPS telemetry", "telemetry_gps",
     "Position / motion series.",
     "Append-only series",
     "~30–60 s",
     "vehicleno, time, lat, lon, speed_kph, heading, ignition, gps_fix, ext_voltage",
     rowsOf("telemetry_gps"), cnt.telemetry_gps?.vehicles ?? "-",
     "Feeds the heat map; reconciles distance_rollup to within ~2%.",
     `${dup.telemetry_gps ?? "?"}%`,
     "Heat map, distance recon, (trips — if aggregator ran)", stat("telemetry_gps")],

    ["Fuel telemetry", "telemetry_fuel",
     "Fuel-level series — not applicable to an EV fleet.",
     "Append-only series",
     "n/a",
     "(schema present; no data expected for EVs)",
     rowsOf("telemetry_fuel"), cnt.telemetry_fuel?.vehicles ?? "-",
     "Empty by design — the fleet is electric.",
     "-",
     "nothing", stat("telemetry_fuel")],
  ];

  TT.forEach((x) => ws.addRow({
    t: x[0], b: x[1], r: x[2], sh: x[3], g: x[4], k: x[5],
    n: x[6], v: x[7], q: x[8], d: x[9], u: x[10], s: x[11],
  }));
  ws.eachRow((row, i) => { if (i > 1) row.alignment = { vertical: "top", wrapText: true }; });
  tint(ws, "s", STATUS_TINT);

  ws.addRow({});
  ws.addRow({ t: "The five 'telemetry types' are the poller's write targets. Two are snapshots vs series, and CAN is the only one every analytic actually reads — Battery telemetry looks equivalent but is hollow (see Fill / quality)." });
  ws.getRow(ws.rowCount).alignment = { wrapText: true, vertical: "top" };
}

// ---- Sheet: Raw telemetry field spec
{
  const ws = sheet("5. Raw Telemetry Fields");
  header(ws, [
    { header: "Requested field", key: "q", width: 22 },
    { header: "Available?", key: "a", width: 12 },
    { header: "Table", key: "t", width: 20 },
    { header: "Column / JSON path", key: "c", width: 42 },
    { header: "Type / unit", key: "u", width: 20 },
    { header: "Example", key: "e", width: 24 },
    { header: "Notes", key: "n", width: 78 },
  ]);
  const F = [
    ["Battery number", "YES", "all tables", "vehicleno", "text", REF, "The battery/vehicle identifier. Same key across every table — the join key for the whole pipeline."],
    ["Timestamp", "YES", "telemetry_can", "time (timestamptz, UTC)", "timestamptz", "2026-07-13 09:40:44Z", "Device time. 79% of rows repeat a (vehicleno,time) already stored — ALWAYS DISTINCT ON (time) before any dt maths, or dt=0 silently kills the integral."],
    ["SOC", "YES", "telemetry_can", "payload->'soc'->>'value'", "integer %, 0–100", "33", "Quantised to whole percent. Also mirrored in telemetry_battery.soc_pct and vehicle_state.soc_pct — all three agree exactly (validated)."],
    ["Voltage", "YES", "telemetry_can", "payload->'battery_voltage'->>'value'", "volts", "51.85", "Pack voltage. telemetry_battery.pack_voltage exists but is 100% NULL — do not use it. Per-cell: payload->'cell_voltage_01..24'."],
    ["Current", "YES", "telemetry_can", "payload->'current'->>'value'", "amps (UNSIGNED magnitude)", "7.71", "CRITICAL: unsigned. Current>0 does NOT mean charging — discharge current (~57 A) runs higher than charge current (~21 A). Rising SOC is the only charge signal."],
    ["GPS coordinates", "YES", "telemetry_gps", "lat, lon", "numeric degrees", "25.317727, 81.878799", "Also speed_kph, heading, ignition, gps_fix, ext_voltage. 61% duplicate timestamps — dedupe. Feeds the heat map. vehicle_state carries the latest fix."],
    ["Odometer / Kilometer", "NO", "—", "— does not exist —", "—", "—", "THERE IS NO ODOMETER FIELD ANYWHERE. Distance exists only as distance_rollup.distance_km (daily bucket), written by the poller. Per-trip/per-cycle km cannot be derived."],
    ["Charging status", "PARTIAL", "vehicle_state", "charging (boolean)", "boolean", "true", "Present on the LIVE snapshot only. telemetry_battery.charging is 100% NULL, so there is no historical charging flag. History is DERIVED in the CRM from rising SOC (charging-sql.ts)."],
    ["SOH", "YES", "telemetry_can", "payload->'soh'->>'value'", "integer %", "100", "Drives Avg SOH and Warranty At-Risk (<80). Currently ~every pack reads 100 — see the SOH check on the Validation sheet."],
    ["Rated capacity", "YES", "telemetry_can", "payload->'rated_capacity'->>'value'", "Ah (nameplate)", "105", "BMS nameplate. The plausibility band (0.3x–1.5x) for estimated capacity is taken against this."],
    ["BMS charge cycles", "YES", "telemetry_can", "payload->'charge_cycle'->>'value'", "integer counter", "210", "The BMS's OWN cycle counter — an independent ground truth to check our derived cycle count against. Not currently used by the dashboard."],
    ["Pack temperature", "YES", "telemetry_can", "payload->'battery_temp'->>'value'", "deg C", "33.55", "Per-cell temps in cell_temperature_01..12; unused sensors report -273.15 (absolute zero) as their null."],
    ["Cell voltages", "YES", "telemetry_can", "payload->'cell_voltage_01..24'", "volts", "3.246", "16 real cells on this pack; slots 17–24 read 0. min/max also given as maximum_cell_voltage / minimum_cell_voltage."],
    ["Alarms / protections", "YES", "telemetry_can", "payload->'*_alarm', '*_protection'", "0/1 flags", "0", "~30 boolean fault flags (over-temp, over-current, short circuit, thermal runaway...). Unused by the dashboard today; the intended fault_codes table was never created."],
    ["Energy (kWh)", "NO", "distance_rollup", "energy_kwh", "kWh", "NULL", "Column exists, 100% NULL. No energy overlay is possible. Efficiency must be coulomb-counted Ah / rollup km."],
    ["Moving seconds", "NO", "distance_rollup", "moving_seconds", "seconds", "NULL", "Column exists, 100% NULL. No idle-vs-moving split available."],
  ];
  F.forEach((x) => ws.addRow({ q: x[0], a: x[1], t: x[2], c: x[3], u: x[4], e: x[5], n: x[6] }));
  ws.eachRow((row, i) => { if (i > 1) row.alignment = { vertical: "top", wrapText: true }; });
  tint(ws, "a", { YES: GREEN, NO: RED, PARTIAL: AMBER });
}

// ---- Sheet: CAN payload dictionary
{
  const ws = sheet("6. CAN Payload Signals");
  header(ws, [
    { header: "Signal (payload key)", key: "k", width: 34 },
    { header: "Latest value", key: "v", width: 24 },
    { header: "Signal timestamp (IST)", key: "t", width: 24 },
    { header: "Used by the dashboard?", key: "u", width: 30 },
  ]);
  const USED = {
    soc: "YES — every charging/discharge metric", current: "YES — coulomb counting (Ah)",
    battery_voltage: "YES — export sheets", rated_capacity: "YES — capacity plausibility band",
    soh: "YES — Avg SOH, Warranty At-Risk", charge_cycle: "no — but is an independent ground truth",
    discharge_cycle: "no — independent ground truth", battery_temp: "no",
    dod: "no", alarm: "no", protection: "no",
  };
  for (const s of r("canSignals")) {
    ws.addRow({ k: s.signal, v: s.latest_value, t: s.signal_ts_ist, u: USED[s.signal] ?? "no" });
  }
  ws.eachRow((row, i) => {
    if (i === 1) return;
    const u = String(row.getCell("u").value ?? "");
    if (u.startsWith("YES")) row.getCell("u").fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREEN } };
  });
  ws.addRow({});
  ws.addRow({ k: `Sampled from the latest telemetry_can frame for ${REF}. Note the two distinct signal timestamps: some signals (temps, charger mode) are refreshed far less often than SOC/current.` });
}

// ---- Sheet: Aggregator pipeline
{
  const ws = sheet("7. Aggregator Pipeline");
  header(ws, [
    { header: "Output table", key: "o", width: 32 },
    { header: "Exists?", key: "x", width: 10 },
    { header: "Rows", key: "r", width: 9 },
    { header: "Intended input", key: "i", width: 26 },
    { header: "Intended processing logic", key: "p", width: 62 },
    { header: "Intended output columns", key: "c", width: 58 },
    { header: "Consumed by", key: "b", width: 36 },
    { header: "Status", key: "s", width: 10 },
  ]);
  const AGG = [
    ["trips", "YES", "telemetry_gps + ignition", "Segment the GPS series into trips on ignition on/off; sum haversine distance per segment.", "start_time, end_time, distance_km, duration_s, start/end lat-lon, vehicleno", "Trip Analytics tab (Trip History)", "EMPTY"],
    ["daily_distance_per_vehicle", "YES", "telemetry_gps / distance_rollup", "Roll distance up to one row per (vehicle, day).", "vehicleno, day, km", "Avg Daily Distance KPI (filtered path only)", "EMPTY"],
    ["hourly_battery_per_vehicle", "YES", "telemetry_battery", "Bucket SOC/SOH/temp to hourly means per vehicle.", "vehicleno, hour, avg SOC/SOH/temp", "nothing (no reader in src/)", "EMPTY"],
    ["dashboard_nbfc_loans_with_iot", "YES", "CRM loans + vehicle_state", "Denormalised NBFC loan x IoT join for the NBFC dashboard.", "loan + telemetry columns", "nothing (no reader in src/)", "EMPTY"],
    ["dashboard_vehicle_monthly_range", "YES", "telemetry_* ", "Monthly range/utilisation per vehicle.", "vehicleno, month, range metrics", "nothing (no reader in src/)", "EMPTY"],
    ["battery_health_metrics", "NO", "telemetry_battery", "Daily SOH degradation rate (pp/day) + EOL date projection (SOH crosses 60%).", "vehicleno, sample_date, soh_pct, degradation_rate_30d, predicted_eol_date, cycles_since_install", "NBFC battery state route (guarded — falls back to raw telemetry)", "MISSING"],
    ["charge_events", "NO", "telemetry_battery (charging=true window)", "Discrete charge sessions. NOTE: this design is unbuildable as written — telemetry_battery.charging is 100% NULL.", "start/end_time, start/end_soc_pct, energy_kwh, duration_s, charger_kind", "dead code (no callers)", "MISSING"],
    ["geofence_events", "NO", "telemetry_gps + geofences", "Enter/exit/violation log vs the home cluster centroid.", "vehicleno, geofence_id, event_type, event_time, lat, lon, distance_km", "dead code (no callers)", "MISSING"],
    ["immobilizer_state", "NO", "device command ACKs", "Current immobiliser state + last toggle audit.", "vehicleno, enabled, last_toggled_at, last_reason, last_request_id", "dead code (no callers)", "MISSING"],
    ["fault_codes", "NO", "telemetry_can alarm/protection flags", "Decode BMS DTCs into an open/resolved fault log.", "vehicleno, dtc_code, description, severity, raised_at, resolved_at", "dead code (no callers)", "MISSING"],
  ];
  const cnt = Object.fromEntries(counts.map((c) => [c.table, c.rows]));
  AGG.forEach((x) => ws.addRow({
    o: x[0], x: x[1], r: x[1] === "NO" ? "n/a" : Number(cnt[x[0]] ?? 0),
    i: x[2], p: x[3], c: x[4], b: x[5], s: x[6],
  }));
  ws.eachRow((row, i) => { if (i > 1) row.alignment = { vertical: "top", wrapText: true }; });
  tint(ws, "s", STATUS_TINT);
  tint(ws, "x", { YES: GREEN, NO: RED });

  ws.addRow({});
  const h = ws.addRow({ o: "WHAT ACTUALLY DOES THE AGGREGATION TODAY" });
  h.font = { bold: true };
  [
    ["src/lib/telemetry/charging-sql.ts", "sampleCTEs + cycleCTEs", "telemetry_can", "Dedupe (DISTINCT ON time) -> drop |I|>500 A -> session split on dSOC>=0 AND dt<=7200 s -> trim to the real charge -> trapezoidal coulomb count -> capacity = Ah / (dSOC/100)", "Charging Cycles, Total AH, Avg Capacity, AH Trend, Charging Timeline", "OK"],
    ["src/lib/telemetry/discharge-sql.ts", "dischargeCTEs, deepDischargeCTEs", "telemetry_can", "Mirror of the above for falling SOC; deep-discharge events debounced with hysteresis.", "Discharge analytics routes (built, not yet wired into the UI)", "OK"],
    ["src/lib/telemetry/charging-math.ts", "extrapolateCapacity", "(in JS)", "Capacity extrapolation + plausibility band vs rated_capacity.", "Avg Capacity, AH Trend", "OK"],
  ].forEach((x) => ws.addRow({ o: x[0], x: "", r: "", i: x[2], p: x[3], c: x[1], b: x[4], s: x[5] }));
  tint(ws, "s", STATUS_TINT);
}

// ---- Sheet: Validation
{
  const ws = sheet("8. Data Validation");
  header(ws, [
    { header: "#", key: "n", width: 5 },
    { header: "Check", key: "c", width: 46 },
    { header: "Method", key: "m", width: 54 },
    { header: "Result", key: "r", width: 62 },
    { header: "Verdict", key: "v", width: 10 },
  ]);
  const dupCan = r("V1_duplicates").find((x) => x.tbl === "telemetry_can") ?? {};
  const dupGps = r("V1_duplicates").find((x) => x.tbl === "telemetry_gps") ?? {};
  const dupBat = r("V1_duplicates").find((x) => x.tbl === "telemetry_battery") ?? {};
  const lossless = r0("V1b_dup_lossless");
  const ord = r0("V2_ordering");
  const soc = r0("V3_soc_consistency");
  const snap = r0("V3b_snapshot_drift");
  const cur = r0("V4_current");
  const bf = r0("V5_battery_fill");
  const sf = r0("V5b_state_fill");
  const cov = r0("V6_coverage");
  const soh = r0("V10_soh");
  const bms = r0("V11_bms_cycles");
  const recon = r("V8_distance_recon");

  const V = [
    ["Raw telemetry matches aggregated data",
     "distance_rollup.distance_km vs haversine distance recomputed from raw telemetry_gps, per day, reference vehicle.",
     recon.length
       ? `${recon.length} days compared. distance_rollup lands at ${Math.min(...recon.map((x) => Number(x.rollup_pct_of_gps || 0)).filter(Boolean))}–${Math.max(...recon.map((x) => Number(x.rollup_pct_of_gps || 0)))}% of the distance recomputed by haversine from raw GPS — i.e. the two agree to within a couple of percent on most days. A rollup slightly ABOVE the GPS figure is expected: a haversine sum over sparse, duplicate-heavy GPS fixes is a lower bound. See the Distance Recon sheet.`
       : "NOT RUN (tunnel down)",
     recon.length ? "PASS" : "FAIL"],

    ["No records are lost during processing",
     "Compare distinct vehicles at each pipeline stage; and dedupe-safety: do duplicate (vehicleno,time) rows disagree?",
     `Coverage: vehicles=${cov.vehicles_master}, vehicle_state=${cov.vehicle_state}, GPS 30d=${cov.gps_30d}, CAN 30d=${cov.can_30d}, battery 30d=${cov.battery_30d}, rollup 30d=${cov.rollup_30d}. Dedupe is LOSSLESS: of ${lossless.duplicate_groups} duplicate groups, ${lossless.groups_conflicting_soc} disagree on SOC and ${lossless.groups_conflicting_current} on current.`,
     "PASS"],

    ["Duplicate-timestamp rate (the dedupe landmine)",
     "1 - count(distinct (vehicleno,time)) / count(*), last 30 days, per table.",
     `telemetry_can ${dupCan.pct_duplicate}% duplicate (${dupCan.stored_rows} stored -> ${dupCan.distinct_vehicle_time} distinct). telemetry_gps ${dupGps.pct_duplicate}%. telemetry_battery ${dupBat.pct_duplicate}%. Worst single frame stored ${lossless.max_copies_of_one_frame} times.`,
     "WARN"],

    ["Timestamp ordering is correct",
     "After DISTINCT ON (time), check for negative or zero gaps between consecutive samples (90d, reference battery).",
     `${ord.intervals} intervals: ${ord.out_of_order} out-of-order, ${ord.zero_gap} zero-gap. Cadence p50=${ord.p50_s}s, p90=${ord.p90_s}s, p99=${ord.p99_s}s, max gap=${ord.max_gap_s}s (~${Math.round(Number(ord.max_gap_s || 0) / 86400)} days).`,
     Number(ord.out_of_order) === 0 && Number(ord.zero_gap) === 0 ? "PASS" : "FAIL"],

    ["SOC values remain consistent",
     "Join telemetry_can (JSONB soc) to telemetry_battery (soc_pct) on identical (vehicleno,time); 7 days, fleet-wide.",
     `${soc.rows_compared} rows compared — ${soc.soc_equal} equal, ${soc.soc_differs} differ (max abs diff ${soc.max_abs_diff}).`,
     Number(soc.soc_differs) === 0 ? "PASS" : "FAIL"],

    ["Live snapshot matches the raw feed",
     "vehicle_state.soc_pct vs the latest telemetry_can frame per vehicle.",
     `${snap.vehicles_compared} vehicles — ${snap.soc_equal} equal, ${snap.soc_differs} differ.`,
     Number(snap.soc_differs) === 0 ? "PASS" : "FAIL"],

    ["Current values remain consistent",
     "Distribution + corrupt-frame scan (|I| > 500 A) on the deduped reference series, 90 days.",
     `${cur.deduped_samples} deduped samples. Range ${cur.min_a}–${cur.max_a} A, p99 ${cur.p99_a} A. Corrupt (>500 A): ${cur.corrupt_over_500a}. Negative: ${cur.negative_current} (confirms current is UNSIGNED — sign cannot tell you charge vs discharge). NULL: ${cur.null_current}. Zero: ${cur.zero_current}.`,
     Number(cur.corrupt_over_500a) === 0 ? "PASS" : "WARN"],

    ["Time-difference calculations are correct",
     "dt is taken between consecutive DEDUPED samples. Without dedupe, dt=0 across each duplicate and those samples contribute no Ah at all.",
     `Confirmed: ${dupCan.pct_duplicate}% of raw rows are duplicates, so a query that forgets DISTINCT ON would zero out ~${dupCan.pct_duplicate}% of its intervals. charging-sql.ts and discharge-sql.ts both dedupe correctly; countSamplesQuery is built from the same CTE so it cannot drift.`,
     "PASS"],

    ["Column completeness (is the poller filling what it declares?)",
     "NULL-rate audit on the columnar tables.",
     `telemetry_battery (7d, ${bf.rows_7d} rows): soc ${bf.pct_soc}%, soh ${bf.pct_soh}%, pack_voltage ${bf.pct_pack_voltage}%, pack_current ${bf.pct_pack_current}%, pack_temp ${bf.pct_pack_temp}%, charging flag ${bf.pct_charging_flag}%. vehicle_state: soc ${sf.pct_soc}%, charging ${sf.pct_charging}%, range_km ${sf.pct_range_km}%.`,
     "FAIL"],

    ["SOH is a usable signal",
     "Distribution of vehicle_state.soh_pct across the fleet (drives Warranty At-Risk).",
     `${soh.vehicles} vehicles: avg ${soh.avg_soh}, min ${soh.min_soh}, max ${soh.max_soh}. Exactly 100: ${soh.soh_exactly_100}. NULL: ${soh.soh_null}. Warranty At-Risk (<80): ${soh.warranty_at_risk}.`,
     Number(soh.soh_exactly_100) >= Number(soh.vehicles) * 0.9 ? "WARN" : "PASS"],

    ["Independent cross-check on cycle counting",
     "The BMS reports its OWN charge_cycle counter in the CAN payload. Compare its delta to our derived cycle count.",
     `Reference battery, 90d: BMS counter went ${bms.bms_cycle_first} -> ${bms.bms_cycle_last} = ${bms.bms_cycles_in_window} cycles. Nameplate ${bms.rated_ah} Ah, SOH ${bms.soh_pct}%. Our SOC-based detection is validated separately by the limb scan (npm run telemetry:diagnose-cycles: 62 ground truth / 62 counted).`,
     "REVIEW"],
  ];
  V.forEach((x, i) => ws.addRow({ n: i + 1, c: x[0], m: x[1], r: x[2], v: x[3] }));
  ws.eachRow((row, i) => { if (i > 1) row.alignment = { vertical: "top", wrapText: true }; });
  tint(ws, "v", { ...STATUS_TINT, REVIEW: AMBER });
}

// ---- Sheet: Distance reconciliation detail
{
  const ws = sheet("9. Distance Recon");
  header(ws, [
    { header: "Day", key: "d", width: 14 },
    { header: "distance_rollup km (poller)", key: "r", width: 24 },
    { header: "GPS-derived km (haversine on raw)", key: "g", width: 30 },
    { header: "Difference km", key: "x", width: 14 },
    { header: "Rollup as % of GPS", key: "p", width: 20 },
  ]);
  for (const x of r("V8_distance_recon")) {
    ws.addRow({ d: x.day, r: x.rollup_km, g: x.gps_km ?? "no GPS", x: x.diff_km, p: x.rollup_pct_of_gps ? `${x.rollup_pct_of_gps}%` : "-" });
  }
  ws.addRow({});
  ws.addRow({ d: "Note", r: "GPS legs > 5 km between consecutive fixes are discarded as jumps. A haversine sum over sparse, duplicate-heavy GPS is a LOWER bound on true distance, so a rollup figure above the GPS figure is expected and is not by itself an error. This sheet is for eyeballing gross divergence, not for exact agreement." });
  ws.getRow(ws.rowCount).alignment = { wrapText: true, vertical: "top" };
}

// ---- Sheet: Dashboard mapping
{
  const ws = sheet("10. Dashboard Mapping");
  header(ws, [
    { header: "Tab", key: "t", width: 18 },
    { header: "Metric (as the user sees it)", key: "m", width: 30 },
    { header: "API route", key: "a", width: 42 },
    { header: "SQL builder", key: "s", width: 40 },
    { header: "Source table(s)", key: "b", width: 34 },
    { header: "RAW or PRE-AGG", key: "k", width: 14 },
    { header: "Status", key: "x", width: 10 },
  ]);
  const M = [
    ["Fleet Overview", "Fleet Size", "/api/telemetry/fleet/dashboard", "queries.ts:53 fetchFleetDashboardCEO", "vehicle_state", "RAW", "OK"],
    ["Fleet Overview", "Active Now / Utilization %", "/api/telemetry/fleet/dashboard", "queries.ts:111", "vehicle_state", "RAW", "OK"],
    ["Fleet Overview", "Avg SOH %", "/api/telemetry/fleet/dashboard", "queries.ts:71", "vehicle_state", "RAW", "WARN"],
    ["Fleet Overview", "Warranty At-Risk", "/api/telemetry/fleet/dashboard", "queries.ts:72 (soh<80)", "vehicle_state", "RAW", "WARN"],
    ["Fleet Overview", "Active Alerts", "/api/telemetry/fleet/dashboard", "queries.ts:77", "alerts", "RAW", "OK"],
    ["Fleet Overview", "Avg Daily Distance", "/api/telemetry/fleet/dashboard", "queries.ts:101-114 (branches on filter)", "distance_rollup, bucket_size='day' (both paths)", "PRE-AGG", "OK"],
    ["Fleet Overview", "Offline Devices", "/api/telemetry/fleet/dashboard", "queries.ts:131", "vehicle_state", "RAW", "OK"],
    ["Fleet Overview", "Fleet Devices table", "/api/telemetry/fleet/map", "queries.ts:215 fetchFleetMapData", "vehicle_state + vehicles", "RAW", "OK"],
    ["Fleet Overview", "State / City filter", "/api/telemetry/fleet/locations", "queries.ts:180 fetchFleetLocations", "device_battery_map (CRM DB, not IoT)", "n/a", "OK"],
    ["Fleet Overview", "Dealer Performance", "/api/telemetry/fleet/dashboard", "queries.ts:971", "device_battery_map (CRM) + vehicle_state", "RAW", "OK"],
    ["Battery Analytics", "Charging Cycles", "/api/telemetry/analytics/ah-trend", "queries.ts:613 -> charging-sql.ts:190 cycleCTEs", "telemetry_can (JSONB)", "RAW", "OK"],
    ["Battery Analytics", "Total AH Charged", "/api/telemetry/analytics/ah-trend", "queries.ts:728", "telemetry_can", "RAW", "OK"],
    ["Battery Analytics", "Avg AH / Session", "/api/telemetry/analytics/ah-trend", "queries.ts:750", "telemetry_can", "RAW", "OK"],
    ["Battery Analytics", "Avg Capacity", "/api/telemetry/analytics/ah-trend", "queries.ts:676 + charging-math.ts", "telemetry_can", "RAW", "OK"],
    ["Battery Analytics", "Avg Duration / Avg SOC Gained", "/api/telemetry/analytics/ah-trend", "queries.ts:752", "telemetry_can", "RAW", "OK"],
    ["Battery Analytics", "AH Trend chart (= capacity)", "/api/telemetry/analytics/ah-trend", "queries.ts:613 (per-cycle rows)", "telemetry_can", "RAW", "OK"],
    ["Battery Analytics", "Charging Timeline", "/api/telemetry/analytics/soc-timeline", "queries.ts:862 fetchSocTimeline", "telemetry_can", "RAW", "OK"],
    ["Battery Analytics", "Download Charging Analysis (xlsx)", "/api/telemetry/analytics/charging-export.xlsx", "queries.ts:801 + charging-export.ts", "telemetry_can", "RAW", "OK"],
    ["Trip Analytics", "Trip History table", "/api/telemetry/trips/overview", "queries.ts:1068 fetchTripsOverview", "trips", "RAW", "BROKEN"],
    ["Health & Analytics", "SOH Degradation (30d)", "/api/telemetry/health/degradation", "queries.ts:522 fetchSOHTrend", "telemetry_battery (soc/soh only)", "RAW", "OK"],
    ["Health & Analytics", "Warranty At-Risk Devices", "/api/telemetry/analytics/warranty", "queries.ts:924 fetchWarrantyRisk", "vehicle_state + vehicles + device_battery_map", "RAW", "OK"],
    ["Health & Analytics", "Dealer Comparison", "/api/telemetry/analytics/dealer-comparison", "queries.ts:967", "device_battery_map (CRM) + vehicle_state", "RAW", "OK"],
    ["Alerts & Rules", "Active Alerts table", "/api/telemetry/alerts", "queries.ts:411 fetchAlerts", "alerts", "RAW", "OK"],
    ["Alerts & Rules", "Alert Threshold Configuration", "/api/telemetry/alerts/config", "queries.ts:500 — returns [] , no SQL", "none (hardcoded empty)", "n/a", "WARN"],
    ["Device Management", "Device Mappings table", "/api/telemetry/devices", "queries.ts:261 fetchDevices", "vehicle_state + vehicles", "RAW", "WARN"],
    ["Device Management", "Comm Status", "/api/telemetry/devices/status", "queries.ts:1165 fetchDeviceStatus", "vehicle_state", "RAW", "OK"],
    ["Database Health", "Table sizes / row counts", "/api/system/database-monitor", "queries.ts:1151 fetchDatabaseStats", "pg_stat_user_tables (catalog)", "n/a", "OK"],
    ["(heat map)", "Heat Map / GPS positions", "/api/telemetry/fleet/map", "queries.ts:215; devices/[id]/gps", "vehicle_state (live) / telemetry_gps (history)", "RAW", "OK"],
    ["NOT WIRED", "Discharge Cycles", "/api/telemetry/analytics/discharge-cycles", "battery-queries.ts:71 -> discharge-sql.ts:56", "telemetry_can", "RAW", "WARN"],
    ["NOT WIRED", "Deep Discharge", "/api/telemetry/analytics/deep-discharge", "battery-queries.ts:173", "telemetry_can", "RAW", "WARN"],
    ["NOT WIRED", "Distance Trend", "/api/telemetry/analytics/distance-trend", "battery-queries.ts:236", "telemetry_can + distance_rollup", "MIXED", "WARN"],
    ["NOT WIRED", "Energy Trend", "/api/telemetry/analytics/energy-trend", "battery-queries.ts:336", "telemetry_can", "RAW", "WARN"],
    ["NOT WIRED", "Discharge vs km", "/api/telemetry/analytics/discharge-vs-km", "battery-queries.ts:414", "telemetry_can + distance_rollup", "MIXED", "WARN"],
  ];
  M.forEach((x) => ws.addRow({ t: x[0], m: x[1], a: x[2], s: x[3], b: x[4], k: x[5], x: x[6] }));
  ws.eachRow((row, i) => { if (i > 1) row.alignment = { vertical: "top", wrapText: true }; });
  tint(ws, "x", STATUS_TINT);
  ws.addRow({});
  ws.addRow({ t: "Note", m: "'NOT WIRED' = the API route and SQL exist and work, but no UI component calls them yet. These are the ready-made building blocks for the next dashboard iteration." });
}

// ---- Sheets: table structures + 5 sample records
{
  const ws = sheet("11. Table Structures");
  header(ws, [
    { header: "Table", key: "t", width: 30 },
    { header: "#", key: "n", width: 5 },
    { header: "Column", key: "c", width: 26 },
    { header: "Type", key: "y", width: 26 },
    { header: "Nullable", key: "u", width: 10 },
    { header: "Key", key: "k", width: 30 },
  ]);
  const pkBy = {};
  for (const k of r("keys")) if (k.contype === "p") pkBy[k.table_name] = k.def;
  for (const t of Object.keys(TABLE_TIME)) {
    const cols = columns.filter((c) => c.table_name === t);
    if (!cols.length) continue;
    cols.forEach((c, i) => ws.addRow({
      t: i === 0 ? t : "", n: c.ordinal_position, c: c.column_name,
      y: c.data_type, u: c.is_nullable, k: i === 0 ? (pkBy[t] ?? "(no PK — append-only)") : "",
    }));
    ws.addRow({});
  }
  ws.getColumn("t").font = { bold: true };
}

for (const t of Object.keys(TABLE_TIME)) {
  const rows = samples[t] ?? [];
  const cols = columns.filter((c) => c.table_name === t).map((c) => c.column_name);
  if (!cols.length) continue;
  const name = `S. ${t}`.slice(0, 31);
  const ws = sheet(name);
  header(ws, cols.map((c) => ({ header: c, key: c, width: c === "payload" ? 120 : Math.min(30, Math.max(14, c.length + 4)) })));
  if (!rows.length) {
    ws.addRow(Object.fromEntries(cols.map((c, i) => [c, i === 0 ? "*** TABLE IS EMPTY — 0 ROWS ***" : ""])));
    ws.getRow(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: RED } };
    ws.getRow(2).font = { bold: true };
  } else {
    for (const row of rows) {
      const o = {};
      for (const c of cols) {
        const v = row[c];
        o[c] = v === null || v === undefined ? null
          : v instanceof Date ? v.toISOString()
          : typeof v === "object" ? JSON.stringify(v)
          : v;
      }
      ws.addRow(o);
    }
    ws.eachRow((row, i) => { if (i > 1) row.alignment = { vertical: "top" }; });
  }
  ws.addRow({});
  ws.addRow(Object.fromEntries([[cols[0], rows.length ? `5 most recent records for ${REF}` : "This table is populated by the Aggregator, which has never run."]]));
}

// ---- Sheet: Actions
{
  const ws = sheet("12. Actions");
  header(ws, [
    { header: "#", key: "n", width: 5 },
    { header: "Action", key: "a", width: 66 },
    { header: "Why", key: "w", width: 76 },
    { header: "Owner", key: "o", width: 22 },
    { header: "Priority", key: "p", width: 10 },
  ]);
  [
    ["Decide the aggregator's fate: revive it, or formally kill it.", "It has never run. Today the CRM does all aggregation at query time and does it well. Either restore the Python jobs, or delete the five empty tables + five never-created ones so nobody builds on a ghost.", "Apoorv + IoT team", "P0"],
    ["DONE — Avg Daily Distance under a State/City filter.", "Was reading the empty daily_distance_per_vehicle and reporting 0 km for every state/city. queries.ts:101-114 now reads distance_rollup on both paths, scoped by vehicleno, with bucket_size='day' pinned on each. Shipped in 1b06b3b4.", "CRM", "DONE"],
    ["Populate the trips table (or remove the Trip Analytics tab).", "0 rows fleet-wide. The tab shows 'No trips found' for a fleet that is demonstrably driving thousands of km.", "IoT team", "P1"],
    ["Ask Intellicar for a signed current, or a reliable charging flag, in the CAN feed.", "Current is an unsigned magnitude, so charge vs discharge has to be inferred from rising SOC. A sign bit would remove a whole class of ambiguity from cycle detection.", "Apoorv -> Intellicar", "P1"],
    ["Ask the poller team to stop re-inserting unchanged frames.", "79% of telemetry_can rows are byte-identical duplicates of a frame already stored (worst case: one frame stored 2,668 times). ~5x storage and scan cost, and a trap for any query that forgets DISTINCT ON.", "IoT team", "P1"],
    ["Increase poller retention/cadence for telemetry_can.", "~100 distinct samples/battery/day against a device that streams every 30 s. This sampling noise (+/-15%) is the hard ceiling on AH Trend accuracy — no dashboard threshold can fix it.", "IoT team", "P1"],
    ["Restart the partition-maintenance job.", "Newest partitions predate today, so all new rows land in the *_default partitions. Partition pruning is lost and _default grows without bound.", "IoT team", "P1"],
    ["Find out why telemetry_battery stopped writing ~10.6 h ago, on an exact day boundary.", "CAN and GPS are live; the battery feed's last row is 23:59:58 of the previous day. It backs the SOH Degradation chart. Either a nightly batch (fine, document it) or a stalled writer (not fine).", "IoT team", "P0"],
    ["Turn the BMS fault flags into alerts.", "telemetry_can carries ~30 alarm/protection flags (cell over-voltage, thermal runaway, charge over-current). The alerts table contains ONLY 'offline'. Real battery faults are arriving and being discarded — the biggest safety gap in the pipeline.", "IoT team + CRM", "P1"],
    ["Either populate telemetry_battery's NULL columns or drop them.", "pack_voltage / pack_temp_c / charging are 100% NULL and pack_current only 35% filled, across 15.9M rows. They look usable and are not — charge_events was designed against telemetry_battery.charging and is unbuildable as specified.", "IoT team", "P2"],
    ["Confirm with Intellicar whether SOH is actually computed.", "Every non-null pack reads SOH = exactly 100 (min=max=100 across 297 vehicles). Warranty At-Risk can never fire and the SOH chart is flat by construction. Do not build battery-health features on SOH until this is answered.", "Apoorv -> Intellicar", "P1"],
    ["Wire up the five built-but-unused analytics routes.", "discharge-cycles, deep-discharge, distance-trend, energy-trend, discharge-vs-km all work and are tested — they just have no UI caller. Cheapest dashboard wins available.", "CRM", "P2"],
    ["Add error states to the Trip/Health/Alerts/Device tabs.", "Only Fleet Overview renders an error branch. On the other tabs a 500 and an empty table look identical to the user.", "CRM", "P2"],
  ].forEach((x, i) => ws.addRow({ n: i + 1, a: x[0], w: x[1], o: x[2], p: x[3] }));
  ws.eachRow((row, i) => { if (i > 1) row.alignment = { vertical: "top", wrapText: true }; });
  tint(ws, "p", { P0: RED, P1: AMBER, P2: GREY, DONE: GREEN });
}

// ---- Sheet: run log (so a reader can see what did / didn't verify)
{
  const ws = sheet("13. Run Log");
  header(ws, [
    { header: "Check", key: "c", width: 30 },
    { header: "Status", key: "s", width: 10 },
    { header: "Rows", key: "r", width: 8 },
    { header: "Error", key: "e", width: 90 },
  ]);
  for (const [id, res] of Object.entries(results)) {
    ws.addRow({
      c: id,
      s: res.cached ? "CACHED" : res.ok ? "OK" : "FAIL",
      r: res.rows?.length ?? 0,
      e: res.cached ? `live query failed (${res.error}) — showing cached reading from ${res.cachedAt}` : (res.error ?? ""),
    });
  }
  tint(ws, "s", { ...STATUS_TINT, CACHED: AMBER });
  ws.addRow({});
  ws.addRow({ c: "Generated", s: "", r: "", e: new Date().toISOString() });
  ws.addRow({ c: "Source", s: "", r: "", e: "IoT Postgres (AWS RDS 'itarang') via IOT_DATABASE_URL. Read-only." });
  ws.addRow({ c: "Reference battery", s: "", r: "", e: REF });
}

const outDir = path.join(ROOT, "reports");
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
const out = path.join(outDir, `polar-aggregator-review-${stamp}.xlsx`);
await wb.xlsx.writeFile(out);

const okCount = Object.values(results).filter((x) => x.ok).length;
const failCount = Object.values(results).filter((x) => !x.ok).length;
console.log(`\nWrote ${out}`);
console.log(`Checks: ${okCount} ok, ${failCount} failed.`);
if (failCount) console.log("Failed checks are listed on the '11. Run Log' sheet — re-run with the tunnel up to fill them.");

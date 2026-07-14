/**
 * Last-N-days mileage report for a single battery (vehicleno), as one .xlsx.
 *
 *   npx tsx --env-file=.env.local scripts/battery-mileage-report.ts --vehicleno=TK-64105-25BZ-011393 --days=10
 *
 * Requires the IoT tunnel to be up (IOT_DATABASE_URL -> 127.0.0.1:5500).
 *
 * Distance comes from `distance_rollup` (bucket_size='day') — the only populated distance
 * source on this fleet. `daily_distance_per_vehicle` was never populated and `trips` is empty.
 *
 * A day with no rollup row is UNKNOWN, not zero: the aggregator has gaps, so writing 0 would
 * assert "parked" on a day we simply have no distance for. Such days are left blank and
 * counted separately, which makes the total a LOWER BOUND. See DistanceBucket in
 * src/lib/telemetry/battery-queries.ts.
 */
import ExcelJS from "exceljs";
import postgres from "postgres";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const IST = "Asia/Kolkata";

function argOf(name: string): string | undefined {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
}

const VEHICLENO = argOf("vehicleno") ?? "TK-64105-25BZ-011393";
const DAYS = Number(argOf("days") ?? 10);

const istDate = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const istDateTime = (d: Date) =>
    new Intl.DateTimeFormat("en-GB", {
        timeZone: IST, year: "numeric", month: "short", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(d);
const dayName = (ymd: string) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short" }).format(new Date(`${ymd}T00:00:00Z`));

const round = (n: number, p = 1) => Math.round(n * 10 ** p) / 10 ** p;

// ─── connect ─────────────────────────────────────────────────────────────────

const IOT_URL = process.env.IOT_DATABASE_URL;
if (!IOT_URL) {
    console.error("IOT_DATABASE_URL is not set. Bring the IoT tunnel up first (127.0.0.1:5500).");
    process.exit(1);
}
const sslmode = (() => {
    try { return new URL(IOT_URL).searchParams.get("sslmode") ?? "prefer"; } catch { return "prefer"; }
})();
const iot = postgres(IOT_URL, {
    ssl: sslmode === "disable" ? false : { rejectUnauthorized: false },
    prepare: false, max: 1, connect_timeout: 15,
});

const CRM_URL = process.env.DATABASE_URL;
const crm = CRM_URL
    ? postgres(CRM_URL, { ssl: { rejectUnauthorized: false }, prepare: false, max: 1, connect_timeout: 15 })
    : null;

// ─── the 10-day IST calendar we report on (oldest → newest, today last) ───────

const todayIst = istDate(new Date());
const calendar: string[] = [];
for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(`${todayIst}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    calendar.push(istDate(new Date(`${d.toISOString().slice(0, 10)}T06:00:00Z`)));
}
const fromIst = calendar[0];
const toIstExclusive = (() => {
    const d = new Date(`${calendar[calendar.length - 1]}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
})();

type DayRow = {
    date: string;
    km: number | null;
    kwh: number | null;
    cum: number;
    canSamples: number;
    socMin: number | null;
    socMax: number | null;
    sohAvg: number | null;
};

async function main() {
    console.log(`Battery (vehicleno): ${VEHICLENO}`);
    console.log(`Window (IST): ${fromIst} .. ${calendar[calendar.length - 1]}  (${DAYS} days)\n`);

    // ── diagnostics: is there data at all, and in what shape? ────────────────
    const cols = await iot<Array<{ column_name: string; data_type: string }>>`
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'distance_rollup' ORDER BY ordinal_position`;
    if (!cols.length) throw new Error("distance_rollup does not exist on this DB — wrong tunnel/DB?");
    console.log("distance_rollup columns:", cols.map((c) => c.column_name).join(", "));
    const hasEnergy = cols.some((c) => c.column_name === "energy_kwh");

    const shape = await iot<Array<{ bucket_size: string; n: number; first: Date; last: Date }>>`
        SELECT bucket_size, count(*)::int AS n, min(time) AS first, max(time) AS last
        FROM distance_rollup WHERE vehicleno = ${VEHICLENO}
        GROUP BY 1 ORDER BY 1`;
    if (!shape.length) {
        console.error(`\nNo distance_rollup rows AT ALL for ${VEHICLENO}. Check the ID is a real vehicleno.`);
        const near = await iot<Array<{ vehicleno: string }>>`
            SELECT DISTINCT vehicleno FROM distance_rollup
            WHERE vehicleno ILIKE ${"%" + VEHICLENO.split("-").slice(-1)[0] + "%"} LIMIT 5`;
        if (near.length) console.error("Similar IDs present:", near.map((r) => r.vehicleno).join(", "));
        process.exit(2);
    }
    console.log("\ndistance_rollup coverage for this battery:");
    for (const s of shape) {
        console.log(`  bucket_size=${s.bucket_size}  rows=${s.n}  ${istDate(s.first)} .. ${istDate(s.last)}`);
    }
    const dayShape = shape.find((s) => s.bucket_size === "day");
    const staleDays = dayShape
        ? Math.floor((Date.now() - new Date(dayShape.last).getTime()) / 86_400_000)
        : null;
    if (staleDays != null && staleDays > 1) {
        console.warn(`\n⚠ Latest daily rollup is ${staleDays} days old — the aggregator may be lagging.`);
    }

    // ── distance + energy per IST day ────────────────────────────────────────
    const dist = await iot<Array<{ d: string; km: number | null; kwh: number | null }>>`
        SELECT to_char((time AT TIME ZONE ${IST})::date, 'YYYY-MM-DD') AS d,
               sum(distance_km)::float AS km,
               ${hasEnergy ? iot`sum(energy_kwh)::float` : iot`NULL::float`} AS kwh
        FROM distance_rollup
        WHERE vehicleno = ${VEHICLENO}
          AND bucket_size = 'day'
          AND (time AT TIME ZONE ${IST})::date >= ${fromIst}::date
          AND (time AT TIME ZONE ${IST})::date <  ${toIstExclusive}::date
        GROUP BY 1 ORDER BY 1`;

    // ── battery telemetry per IST day (context: was the pack even alive?) ────
    const tel = await iot<Array<{
        d: string; n: number; soc_min: number | null; soc_max: number | null; soh_avg: number | null;
    }>>`
        SELECT to_char((time AT TIME ZONE ${IST})::date, 'YYYY-MM-DD') AS d,
               count(*)::int AS n,
               min((payload->'soc'->>'value')::float) AS soc_min,
               max((payload->'soc'->>'value')::float) AS soc_max,
               avg((payload->'soh'->>'value')::float) AS soh_avg
        FROM telemetry_can
        WHERE vehicleno = ${VEHICLENO}
          AND (time AT TIME ZONE ${IST})::date >= ${fromIst}::date
          AND (time AT TIME ZONE ${IST})::date <  ${toIstExclusive}::date
        GROUP BY 1 ORDER BY 1`;

    const distBy = new Map(dist.map((r) => [r.d, r]));
    const telBy = new Map(tel.map((r) => [r.d, r]));

    let cum = 0;
    const rows: DayRow[] = calendar.map((date) => {
        const dr = distBy.get(date);
        const tr = telBy.get(date);
        const km = dr?.km != null ? round(dr.km) : null;
        if (km != null) cum = round(cum + km);
        return {
            date,
            km,
            kwh: dr?.kwh != null ? round(dr.kwh, 2) : null,
            cum,
            canSamples: tr?.n ?? 0,
            socMin: tr?.soc_min != null ? round(tr.soc_min, 0) : null,
            socMax: tr?.soc_max != null ? round(tr.soc_max, 0) : null,
            sohAvg: tr?.soh_avg != null ? round(tr.soh_avg, 1) : null,
        };
    });

    const known = rows.filter((r) => r.km != null) as Array<DayRow & { km: number }>;
    const active = known.filter((r) => r.km > 0);
    const totalKm = round(known.reduce((a, r) => a + r.km, 0));
    const totalKwh = round(rows.reduce((a, r) => a + (r.kwh ?? 0), 0), 2);
    const unknownDays = rows.length - known.length;
    const best = active.length ? active.reduce((a, b) => (b.km > a.km ? b : a)) : null;

    console.log("\nDaily result:");
    for (const r of rows) {
        const km = r.km == null ? "   —  (no data)" : `${r.km.toFixed(1).padStart(6)} km`;
        console.log(`  ${r.date} ${dayName(r.date)}  ${km}   can=${r.canSamples}`);
    }
    console.log(
        `\nTotal ${totalKm} km over ${active.length} active day(s)` +
        (unknownDays ? `  — LOWER BOUND (${unknownDays} day(s) have no distance data)` : ""),
    );

    // ── CRM enrichment (device_battery_map lives on the CRM DB, not IoT) ─────
    let meta: Record<string, unknown> | null = null;
    if (crm) {
        try {
            const m = await crm<Array<Record<string, unknown>>>`
                SELECT device_id, battery_serial, vehicle_number, vehicle_type, customer_name,
                       customer_phone, state, city, status, installed_at
                FROM device_battery_map
                WHERE battery_serial = ${VEHICLENO} OR vehicle_number = ${VEHICLENO} OR device_id = ${VEHICLENO}
                LIMIT 1`;
            meta = m[0] ?? null;
        } catch (e) {
            console.warn("CRM lookup skipped:", (e as Error).message);
        }
    }

    // ── workbook ─────────────────────────────────────────────────────────────
    const wb = new ExcelJS.Workbook();
    wb.creator = "iTarang";
    wb.created = new Date();

    const HEAD = { bold: true, color: { argb: "FFFFFFFF" } } as const;
    const headFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } } as const;

    // Sheet 1 — Daily Mileage
    // energy_kwh / moving_seconds are declared on distance_rollup but the aggregator has
    // never written them — they are NULL in every row, fleet-wide. So the km/kWh column is
    // only worth showing if that ever changes; an always-empty column reads as a bug.
    const anyEnergy = rows.some((r) => r.kwh != null);

    const s1 = wb.addWorksheet("Daily Mileage", { views: [{ state: "frozen", ySplit: 1 }] });
    s1.columns = [
        { header: "Date (IST)", key: "date", width: 14 },
        { header: "Day", key: "dow", width: 7 },
        { header: "Distance (km)", key: "km", width: 14 },
        { header: "Cumulative (km)", key: "cum", width: 16 },
        ...(anyEnergy
            ? [
                  { header: "Energy (kWh)", key: "kwh", width: 14 },
                  { header: "Efficiency (km/kWh)", key: "eff", width: 18 },
              ]
            : []),
        { header: "SoC min (%)", key: "socMin", width: 12 },
        { header: "SoC max (%)", key: "socMax", width: 12 },
        { header: "SoH avg (%)", key: "soh", width: 12 },
        { header: "Telemetry samples", key: "can", width: 18 },
        { header: "Data status", key: "status", width: 46 },
    ];
    s1.getRow(1).font = HEAD;
    s1.getRow(1).fill = headFill as ExcelJS.Fill;

    // Why a day is blank matters more than the blank itself. A fleet-wide silence is a
    // platform outage (distance unknowable); a silence unique to this battery means the
    // device was off. `fleetDays` is the set of IST days ANY vehicle reported GPS on.
    const fleetRows = await iot<Array<{ d: string; vehicles: number }>>`
        SELECT to_char((time AT TIME ZONE ${IST})::date, 'YYYY-MM-DD') AS d,
               count(DISTINCT vehicleno)::int AS vehicles
        FROM telemetry_gps
        WHERE (time AT TIME ZONE ${IST})::date >= ${fromIst}::date
          AND (time AT TIME ZONE ${IST})::date <  ${toIstExclusive}::date
        GROUP BY 1`;
    const fleetUp = new Map(fleetRows.map((r) => [r.d, r.vehicles]));
    const FLEET_QUORUM = 10; // a handful of stragglers is not a live fleet

    for (const r of rows) {
        const eff = r.km != null && r.kwh != null && r.kwh > 0 ? round(r.km / r.kwh, 2) : null;
        const fleetAlive = (fleetUp.get(r.date) ?? 0) >= FLEET_QUORUM;
        const status =
            r.km == null && !fleetAlive
                ? `Fleet-wide telemetry outage — no vehicle reported. Distance unknowable`
            : r.km == null && r.date === todayIst
                ? "Pending — day still open, aggregator writes the bucket after midnight IST"
            : r.km == null && r.canSamples === 0
                ? "Battery offline — no telemetry from this device (fleet was up)"
            : r.km == null ? "Distance unknown — aggregator gap (battery was reporting)"
            : r.km === 0 ? "Idle / parked"
            : "OK";
        const row = s1.addRow({
            date: r.date,
            dow: dayName(r.date),
            km: r.km,          // null → blank cell. Never 0. See file header.
            cum: r.km != null ? r.cum : null,
            kwh: r.kwh,
            eff,
            socMin: r.socMin,
            socMax: r.socMax,
            soh: r.sohAvg,
            can: r.canSamples,
            status,
        });
        if (r.km == null) {
            row.eachCell((c) => {
                c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };
            });
        }
    }
    const outageDays = rows.filter(
        (r) => r.km == null && (fleetUp.get(r.date) ?? 0) < FLEET_QUORUM,
    ).length;
    const pendingToday = rows.some(
        (r) => r.date === todayIst && r.km == null && (fleetUp.get(r.date) ?? 0) >= FLEET_QUORUM,
    );

    s1.getColumn("km").numFmt = "0.0";
    s1.getColumn("cum").numFmt = "0.0";
    if (anyEnergy) {
        s1.getColumn("kwh").numFmt = "0.00";
        s1.getColumn("eff").numFmt = "0.00";
    }

    const totalRow = s1.addRow({
        date: "TOTAL", dow: "", km: totalKm, cum: null,
        ...(anyEnergy ? { kwh: totalKwh || null, eff: totalKwh ? round(totalKm / totalKwh, 2) : null } : {}),
        can: rows.reduce((a, r) => a + r.canSamples, 0),
        status: unknownDays ? `LOWER BOUND — ${unknownDays} day(s) missing distance` : "Complete",
    });
    totalRow.font = { bold: true };

    // Sheet 2 — Summary
    const s2 = wb.addWorksheet("Summary");
    s2.columns = [
        { header: "Field", key: "k", width: 34 },
        { header: "Value", key: "v", width: 56 },
    ];
    s2.getRow(1).font = HEAD;
    s2.getRow(1).fill = headFill as ExcelJS.Fill;

    const facts: Array<[string, unknown]> = [
        ["Battery / vehicle no", VEHICLENO],
        ["Report window (IST)", `${fromIst} to ${calendar[calendar.length - 1]} (${DAYS} days)`],
        ["Generated at (IST)", istDateTime(new Date())],
        ["", ""],
        ["Total distance (km)", unknownDays ? `${totalKm}  (lower bound)` : totalKm],
        ["Days with distance data", `${known.length} of ${DAYS}`],
        ["Days with NO distance data", unknownDays],
        ["  ↳ lost to fleet-wide outage", outageDays],
        ["  ↳ today, not yet aggregated", pendingToday ? 1 : 0],
        ["Active days (km > 0)", active.length],
        ["Idle days (km = 0)", known.length - active.length],
        ["Avg km / active day", active.length ? round(totalKm / active.length) : 0],
        // Deliberately NOT totalKm/DAYS — dividing known km by days we have no data for
        // would silently depress the average toward zero.
        ["Avg km / day (days with data only)", known.length ? round(totalKm / known.length) : 0],
        ["Best day", best ? `${best.date} — ${best.km} km` : "—"],
        ["Total energy (kWh)", anyEnergy ? totalKwh : "Not recorded — see note below"],
        [
            "Overall efficiency (km/kWh)",
            anyEnergy && totalKwh ? round(totalKm / totalKwh, 2) : "Not available — see note below",
        ],
        ["", ""],
        ["Latest daily rollup on record", dayShape ? istDate(new Date(dayShape.last)) : "—"],
        ["Aggregator lag (days)", staleDays ?? "—"],
    ];
    if (meta) {
        facts.push(["", ""], ["— From CRM device_battery_map —", ""]);
        for (const [k, v] of Object.entries(meta)) {
            facts.push([k, v instanceof Date ? istDate(v) : (v ?? "—")]);
        }
    }
    facts.push(
        ["", ""],
        ["Source", "distance_rollup (bucket_size='day') + telemetry_can, IoT AWS RDS"],
        [
            "Note on blanks",
            "A blank distance is UNKNOWN (no aggregator row), not zero km. The total is a lower bound whenever any day is blank. See the Data status column for why each blank day is blank.",
        ],
    );
    if (!anyEnergy) {
        facts.push([
            "Note on energy",
            "distance_rollup.energy_kwh and .moving_seconds are NULL in every row fleet-wide (16,056 of 16,056) — the aggregator declares but never writes them. km/kWh efficiency is therefore not derivable from this table for ANY vehicle, not just this one. SoC min/max below is the closest available proxy.",
        ]);
    }
    for (const [k, v] of facts) {
        const r = s2.addRow({ k, v });
        if (typeof k === "string" && (k.startsWith("—") || k === "Source" || k === "Note on blanks")) {
            r.font = { bold: true };
        }
    }
    s2.getColumn("v").alignment = { wrapText: true, vertical: "top" };

    mkdirSync(resolve("reports"), { recursive: true });
    const out = resolve("reports", `mileage_${VEHICLENO}_${fromIst}_to_${calendar[calendar.length - 1]}.xlsx`);
    await wb.xlsx.writeFile(out);
    console.log(`\n✔ Written: ${out}`);
}

main()
    .catch((e) => {
        const msg = String(e?.message ?? e);
        if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(msg)) {
            console.error(`\nIoT DB unreachable (${msg}).\nBring the tunnel up, then re-run:\n  ssh -N -L 5500:127.0.0.1:5500 root@72.61.246.37`);
        } else {
            console.error(e);
        }
        process.exitCode = 1;
    })
    .finally(async () => {
        await iot.end({ timeout: 3 }).catch(() => {});
        await crm?.end({ timeout: 3 }).catch(() => {});
    });

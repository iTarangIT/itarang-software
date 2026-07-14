/**
 * Charging-cycle detection diagnostic.
 *
 *   npm run telemetry:diagnose-cycles
 *   npm run telemetry:diagnose-cycles -- --vehicleno=TK-xxx --months=6 --sweep --csv
 *
 * Answers one question: does cycleCTEs() find the charges that actually happened?
 *
 * It imports the *production* definition (cycleCTEs, and the gates from
 * charging-math) rather than restating it, so what it measures is what the
 * dashboard runs. The one thing it deliberately does NOT reuse is the ground
 * truth in §2: a limb scan over the raw SOC series, written from scratch, so the
 * rule under test cannot mark its own homework.
 *
 * Needs the IoT tunnel up (IOT_DATABASE_URL -> 127.0.0.1:5500).
 */
import postgres from "postgres";
import {
    COVERAGE_TRUST_GAP_S,
    MAX_VALID_CURRENT_A,
    MIN_CYCLE_SAMPLES,
    MIN_CYCLE_SOC_GAIN,
    SESSION_GAP_MAX_S,
    CAPACITY_SOC_THRESHOLD,
    MIN_COVERAGE_PCT,
    capacityPlausible,
    extrapolateCapacity,
} from "@/lib/telemetry/charging-math";
import { buildTimeWindow, cycleCTEs, type IotSql } from "@/lib/telemetry/charging-sql";
import { dischargeCTEs, deepDischargeCTEs } from "@/lib/telemetry/discharge-sql";
import {
    DEEP_DISCHARGE_ENTER_PCT,
    DEEP_DISCHARGE_EXIT_PCT,
    MIN_DISCHARGE_SOC_DROP,
    socDerivedAh,
} from "@/lib/telemetry/discharge-math";

// ─── args ────────────────────────────────────────────────────────────────────

const argOf = (name: string) =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const has = (name: string) => process.argv.includes(`--${name}`);

const VEHICLENO = argOf("vehicleno") ?? "TK-51105-02DZ-213416";
const MONTHS = Number(argOf("months") ?? 6);
const WANT_SWEEP = has("sweep");
const WANT_CSV = has("csv");

/** The limb scan's tolerance: SOC is quantised to whole percent, so a lone ±1 is noise. */
const LIMB_JITTER_PCT = 1;

/**
 * The limb scan splits the SOC series only across a telemetry blackout this long.
 *
 * Deliberately NOT SESSION_GAP_MAX_S. The limb scan is the ground truth the production
 * rule is measured against, so it must not move when that rule's gates are tuned — a
 * yardstick that stretches with the thing it measures reports every value as correct.
 * 6 h is long enough that no single charge spans it, short enough to cut a real outage.
 */
const LIMB_BREAK_GAP_S = 6 * 3600;

// ─── connect ─────────────────────────────────────────────────────────────────

const URL_ = process.env.IOT_DATABASE_URL;
if (!URL_) {
    console.error("IOT_DATABASE_URL is not set. Bring the IoT tunnel up first.");
    process.exit(1);
}
const sslmode = (() => {
    try {
        return new URL(URL_).searchParams.get("sslmode") ?? "prefer";
    } catch {
        return "prefer";
    }
})();
const iot = postgres(URL_, {
    ssl: sslmode === "disable" ? false : { rejectUnauthorized: false },
    prepare: false,
    max: 1,
    connect_timeout: 15,
}) as unknown as IotSql;

// ─── helpers ─────────────────────────────────────────────────────────────────

/** postgres.js hands back numeric/EXTRACT columns as strings. Coerce everything. */
const n = (v: unknown): number | null =>
    v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const n0 = (v: unknown): number => n(v) ?? 0;

const fmt = (d: Date | string | null) =>
    d == null ? "—" : new Date(d).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

const dur = (s: number | null) => {
    if (s == null || !Number.isFinite(s)) return "—";
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return `${h}h${String(m).padStart(2, "0")}m`;
};

const pct = (x: number | null, digits = 1) => (x == null ? "—" : x.toFixed(digits));
const rule = (c = "─") => console.log(c.repeat(96));
const head = (t: string) => {
    console.log("");
    rule("═");
    console.log(t);
    rule("═");
};

// ─── the query surface ───────────────────────────────────────────────────────

interface Sample {
    time: Date;
    soc_pct: number;
    pack_current: number | null;
    dsoc: number | null;
    dt_s: number | null;
    ah_term: number;
    in_sess: number;
    break_id: number;
    in_cycle: boolean;
    cyc_first: Date | null;
    cyc_last: Date | null;
}

interface RawCycle {
    break_id: number;
    start_time: Date;
    end_time: Date;
    duration_s: number | null;
    ah_charged: number | null;
    start_soc: number | null;
    end_soc: number | null;
    avg_charging_current: number | null;
    max_charging_current: number | null;
    coverage_pct: number | null;
    n_samples: number;
    n_current_samples: number;
    rated_capacity_ah: number | null;
    is_valid: boolean;
}

const { timePredicate } = buildTimeWindow(iot, { months: MONTHS });
const cte = () => cycleCTEs(iot, VEHICLENO, timePredicate);

async function main() {
    // ── §1 Provenance ────────────────────────────────────────────────────────
    head(`§1  PROVENANCE`);
    console.log(`vehicle : ${VEHICLENO}`);
    console.log(`window  : last ${MONTHS} months`);

    const [counts] = (await iot`
        SELECT count(*)::int AS raw_rows,
               count(DISTINCT time)::int AS distinct_rows
        FROM telemetry_can
        WHERE vehicleno = ${VEHICLENO}
          AND payload->'soc'->>'value' IS NOT NULL
          ${timePredicate}
    `) as unknown as Array<{ raw_rows: number; distinct_rows: number }>;

    const rawRows = n0(counts?.raw_rows);
    const distinctRows = n0(counts?.distinct_rows);
    const dupPct = rawRows > 0 ? ((1 - distinctRows / rawRows) * 100) : 0;
    console.log(`rows    : ${rawRows} raw -> ${distinctRows} distinct timestamps  (${dupPct.toFixed(1)}% duplicates)`);

    const [cad] = (await iot`
        WITH d AS (
            SELECT DISTINCT ON (time) time FROM telemetry_can
            WHERE vehicleno = ${VEHICLENO} AND payload->'soc'->>'value' IS NOT NULL ${timePredicate}
            ORDER BY time
        ), g AS (
            SELECT EXTRACT(EPOCH FROM (time - LAG(time) OVER (ORDER BY time))) AS gap FROM d
        )
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) AS p50,
               percentile_cont(0.9) WITHIN GROUP (ORDER BY gap) AS p90,
               max(gap) AS gmax
        FROM g WHERE gap IS NOT NULL
    `) as unknown as Array<{ p50: string; p90: string; gmax: string }>;
    console.log(
        `cadence : median ${dur(n(cad?.p50))} | p90 ${dur(n(cad?.p90))} | max ${dur(n(cad?.gmax))}  (distinct samples)`,
    );
    console.log("");
    console.log("gates in force:");
    console.log(`  SESSION_GAP_MAX_S      ${SESSION_GAP_MAX_S}`);
    console.log(`  MIN_CYCLE_SOC_GAIN     ${MIN_CYCLE_SOC_GAIN}`);
    console.log(`  MIN_CYCLE_SAMPLES      ${MIN_CYCLE_SAMPLES}`);
    console.log(`  CAPACITY_SOC_THRESHOLD ${CAPACITY_SOC_THRESHOLD}`);
    console.log(`  MIN_COVERAGE_PCT       ${MIN_COVERAGE_PCT}`);
    console.log(`  COVERAGE_TRUST_GAP_S   ${COVERAGE_TRUST_GAP_S}`);
    console.log(`  MAX_VALID_CURRENT_A    ${MAX_VALID_CURRENT_A}`);

    // ── pull every annotated sample once; §2/§5/§8 all work off this ─────────
    const rows = (await iot`
        ${cte()}
        SELECT time, soc_pct, pack_current, dsoc, dt_s, ah_term,
               in_sess, break_id, in_cycle, cyc_first, cyc_last
        FROM cycled
        ORDER BY time
    `) as unknown as Array<Record<string, unknown>>;

    const samples: Sample[] = rows.map((r) => ({
        time: new Date(r.time as string),
        soc_pct: n0(r.soc_pct),
        pack_current: n(r.pack_current),
        dsoc: n(r.dsoc),
        dt_s: n(r.dt_s),
        ah_term: n0(r.ah_term),
        in_sess: n0(r.in_sess),
        break_id: n0(r.break_id),
        in_cycle: r.in_cycle === true,
        cyc_first: r.cyc_first ? new Date(r.cyc_first as string) : null,
        cyc_last: r.cyc_last ? new Date(r.cyc_last as string) : null,
    }));

    // ── §2 Ground truth — the limb scan ──────────────────────────────────────
    head(`§2  GROUND TRUTH — limb scan (independent of cycleCTEs)`);
    console.log(
        `A zigzag scan over the deduped SOC series, tolerating a +/-${LIMB_JITTER_PCT}% reversal as quantisation`,
    );
    console.log(`noise. This is a DIAGNOSTIC HEURISTIC, not a second production rule.`);
    console.log("");

    interface Limb {
        dir: "RISE" | "FALL" | "FLAT";
        from: Date;
        to: Date;
        socFrom: number;
        socTo: number;
        n: number;
    }
    const limbs: Limb[] = [];
    {
        let i = 0;
        while (i < samples.length) {
            // A limb runs until SOC reverses by more than the jitter band, or a gap
            // longer than a session breaks the series.
            const start = samples[i];
            let extremeHi = start.soc_pct;
            let extremeLo = start.soc_pct;
            let hiIdx = i;
            let loIdx = i;
            let j = i + 1;
            let dir: "RISE" | "FALL" | "FLAT" = "FLAT";

            for (; j < samples.length; j++) {
                const s = samples[j];
                const gap = n0(s.dt_s);
                if (gap > LIMB_BREAK_GAP_S) break; // telemetry blackout, not a limb boundary

                if (s.soc_pct > extremeHi) {
                    extremeHi = s.soc_pct;
                    hiIdx = j;
                }
                if (s.soc_pct < extremeLo) {
                    extremeLo = s.soc_pct;
                    loIdx = j;
                }

                if (dir === "FLAT") {
                    if (extremeHi - start.soc_pct > LIMB_JITTER_PCT) dir = "RISE";
                    else if (start.soc_pct - extremeLo > LIMB_JITTER_PCT) dir = "FALL";
                } else if (dir === "RISE" && extremeHi - s.soc_pct > LIMB_JITTER_PCT) {
                    break; // fell away from the peak by more than noise
                } else if (dir === "FALL" && s.soc_pct - extremeLo > LIMB_JITTER_PCT) {
                    break; // rose away from the trough by more than noise
                }
            }

            const endIdx = dir === "RISE" ? hiIdx : dir === "FALL" ? loIdx : Math.max(i, j - 1);
            const end = samples[endIdx];
            limbs.push({
                dir,
                from: start.time,
                to: end.time,
                socFrom: start.soc_pct,
                socTo: end.soc_pct,
                n: endIdx - i + 1,
            });
            i = Math.max(endIdx + 1, i + 1);
        }
    }

    const groundTruthRises = limbs.filter(
        (l) => l.dir === "RISE" && l.socTo - l.socFrom >= MIN_CYCLE_SOC_GAIN,
    );

    console.log(`limb  dir   from              to                  SOC            n     duration`);
    rule();
    for (const l of limbs) {
        if (l.dir === "FLAT") continue;
        const gain = l.socTo - l.socFrom;
        const secs = (l.to.getTime() - l.from.getTime()) / 1000;
        const mark = l.dir === "RISE" && gain >= MIN_CYCLE_SOC_GAIN ? " *" : "  ";
        console.log(
            `${mark} ${l.dir.padEnd(5)} ${fmt(l.from).padEnd(17)} ${fmt(l.to).padEnd(17)} ` +
                `${String(l.socFrom).padStart(3)}%->${String(l.socTo).padStart(3)}% (${gain >= 0 ? "+" : ""}${gain})`.padEnd(20) +
                ` ${String(l.n).padStart(4)}  ${dur(secs)}`,
        );
    }
    rule();
    console.log(
        `GROUND TRUTH: ${groundTruthRises.length} rising limbs with gain >= ${MIN_CYCLE_SOC_GAIN}%  (* marked above)`,
    );

    // ── §3 What the production rule found ────────────────────────────────────
    head(`§3  WHAT cycleCTEs() FOUND  (every break_id, valid or not)`);

    const cycleRows = (await iot`
        ${cte()}
        SELECT break_id, start_time, end_time, duration_s,
               round(ah_charged::numeric, 2)::float AS ah_charged,
               start_soc::float AS start_soc, end_soc::float AS end_soc,
               round(avg_charging_current::numeric, 1)::float AS avg_charging_current,
               round(max_charging_current::numeric, 1)::float AS max_charging_current,
               coverage_pct, n_samples, n_current_samples, rated_capacity_ah, is_valid
        FROM cycle_valid
        ORDER BY start_time ASC
    `) as unknown as Array<Record<string, unknown>>;

    const cycles: RawCycle[] = cycleRows.map((r) => ({
        break_id: n0(r.break_id),
        start_time: new Date(r.start_time as string),
        end_time: new Date(r.end_time as string),
        duration_s: n(r.duration_s),
        ah_charged: n(r.ah_charged),
        start_soc: n(r.start_soc),
        end_soc: n(r.end_soc),
        avg_charging_current: n(r.avg_charging_current),
        max_charging_current: n(r.max_charging_current),
        coverage_pct: n(r.coverage_pct),
        n_samples: n0(r.n_samples),
        n_current_samples: n0(r.n_current_samples),
        rated_capacity_ah: n(r.rated_capacity_ah),
        is_valid: r.is_valid === true,
    }));

    /** Every gate a cycle fails, not just the first — a cycle can fail several. */
    function failures(c: RawCycle): string[] {
        const f: string[] = [];
        const gain = (c.end_soc ?? 0) - (c.start_soc ?? 0);
        if (!(gain >= MIN_CYCLE_SOC_GAIN)) f.push(`soc_gain ${gain} < ${MIN_CYCLE_SOC_GAIN}`);
        if (!((c.end_soc ?? 0) > (c.start_soc ?? 0))) f.push("end_soc <= start_soc");
        if (!((c.ah_charged ?? 0) > 0)) f.push("ah_charged <= 0");
        if (c.n_samples < MIN_CYCLE_SAMPLES) f.push(`n_samples ${c.n_samples} < ${MIN_CYCLE_SAMPLES}`);
        if (c.n_current_samples <= 0) f.push("no current sample");
        return f;
    }

    console.log(
        ` #  brk   start             end                dur      n   nI  SOC              Ah      cov%   cap     verdict`,
    );
    rule();
    cycles.forEach((c, idx) => {
        const gain = (c.end_soc ?? 0) - (c.start_soc ?? 0);
        const cap = extrapolateCapacity(c.ah_charged ?? 0, gain, c.coverage_pct);
        const plaus = capacityPlausible(cap, c.rated_capacity_ah);
        const f = failures(c);
        const verdict = f.length === 0
            ? `VALID${cap != null && !plaus ? "  (capacity IMPLAUSIBLE vs " + c.rated_capacity_ah + ")" : ""}`
            : `DROPPED: ${f.join("; ")}`;
        console.log(
            `${String(idx + 1).padStart(3)} ${String(c.break_id).padStart(4)}  ` +
                `${fmt(c.start_time).padEnd(17)} ${fmt(c.end_time).padEnd(17)} ` +
                `${dur(c.duration_s).padStart(7)} ${String(c.n_samples).padStart(3)} ${String(c.n_current_samples).padStart(3)}  ` +
                `${String(c.start_soc ?? "?").padStart(3)}->${String(c.end_soc ?? "?").padEnd(3)} (${gain >= 0 ? "+" : ""}${gain})`.padEnd(17) +
                ` ${pct(c.ah_charged, 1).padStart(6)} ${pct(c.coverage_pct, 1).padStart(6)}  ${(cap != null ? cap.toFixed(1) : "—").padStart(6)}  ${verdict}`,
        );
    });
    rule();

    const dropped = cycles.filter((c) => !c.is_valid);
    const hist = new Map<string, number>();
    for (const c of dropped) {
        for (const f of failures(c)) {
            const key = f.replace(/\d+/g, "N").replace(/ N < N/, ` < ${""}`).trim();
            const norm = f.startsWith("soc_gain")
                ? `soc_gain < ${MIN_CYCLE_SOC_GAIN}`
                : f.startsWith("n_samples")
                  ? `n_samples < ${MIN_CYCLE_SAMPLES}`
                  : key;
            hist.set(norm, (hist.get(norm) ?? 0) + 1);
        }
    }
    const sampleFloorOnly = dropped.filter(
        (c) => failures(c).length === 1 && failures(c)[0].startsWith("n_samples"),
    ).length;

    console.log(`DROP REASONS (of ${cycles.length} raw runs, ${dropped.length} dropped):`);
    for (const [k, v] of [...hist.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${k.padEnd(28)} ${String(v).padStart(3)}`);
    }
    console.log(`  ${"n_samples floor ONLY".padEnd(28)} ${String(sampleFloorOnly).padStart(3)}   <-- real charges lost to the sample floor alone`);

    // ── §4 Silently-vanished sessions ────────────────────────────────────────
    head(`§4  SILENTLY-VANISHED SESSIONS  (in-session samples, but no cycle produced)`);
    const vanished = (await iot`
        ${cte()}
        SELECT break_id::int AS break_id,
               count(*)::int AS n,
               min(time) AS t0, max(time) AS t1,
               bool_or(dsoc > 0) AS has_rise,
               count(*) FILTER (WHERE pack_current > 0)::int AS n_current,
               min(soc_pct)::float AS soc_lo, max(soc_pct)::float AS soc_hi
        FROM cycled
        WHERE in_sess = 1
        GROUP BY break_id
        HAVING NOT bool_or(in_cycle)
        ORDER BY min(time)
    `) as unknown as Array<Record<string, unknown>>;

    if (vanished.length === 0) {
        console.log("none — every in-session run produced a cycle.");
    } else {
        console.log(`brk    n   from              to                 SOC        why`);
        rule();
        for (const v of vanished) {
            const hasRise = v.has_rise === true;
            const nCur = n0(v.n_current);
            const why = !hasRise
                ? "cyc_last IS NULL (no rising sample)"
                : nCur === 0
                  ? "cyc_first IS NULL (no current-carrying sample)"
                  : "cyc_first > cyc_last";
            console.log(
                `${String(n0(v.break_id)).padStart(4)} ${String(n0(v.n)).padStart(4)}  ` +
                    `${fmt(v.t0 as string).padEnd(17)} ${fmt(v.t1 as string).padEnd(17)} ` +
                    `${String(n0(v.soc_lo))}-${String(n0(v.soc_hi))}%`.padEnd(11) + ` ${why}`,
            );
        }
        rule();
        console.log(`${vanished.length} session(s) produced no cycle at all — invisible in §3.`);
    }

    // ── §5 Hypothesis probes ─────────────────────────────────────────────────
    head(`§5  HYPOTHESIS PROBES`);

    // H1 — split by a single -1% jitter tick
    console.log(`H1 SPLIT — adjacent runs resuming within 30 min (one charge cut in two?)`);
    let h1 = 0;
    for (let i = 1; i < cycles.length; i++) {
        const a = cycles[i - 1];
        const b = cycles[i];
        const gapS = (b.start_time.getTime() - a.end_time.getTime()) / 1000;
        if (gapS < 0 || gapS > 1800) continue;
        const between = samples.filter(
            (s) => s.time > a.end_time && s.time <= b.start_time && s.dsoc != null,
        );
        const minD = between.length ? Math.min(...between.map((s) => s.dsoc as number)) : NaN;
        h1++;
        console.log(
            `   brk ${a.break_id} (${a.start_soc}->${a.end_soc}) + brk ${b.break_id} (${b.start_soc}->${b.end_soc})` +
                ` — ${dur(gapS)} apart, min dsoc between = ${Number.isFinite(minD) ? minD : "?"}` +
                (minD === -1 ? "   <-- split by a single -1% tick" : ""),
        );
    }
    if (h1 === 0) console.log("   none.");

    // H2 — merge across a flat-SOC idle
    console.log("");
    console.log(`H2 MERGE — longest interior flat-SOC stretch inside a run (two charges merged?)`);
    let h2 = 0;
    for (const c of cycles) {
        const inCycle = samples.filter((s) => s.break_id === c.break_id && s.in_cycle);
        let best = 0;
        let bestAt: Date | null = null;
        let runStart: Date | null = null;
        for (const s of inCycle) {
            if (s.dsoc === 0) {
                runStart ??= s.time;
                const len = (s.time.getTime() - runStart.getTime()) / 1000;
                if (len > best) {
                    best = len;
                    bestAt = runStart;
                }
            } else {
                runStart = null;
            }
        }
        if (best >= 2 * 3600) {
            h2++;
            console.log(
                `   brk ${String(c.break_id).padStart(4)} contains a ${dur(best)} flat stretch from ${fmt(bestAt)}` +
                    `  (run spans ${c.start_soc}->${c.end_soc}%)   <-- likely two charges merged`,
            );
        }
    }
    if (h2 === 0) console.log("   none over 2h.");

    // H3 — lead-Ah contamination (a drive counted as a charge)
    console.log("");
    console.log(`H3 CONTAMINATION — Ah accrued BEFORE the first rising sample (discharge counted as charge?)`);
    let h3 = 0;
    for (const c of cycles) {
        const inCycle = samples.filter((s) => s.break_id === c.break_id && s.in_cycle);
        if (!inCycle.length) continue;
        const cycFirst = inCycle[0].cyc_first;
        const firstRise = inCycle.find((s) => (s.dsoc ?? 0) > 0)?.time;
        if (!cycFirst || !firstRise) continue;
        const lead = inCycle.filter((s) => s.time > cycFirst && s.time < firstRise);
        if (!lead.length) continue;
        const leadAh = lead.reduce((a, s) => a + s.ah_term, 0);
        const leadMaxI = Math.max(...lead.map((s) => s.pack_current ?? 0));
        const share = (c.ah_charged ?? 0) > 0 ? (leadAh / (c.ah_charged as number)) * 100 : 0;
        if (share >= 5) {
            h3++;
            console.log(
                `   brk ${String(c.break_id).padStart(4)} — ${leadAh.toFixed(1)} Ah (${share.toFixed(0)}% of its total)` +
                    ` accrued before the first rise, max current ${leadMaxI.toFixed(0)} A` +
                    (leadMaxI > 30 ? "   <-- that is discharge current" : ""),
            );
        }
    }
    if (h3 === 0) console.log("   none above 5% of cycle Ah.");

    // H5 — sample-count histogram
    console.log("");
    console.log(`H5 SPARSE — n_samples across raw runs`);
    const buckets: Record<string, number> = { "2": 0, "3-4": 0, "5-9": 0, "10-29": 0, "30+": 0 };
    for (const c of cycles) {
        const s = c.n_samples;
        if (s <= 2) buckets["2"]++;
        else if (s <= 4) buckets["3-4"]++;
        else if (s <= 9) buckets["5-9"]++;
        else if (s <= 29) buckets["10-29"]++;
        else buckets["30+"]++;
    }
    for (const [k, v] of Object.entries(buckets)) {
        console.log(`   ${k.padEnd(7)} ${"#".repeat(v).padEnd(40)} ${v}`);
    }

    // H6 — slow charges the trend rule would miss (informs SOC_TREND_RISE_PCT)
    const risingWithCurrent = samples.filter(
        (s) => (s.dsoc ?? 0) > 0 && (s.pack_current ?? 0) > 0,
    ).length;
    console.log("");
    console.log(
        `H6 SLOW CHARGE — samples with dsoc > 0 AND current > 0: ${risingWithCurrent}` +
            ` (upper bound on what a trend-based rule could misclassify)`,
    );

    // ── §6 Verdict ───────────────────────────────────────────────────────────
    head(`§6  VERDICT`);
    const valid = cycles.filter((c) => c.is_valid).length;
    console.log(`  ground-truth rising limbs (>= ${MIN_CYCLE_SOC_GAIN}%) : ${groundTruthRises.length}`);
    console.log(`  raw runs found by cycleCTEs              : ${cycles.length}`);
    console.log(`  runs passing is_valid (what UI counts)   : ${valid}`);
    console.log(`  sessions that vanished entirely          : ${vanished.length}`);
    const delta = valid - groundTruthRises.length;
    console.log("");
    if (delta < 0) {
        console.log(
            `  => UNDER-COUNT by ${-delta} (${groundTruthRises.length > 0 ? Math.round((-delta / groundTruthRises.length) * 100) : 0}% of real charges missed)`,
        );
    } else if (delta > 0) {
        console.log(`  => OVER-COUNT by ${delta}`);
    } else {
        console.log(`  => count matches ground truth`);
    }
    console.log("");
    console.log(`  dominant drop reason: ${[...hist.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "n/a"}`);
    console.log(`  contaminated runs (H3): ${h3} | merged runs (H2): ${h2} | split pairs (H1): ${h1}`);

    // ── §7 Threshold sweep ───────────────────────────────────────────────────
    if (WANT_SWEEP) {
        head(`§7  THRESHOLD SWEEP  (regenerates the table in docs/intellicar-calculations.md §5)`);
        console.log(
            `Mirrors production: only cycles that are is_valid AND have n_samples >= ${MIN_CYCLE_SAMPLES}`,
        );
        console.log(`(enough_samples) can carry a capacity, so only those are plotted.`);
        console.log("");
        console.log(`SOC gate | plotted | capacity range        | mean    | implausible`);
        rule();
        for (const gate of [0, 5, 10, 20, 30, 50]) {
            const caps: number[] = [];
            let implausible = 0;
            for (const c of cycles.filter((x) => x.is_valid && x.n_samples >= MIN_CYCLE_SAMPLES)) {
                const gain = (c.end_soc ?? 0) - (c.start_soc ?? 0);
                if (gain < gate) continue;
                const cap = (c.ah_charged ?? 0) / (gain / 100);
                if (!Number.isFinite(cap)) continue;
                caps.push(cap);
                if (!capacityPlausible(cap, c.rated_capacity_ah)) implausible++;
            }
            const mean = caps.length ? caps.reduce((a, b) => a + b, 0) / caps.length : null;
            console.log(
                `${String(gate).padStart(7)}% | ${String(caps.length).padStart(7)} | ` +
                    `${(caps.length ? `${Math.min(...caps).toFixed(0)}-${Math.max(...caps).toFixed(0)} Ah` : "—").padEnd(21)} | ` +
                    `${(mean != null ? mean.toFixed(1) : "—").padStart(7)} | ${implausible}`,
            );
        }

        // Coverage is the gate that matters once the session gap is wide enough to keep a
        // charge whole: a wide gap buys a correct cycle COUNT, but it lets a cycle be
        // integrated across hours of interpolated current, and that lands on a
        // battery-health chart. Swept at the configured SOC gate.
        console.log("");
        console.log(
            `Coverage floor, at SOC gate ${CAPACITY_SOC_THRESHOLD}% (what MIN_COVERAGE_PCT would do):`,
        );
        console.log("");
        console.log(`coverage | plotted | capacity range        | mean    | implausible`);
        rule();
        for (const floor of [0, 5, 10, 15, 20, 30, 40, 60]) {
            const caps: number[] = [];
            let implausible = 0;
            for (const c of cycles.filter((x) => x.is_valid && x.n_samples >= MIN_CYCLE_SAMPLES)) {
                const gain = (c.end_soc ?? 0) - (c.start_soc ?? 0);
                if (gain < CAPACITY_SOC_THRESHOLD) continue;
                if ((c.coverage_pct ?? 0) < floor) continue;
                const cap = (c.ah_charged ?? 0) / (gain / 100);
                if (!Number.isFinite(cap)) continue;
                caps.push(cap);
                if (!capacityPlausible(cap, c.rated_capacity_ah)) implausible++;
            }
            const mean = caps.length ? caps.reduce((a, b) => a + b, 0) / caps.length : null;
            const sd = caps.length > 1
                ? Math.sqrt(caps.reduce((a, b) => a + (b - (mean as number)) ** 2, 0) / caps.length)
                : null;
            console.log(
                `${String(floor).padStart(7)}% | ${String(caps.length).padStart(7)} | ` +
                    `${(caps.length ? `${Math.min(...caps).toFixed(0)}-${Math.max(...caps).toFixed(0)} Ah` : "—").padEnd(21)} | ` +
                    `${(mean != null ? mean.toFixed(1) : "—").padStart(7)} | ${implausible}` +
                    `${sd != null ? `   (sd ${sd.toFixed(1)})` : ""}`,
            );
        }
    }

    // ── §8 CSV ───────────────────────────────────────────────────────────────
    if (WANT_CSV) {
        head(`§8  CSV  (deduped series — paste into Excel, chart SOC, band by break_id)`);
        console.log("time,soc_pct,pack_current,dsoc,dt_s,ah_term,in_sess,break_id,in_cycle");
        for (const s of samples) {
            console.log(
                [
                    s.time.toISOString(),
                    s.soc_pct,
                    s.pack_current ?? "",
                    s.dsoc ?? "",
                    s.dt_s ?? "",
                    s.ah_term.toFixed(4),
                    s.in_sess,
                    s.break_id,
                    s.in_cycle ? 1 : 0,
                ].join(","),
            );
        }
    }

    // ── §10 Discharge ────────────────────────────────────────────────────────
    head(`§10  DISCHARGE — measured against the FALLING limbs of the same scan`);

    const groundTruthFalls = limbs.filter(
        (l) => l.dir === "FALL" && l.socFrom - l.socTo >= MIN_DISCHARGE_SOC_DROP,
    );

    const disRows = (await iot`
        ${dischargeCTEs(iot, VEHICLENO, timePredicate)}
        SELECT break_id, start_time, end_time, duration_s,
               start_soc::float AS start_soc, end_soc::float AS end_soc,
               round(ah_coulomb::numeric, 2)::float AS ah_coulomb,
               n_samples, n_falling_samples, rated_capacity_ah, is_valid
        FROM dis_valid
        ORDER BY start_time ASC
    `) as unknown as Array<Record<string, unknown>>;

    const disValid = disRows.filter((r) => r.is_valid === true);

    console.log(`ground-truth falling limbs (>= ${MIN_DISCHARGE_SOC_DROP}%) : ${groundTruthFalls.length}`);
    console.log(`raw discharge runs found                     : ${disRows.length}`);
    console.log(`runs passing is_valid                        : ${disValid.length}`);
    const dDelta = disValid.length - groundTruthFalls.length;
    console.log(
        dDelta === 0
            ? `  => count matches ground truth`
            : dDelta < 0
              ? `  => UNDER-COUNT by ${-dDelta}`
              : `  => OVER-COUNT by ${dDelta}`,
    );

    // The whole point of the SOC-derived primary series: does the coulomb integral agree?
    console.log("");
    console.log(`SOC-derived vs coulomb Ah (the divergence that decides which to trust):`);
    console.log("");
    console.log(` #   start             SOC          DoD    Ah(SOC)  Ah(coulomb)  diverge   n`);
    rule();
    const divergences: number[] = [];
    for (const [i, r] of disValid.slice(0, 20).entries()) {
        const s = n(r.start_soc);
        const e = n(r.end_soc);
        const rated = n(r.rated_capacity_ah);
        const socAh = socDerivedAh(s, e, rated);
        const coul = n(r.ah_coulomb);
        const nS = n0(r.n_samples);
        const div = socAh != null && coul != null && socAh > 0 ? ((coul - socAh) / socAh) * 100 : null;
        if (div != null && nS >= 5) divergences.push(Math.abs(div));
        console.log(
            `${String(i + 1).padStart(3)}  ${fmt(r.start_time as string).padEnd(17)} ` +
                `${String(s ?? "?").padStart(3)}->${String(e ?? "?").padEnd(3)}`.padEnd(11) +
                ` ${pct(s != null && e != null ? s - e : null, 0).padStart(5)}  ` +
                `${pct(socAh, 1).padStart(7)}  ${pct(coul, 1).padStart(11)}  ` +
                `${(div != null ? (div >= 0 ? "+" : "") + div.toFixed(0) + "%" : "—").padStart(7)}  ${String(nS).padStart(3)}`,
        );
    }
    if (disValid.length > 20) console.log(`     … ${disValid.length - 20} more`);
    rule();
    if (divergences.length) {
        const sorted = [...divergences].sort((a, b) => a - b);
        const med = sorted[Math.floor(sorted.length / 2)];
        console.log(
            `median |divergence| over the ${divergences.length} cycles with >= 5 samples: ${med.toFixed(0)}%`,
        );
        console.log(
            med <= 25
                ? `  the two methods broadly agree — the coulomb series is worth showing alongside.`
                : `  they do NOT agree. The coulomb integral cannot see discharge current at this` +
                  ` cadence; SOC-derived is the number to trust. This is why it is the primary series.`,
        );
    }

    // The parked-vehicle trap, measured rather than asserted.
    const [naive] = (await iot`
        ${dischargeCTEs(iot, VEHICLENO, timePredicate)}
        , naive AS (
            SELECT break_id, sum(ah_term) FILTER (WHERE time > cyc_first) AS ah_all_intervals
            FROM dis_cycled WHERE in_cycle GROUP BY break_id
        )
        SELECT round(sum(n.ah_all_intervals)::numeric, 1)::float AS naive_total,
               round(sum(v.ah_coulomb)::numeric, 1)::float       AS correct_total
        FROM naive n JOIN dis_valid v USING (break_id)
        WHERE v.is_valid
    `) as unknown as Array<{ naive_total: number; correct_total: number }>;
    const naiveTotal = n(naive?.naive_total);
    const correctTotal = n(naive?.correct_total);
    console.log("");
    console.log(`THE PARKED-VEHICLE TRAP (accruing Ah on flat-SOC intervals, as the charge chain does):`);
    console.log(`  correct (only where SOC fell) : ${pct(correctTotal, 1)} Ah`);
    console.log(`  naive mirror (every interval) : ${pct(naiveTotal, 1)} Ah`);
    if (naiveTotal && correctTotal) {
        console.log(
            `  => the naive mirror inflates discharge by ${(naiveTotal / correctTotal).toFixed(1)}x` +
                ` — it holds the last trip's current across every overnight park.`,
        );
    }

    // ── §11 Deep discharge ───────────────────────────────────────────────────
    head(`§11  DEEP DISCHARGE (Schmitt trigger: enter <${DEEP_DISCHARGE_ENTER_PCT}%, exit >=${DEEP_DISCHARGE_EXIT_PCT}%)`);

    const ddRows = (await iot`
        ${deepDischargeCTEs(iot, VEHICLENO, timePredicate)}
        SELECT event_id, start_time, end_time, duration_s,
               min_soc::float AS min_soc, n_samples, max_gap_s
        FROM dd_events ORDER BY start_time ASC
    `) as unknown as Array<Record<string, unknown>>;

    // What a naive `SOC < 20` filter would have reported, for comparison.
    const [naiveDd] = (await iot`
        ${deepDischargeCTEs(iot, VEHICLENO, timePredicate)}
        SELECT count(*)::int AS n FROM dd_marked WHERE soc_pct < ${DEEP_DISCHARGE_ENTER_PCT}
    `) as unknown as Array<{ n: number }>;

    console.log(`samples below ${DEEP_DISCHARGE_ENTER_PCT}%          : ${n0(naiveDd?.n)}   <- what a naive threshold would count`);
    console.log(`debounced events (Schmitt)  : ${ddRows.length}   <- physical events`);
    console.log("");
    if (ddRows.length) {
        console.log(` #   start             end               min SOC  duration   n   confident`);
        rule();
        for (const [i, r] of ddRows.slice(0, 15).entries()) {
            const gap = n0(r.max_gap_s);
            console.log(
                `${String(i + 1).padStart(3)}  ${fmt(r.start_time as string).padEnd(17)} ` +
                    `${fmt(r.end_time as string).padEnd(17)} ${pct(n(r.min_soc), 0).padStart(6)}%  ` +
                    `${dur(n(r.duration_s)).padStart(8)}  ${String(n0(r.n_samples)).padStart(3)}   ` +
                    `${gap <= SESSION_GAP_MAX_S ? "yes" : "no (gap " + dur(gap) + ")"}`,
            );
        }
        if (ddRows.length > 15) console.log(`     … ${ddRows.length - 15} more`);
        rule();
        const byMonth = new Map<string, number>();
        for (const r of ddRows) {
            const k = new Date(r.start_time as string).toISOString().slice(0, 7);
            byMonth.set(k, (byMonth.get(k) ?? 0) + 1);
        }
        console.log("per month:");
        for (const [m, c] of [...byMonth.entries()].sort()) {
            console.log(`  ${m}  ${"#".repeat(c).padEnd(20)} ${c}`);
        }
    } else {
        console.log("no deep-discharge events in this window.");
    }

    // ── §9 SQL capability probe ──────────────────────────────────────────────
    head(`§9  SQL PROBE — does Postgres accept a bound parameter as a RANGE frame offset?`);
    const WINDOW_S = 2700;
    try {
        const probe = (await iot`
            SELECT t,
                   max(v) OVER (
                       ORDER BY t
                       RANGE BETWEEN CURRENT ROW
                                 AND (${WINDOW_S} * interval '1 second') FOLLOWING
                   ) AS ahead
            FROM (
                SELECT now() + (g * interval '10 minutes') AS t, g AS v
                FROM generate_series(1, 5) g
            ) s
            ORDER BY t
        `) as unknown as Array<{ ahead: number }>;
        console.log(`  OK — bound param accepted as a frame offset. ahead = [${probe.map((p) => p.ahead).join(", ")}]`);
        console.log(`  => use  RANGE BETWEEN CURRENT ROW AND (\${SOC_TREND_WINDOW_S} * interval '1 second') FOLLOWING`);
    } catch (e) {
        console.log(`  REJECTED: ${(e as Error).message}`);
        console.log(`  => fall back to inlining the validated literal via iot.unsafe(String(SOC_TREND_WINDOW_S))`);
    }

    console.log("");
}

main()
    .catch((e) => {
        console.error("\nFAILED:", (e as Error).message);
        process.exitCode = 1;
    })
    .finally(() => iot.end({ timeout: 5 }));

/**
 * Is a fleet-wide **measured** SOH trend buildable from this telemetry? Read-only.
 *
 * Plan step B. Run it again after the poller cadence is fixed — the verdict should flip.
 *
 * Reuses fetchChargingCycleAggregate (the same verified path the per-battery page uses)
 * rather than restating the detection rules, so this cannot disagree with production.
 *
 *   node --import tsx --env-file=.env.local scripts/probe-telemetry-feasibility.ts
 *
 * Reading the result: the question is NOT "are there high-confidence cycles" — there are
 * hundreds. It is "does `high` imply accurate enough to resolve the 80/90% warranty
 * bands". §3 answers that, and as of 2026-07-17 the answer is no.
 */
import { getIotSql } from "@/lib/db/iot";
import { fetchChargingCycleAggregate } from "@/lib/telemetry/queries";

const MONTHS = 3;
const CONCURRENCY = 6;

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const q = (s: number[], f: number) => s[Math.floor(f * (s.length - 1))];
const med = (xs: number[]) => (xs.length ? sorted(xs)[Math.floor(xs.length / 2)] : null);

interface Cyc { est: number; rated: number; conf: string; startSoc: number; swing: number; cov: number; gap: number }

async function main() {
    const iot = getIotSql();
    const vehicles = (await iot`
        SELECT DISTINCT vehicleno FROM telemetry_can
        WHERE time > now() - (interval '1 month' * ${MONTHS}) ORDER BY vehicleno
    `).map((r) => String(r.vehicleno));
    console.log(`fleet: ${vehicles.length} vehicles with CAN in the last ${MONTHS} months\n`);

    const byPack = new Map<string, Cyc[]>();
    const rated = new Map<string, number>();
    const queue = [...vehicles];
    let done = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        for (;;) {
            const v = queue.shift();
            if (!v) return;
            try {
                const { cycles } = await fetchChargingCycleAggregate(v, { months: MONTHS });
                const r = cycles.find((c) => c.rated_capacity_ah != null)?.rated_capacity_ah ?? null;
                if (r != null) rated.set(v, r);
                const keep: Cyc[] = [];
                for (const c of cycles) {
                    if (c.estimated_capacity_ah == null || r == null) continue;
                    if (c.start_soc == null || c.end_soc == null) continue;
                    keep.push({
                        est: c.estimated_capacity_ah, rated: r, conf: c.capacity_confidence,
                        startSoc: c.start_soc, swing: c.end_soc - c.start_soc,
                        cov: c.coverage_pct ?? 0, gap: c.max_gap_s ?? 0,
                    });
                }
                byPack.set(v, keep);
            } catch { byPack.set(v, []); }
            if (++done % 60 === 0) console.log(`  …${done}/${vehicles.length}`);
        }
    }));

    const all = [...byPack.values()].flat();
    const high = all.filter((c) => c.conf === "high");

    console.log("\n════ §1  YIELD — are there cycles at all? ════");
    console.log(`packs with a nameplate       : ${rated.size}/${vehicles.length}  (values: ${JSON.stringify([...new Set(rated.values())].slice(0, 6))})`);
    console.log(`packs with >=1 HIGH cycle    : ${[...byPack.values()].filter((cs) => cs.some((c) => c.conf === "high")).length}`);
    console.log(`HIGH / MED / LOW cycles      : ${high.length} / ${all.filter((c) => c.conf === "medium").length} / ${all.filter((c) => c.conf === "low").length}`);

    console.log("\n════ §2  REPRODUCIBILITY — does a pack agree with itself? ════");
    const spreads: number[] = [];
    for (const [v, cs] of byPack) {
        const hs = cs.filter((c) => c.conf === "high").map((c) => c.est);
        if (hs.length >= 2) spreads.push(((Math.max(...hs) - Math.min(...hs)) / rated.get(v)!) * 100);
    }
    if (spreads.length) {
        const s = sorted(spreads);
        console.log(`within-pack spread of HIGH estimates (max-min, % of rated), n=${s.length} packs:`);
        console.log(`  median ${q(s,0.5).toFixed(1)}%  p75 ${q(s,0.75).toFixed(1)}%  p90 ${q(s,0.9).toFixed(1)}%  max ${q(s,1).toFixed(1)}%`);
        console.log(`  The warranty bands are 90% and 80% — a 10-20 point question. If the spread`);
        console.log(`  above rivals that, one cycle cannot decide a warranty claim.`);
    }

    console.log("\n════ §3  THE VERDICT — does 'high confidence' mean accurate? ════");
    const impossible = high.filter((c) => c.est / c.rated > 1.0);
    const pct = (100 * impossible.length / Math.max(high.length, 1)).toFixed(0);
    console.log(`HIGH cycles reading OVER 100% of nameplate: ${impossible.length}/${high.length} (${pct}%)`);
    console.log(`  a pack cannot hold more than its nameplate, so every one of these is a`);
    console.log(`  measurement fault, not a battery.`);
    console.log(`  their median coverage_pct : ${med(impossible.map((c) => c.cov))}   (all HIGH: ${med(high.map((c) => c.cov))})`);
    console.log(`  their median max_gap_s    : ${med(impossible.map((c) => c.gap))}   (all HIGH: ${med(high.map((c) => c.gap))})`);
    console.log(`  If those match, the confidence grade cannot separate the impossible`);
    console.log(`  readings from the credible ones — which is exactly the failure.`);
    console.log(`\n  Root cause: median coverage of a HIGH cycle is only ${med(high.map((c) => c.cov))}%, i.e. ~${(100 - (med(high.map((c) => c.cov)) ?? 0)).toFixed(0)}% of`);
    console.log(`  every Ah integral is interpolated across gaps of ~${((med(high.map((c) => c.gap)) ?? 0) / 60).toFixed(0)} min. Fix the poller`);
    console.log(`  cadence (the item-1 escalation) and re-run this probe.`);

    console.log("\n════ §4  WHAT A FLEET CHART WOULD HAVE SHOWN ════");
    for (const [label, minN] of [["median of >=1 HIGH", 1], ["median of >=3 HIGH", 3]] as const) {
        const packs = [...byPack.entries()]
            .map(([v, cs]) => ({ v, hs: cs.filter((c) => c.conf === "high").map((c) => c.est) }))
            .filter((p) => p.hs.length >= minN && rated.has(p.v));
        if (!packs.length) continue;
        const soh = sorted(packs.map((p) => (med(p.hs)! / rated.get(p.v)!) * 100));
        console.log(`${label}  packs=${packs.length}`);
        console.log(`  SOH%: min ${q(soh,0).toFixed(1)} | median ${q(soh,0.5).toFixed(1)} | p75 ${q(soh,0.75).toFixed(1)} | max ${q(soh,1).toFixed(1)}`);
        console.log(`  >100% (impossible): ${soh.filter((x) => x > 100).length}   <80% (would be flagged): ${soh.filter((x) => x < 80).length}`);
    }
    console.log("\n=> Publishing that as 'measured fleet SOH' would invent warranty claims. Withheld.");
    await iot.end({ timeout: 5 });
}
main().catch((e) => { console.error(e); process.exit(1); });

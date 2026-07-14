import { fetchBatteryAhAnalytics } from "@/lib/telemetry/queries";
import { capacityAxis } from "@/components/intellicar/battery/capacity-axis";
const V = "TK-51105-02DZ-213416";

async function main() {
  const a = await fetchBatteryAhAnalytics(V, { months: 1 });
  const rated = a.summary.ratedCapacityAh!;
  const pts = a.sessions.filter(s => s.estimated_capacity_ah != null)
    .map(s => ({ cap: s.estimated_capacity_ah!, plausible: s.capacity_plausible, conf: s.capacity_confidence }));

  const bandsCritical = Math.round(rated * 0.8 * 10) / 10;

  // OLD: domain from trusted only, then recharts silently expands to fit ALL data.
  const trusted = pts.filter(p => p.conf === "high").map(p => p.cap);
  const oldDomain = capacityAxis([...trusted, bandsCritical], rated).domain;
  const allMax = Math.max(...pts.map(p => p.cap));
  console.log(`BEFORE: computed domain ${JSON.stringify(oldDomain)}`);
  console.log(`        ...but allowDataOverflow=false made recharts stretch it to fit ${allMax} Ah`);
  console.log(`        => effective axis ~[0, ${allMax}] — every real point squashed into ${(oldDomain[1]/allMax*100).toFixed(1)}% of the canvas`);

  // NEW: domain from plausible points + bands, honoured via allowDataOverflow.
  const plausible = pts.filter(p => p.plausible).map(p => p.cap);
  const nd = capacityAxis([...plausible, bandsCritical], rated);
  const [lo, hi] = nd.domain;
  const off = pts.filter(p => p.cap > hi || p.cap < lo);
  console.log(`\nAFTER : domain ${JSON.stringify(nd.domain)}  ticks ${JSON.stringify(nd.ticks)}`);
  console.log(`        visible points : ${pts.length - off.length} / ${pts.length}`);
  console.log(`        clamped (caret): ${off.length}  -> ${off.map(o => o.cap + " Ah").join(", ")}`);
  console.log(`        rated ${rated} / warn ${Math.round(rated*0.9*10)/10} / crit ${bandsCritical} all inside domain: ${lo <= bandsCritical && rated <= hi}`);
  const span = hi - lo;
  const realBand = Math.max(...plausible) - Math.min(...plausible);
  console.log(`        real data now fills ${(realBand/span*100).toFixed(0)}% of the axis (was ~${(realBand/allMax*100).toFixed(1)}%)`);
}
main().catch(e => console.error("FAILED:", e.message));

/**
 * Seeds the peakAmp battery catalog (M16 / BRD P1).
 *
 * Every voltage + Ah combination is its OWN variant — that is the whole point of
 * P1. A "60V" entry with a capacity dropdown would let two different batteries
 * share a price band, which is exactly the ambiguity the buyback is meant to
 * remove.
 *
 * Each variant carries TWO buyback estimates: what iTarang expects to pay for a
 * working cell, and for a dead one. The intake page swaps between them when the
 * dealer flips the condition.
 *
 * Run: npx tsx --env-file=.env.local scripts/seed-buyback-catalog.ts
 * Idempotent — re-running updates prices in place (UNIQUE on type+voltage+ah).
 */

import { sql } from "drizzle-orm";

import { db } from "../src/lib/db";

interface Seed {
  voltage: number;
  ah: number;
  chemistry: string;
  /** OEM list price, for reference only. */
  unit_price: number;
  working: number;
  dead: number;
}

// Indicative bands — the business reviews these weekly (M16 "price review nudge").
const SEEDS: Seed[] = [
  { voltage: 48, ah: 100, chemistry: "Li-ion", unit_price: 42000, working: 4200, dead: 2500 },
  { voltage: 48, ah: 120, chemistry: "Li-ion", unit_price: 47000, working: 4800, dead: 2900 },
  { voltage: 51.2, ah: 85, chemistry: "LFP", unit_price: 40000, working: 4000, dead: 2400 },
  { voltage: 51.2, ah: 105, chemistry: "LFP", unit_price: 44000, working: 4500, dead: 2700 },
  { voltage: 51.2, ah: 140, chemistry: "LFP", unit_price: 61500, working: 6000, dead: 3600 },
  { voltage: 58, ah: 110, chemistry: "Li-ion", unit_price: 49000, working: 4800, dead: 2900 },
  { voltage: 60, ah: 100, chemistry: "Li-ion", unit_price: 48000, working: 4700, dead: 2800 },
  { voltage: 60, ah: 120, chemistry: "Li-ion", unit_price: 53000, working: 5200, dead: 3100 },
  { voltage: 60.8, ah: 105, chemistry: "LFP", unit_price: 51500, working: 5100, dead: 3000 },
  { voltage: 60.8, ah: 140, chemistry: "LFP", unit_price: 70500, working: 6900, dead: 4100 },
  { voltage: 64, ah: 105, chemistry: "LFP", unit_price: 54000, working: 5300, dead: 3200 },
  { voltage: 64, ah: 140, chemistry: "LFP", unit_price: 75500, working: 7400, dead: 4400 },
  { voltage: 72, ah: 120, chemistry: "Li-ion", unit_price: 66000, working: 6500, dead: 3900 },
  { voltage: 73.6, ah: 105, chemistry: "LFP", unit_price: 61000, working: 6000, dead: 3600 },
];

/** "60V 120Ah Li-ion" — the label the dealer picks from. */
const label = (s: Seed) => `${trim(s.voltage)}V ${trim(s.ah)}Ah ${s.chemistry}`;
const trim = (n: number) => String(Number(n.toFixed(2)));

async function main() {
  console.log(`Seeding ${SEEDS.length} battery variants…\n`);

  for (const s of SEEDS) {
    await db.execute(sql`
      INSERT INTO catalog_variants
        (type, chemistry, voltage, ah, unit_price,
         est_buyback_price_working, est_buyback_price_dead, price_book_version, active)
      VALUES
        (${label(s)}, ${s.chemistry}, ${s.voltage}, ${s.ah}, ${s.unit_price},
         ${s.working}, ${s.dead}, 1, TRUE)
      ON CONFLICT (type, voltage, ah) DO UPDATE SET
        unit_price                = EXCLUDED.unit_price,
        est_buyback_price_working = EXCLUDED.est_buyback_price_working,
        est_buyback_price_dead    = EXCLUDED.est_buyback_price_dead,
        updated_at                = now()
    `);

    console.log(
      `  ${label(s).padEnd(26)} working ₹${s.working.toLocaleString("en-IN")}  ·  dead ₹${s.dead.toLocaleString("en-IN")}`,
    );
  }

  const [{ n }] = (await db.execute(
    sql`SELECT count(*)::int AS n FROM catalog_variants WHERE active`,
  )) as unknown as Array<{ n: number }>;

  console.log(`\nDone. ${n} active variants in the catalog.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("Seed failed:", e);
  process.exit(1);
});

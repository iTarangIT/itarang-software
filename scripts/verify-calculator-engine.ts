/**
 * Verifies the loan-calculator engine reproduces the realisation workbook exactly.
 * Runs the canonical golden fixture (all 260 rows) + the 3 rounding-regression rows
 * through computeScheme() and asserts price/loan/downPayment/upfront/EMI to the rupee.
 *
 * Run: npm run verify:calculator   (node --import tsx scripts/verify-calculator-engine.ts)
 * Exits non-zero on any mismatch. This is the merge gate for any engine edit — the repo
 * has no Vitest, so this tsx script stands in for the handoff test suite.
 */

import {
  computeScheme,
  SEED,
  type ModelComponents,
  type NbfcConfig,
  type SchemeConfig,
} from "@/lib/calculator/engine";
import { GOLDEN_CASES, type GoldenCase } from "@/lib/calculator/__fixtures__/golden";

// Per-model battery prices (OEM list) — the one input the fixture does not carry.
const BATTERY: Record<string, number> = {
  "51.2V - 105 AMP": 44000, "51.2V - 105 AMP - Prime": 48000, "51.2V - 140 AMP": 61500,
  "51.2V - 153 AMP": 76500, "51.2V - 206 AMP - AN": 93500, "51.2V - 232 AMP - JN": 98000,
  "51.2V - 314 AMP - JN": 127500, "60.8V - 105 AMP": 51500, "64V - 105 AMP": 54000,
  "60.8V - 140 AMP": 70500, "64V - 140 AMP": 75500, "60.8V - 153 AMP": 87500,
  "64V - 153 AMP": 93000, "60.8V - 206 AMP - AN": 110500, "60.8V - 232 AMP - JN": 113500,
  "64V - 232 AMP - JN": 119000, "60.8V - 314 AMP - JN": 145500, "73.6V - 105 AMP": 61000,
  "73.6V - 140 AMP": 86500, "73.6V - 232 AMP - JN": 136500,
};

function modelComp(model: string): ModelComponents {
  const g = SEED.gst;
  const battery = BATTERY[model];
  if (battery == null) throw new Error(`No battery price seeded for ${model}`);
  return {
    model, skuCode: "SKU-" + model, battery, charger: 5100, harness: 0, soc: 600, iot: 4500,
    gstBattery: g.battery, gstCharger: g.charger, gstHarness: g.harness, gstSoc: g.soc, gstIot: g.iot,
  };
}
function nbfcA(name: "BatteryPool" | "Delovita"): NbfcConfig {
  const s = SEED[name];
  return {
    name, variant: "A", flatMaxLoan: s.flatMaxLoan, fileFee: s.fileFee,
    schemes: s.schemes.map((x) => ({
      ...x, appliedInterestRate: s.flatRateGstInclusive, processingFee: s.processingFee, advanceInterestRate: 0,
    })) as SchemeConfig[],
  };
}
function nbfcB(): NbfcConfig {
  const s = SEED.Bajaj;
  return { name: "Bajaj", variant: "B", fileFee: s.fileFee, schemes: s.schemes.map((x) => ({ ...x })) as SchemeConfig[] };
}
const nbfcFor = (c: GoldenCase) => (c.nbfc === "Bajaj" ? nbfcB() : nbfcA(c.nbfc));
const capFor = (c: GoldenCase) => (c.nbfc === "Bajaj" ? SEED.Bajaj.modelCaps[c.model] : undefined);

let failures = 0;
const fail = (msg: string) => { failures++; console.error("  ✗ " + msg); };
function eq(actual: number, expected: number, label: string) {
  if (actual !== expected) fail(`${label}: expected ${expected}, got ${actual}`);
}

// 1) Fixture shape
if (GOLDEN_CASES.length !== 260) fail(`fixture length: expected 260, got ${GOLDEN_CASES.length}`);
const counts = {
  BatteryPool: GOLDEN_CASES.filter((c) => c.nbfc === "BatteryPool").length,
  Delovita: GOLDEN_CASES.filter((c) => c.nbfc === "Delovita").length,
  Bajaj: GOLDEN_CASES.filter((c) => c.nbfc === "Bajaj").length,
};
if (counts.BatteryPool !== 60) fail(`BatteryPool rows: expected 60, got ${counts.BatteryPool}`);
if (counts.Delovita !== 20) fail(`Delovita rows: expected 20, got ${counts.Delovita}`);
if (counts.Bajaj !== 180) fail(`Bajaj rows: expected 180, got ${counts.Bajaj}`);

// 2) Every fixture row, rupee-exact
for (const c of GOLDEN_CASES) {
  const nbfc = nbfcFor(c);
  const scheme = nbfc.schemes.find((s) => s.code === c.scheme);
  if (!scheme) { fail(`${c.nbfc}/${c.model}/${c.scheme}: scheme not found`); continue; }
  const r = computeScheme(modelComp(c.model), SEED.dealerMargin, nbfc, scheme, capFor(c));
  const label = `${c.nbfc}/${c.model}/${c.scheme}`;
  eq(r.priceToDriver, c.priceToDriver, `${label} priceToDriver`);
  eq(r.loanAmount, c.loanAmount, `${label} loanAmount`);
  eq(r.breakdown.downPayment, c.expected.downPayment, `${label} downPayment`);
  eq(r.upfrontPayable, c.expected.totalUpfront, `${label} totalUpfront`);
  eq(r.emi, c.expected.emi, `${label} emi`);
}

// 3) Rounding-regression rows (the three ₹1 cases)
const regression: [string, string, number, number][] = [
  ["60.8V - 105 AMP", "10by2", 25648, 7815],
  ["64V - 105 AMP", "9by1", 19193, 9011],
  ["60.8V - 314 AMP - JN", "8by0", 20103, 23633],
];
for (const [model, code, upfront, emi] of regression) {
  const nbfc = nbfcB();
  const r = computeScheme(modelComp(model), SEED.dealerMargin, nbfc, nbfc.schemes.find((s) => s.code === code)!, SEED.Bajaj.modelCaps[model]);
  eq(r.upfrontPayable, upfront, `regression Bajaj/${model}/${code} upfront`);
  eq(r.emi, emi, `regression Bajaj/${model}/${code} emi`);
}

if (failures > 0) {
  console.error(`\n❌ calculator engine verification FAILED: ${failures} mismatch(es).`);
  process.exit(1);
}
console.log(`✅ calculator engine verified: 260 golden rows + 3 regression rows exact.`);

/**
 * Seed the dealer Loan Calculator config (NBFCs, battery models, component prices,
 * schemes, per-model caps, city eligibility, settings) under an initial config
 * version. Values are the verified SEED constants from the calculation engine.
 *
 * Prereq: apply drizzle/E-177_loan_calculator.sql first (tables + guards).
 * Run:    npm run seed:calculator
 * Idempotent: if config version note 'calculator-seed-v1' already exists, it skips.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { SEED } from "@/lib/calculator/engine";
import {
  calcConfigVersions,
  calcSettings,
  calcBatteryModels,
  calcComponentPrices,
  calcNbfcs,
  calcSchemes,
  calcNbfcModelCaps,
  calcNbfcCoverage,
} from "@/lib/db/schema";

const SEED_NOTE = "calculator-seed-v1";
const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000000";
const rupeesToPaise = (r: number) => Math.round(r * 100);

// Per-model OEM battery price (display name -> rupees). The one input not in SEED.
const BATTERY: Record<string, number> = {
  "51.2V - 105 AMP": 44000, "51.2V - 105 AMP - Prime": 48000, "51.2V - 140 AMP": 61500,
  "51.2V - 153 AMP": 76500, "51.2V - 206 AMP - AN": 93500, "51.2V - 232 AMP - JN": 98000,
  "51.2V - 314 AMP - JN": 127500, "60.8V - 105 AMP": 51500, "64V - 105 AMP": 54000,
  "60.8V - 140 AMP": 70500, "64V - 140 AMP": 75500, "60.8V - 153 AMP": 87500,
  "64V - 153 AMP": 93000, "60.8V - 206 AMP - AN": 110500, "60.8V - 232 AMP - JN": 113500,
  "64V - 232 AMP - JN": 119000, "60.8V - 314 AMP - JN": 145500, "73.6V - 105 AMP": 61000,
  "73.6V - 140 AMP": 86500, "73.6V - 232 AMP - JN": 136500,
};

// Zip the engine's parallel sku->cap and displayName->cap maps (defined in the same
// order) into one model table row per battery model.
const skus = Object.keys(SEED.Bajaj.modelCapsBySku);
const names = Object.keys(SEED.Bajaj.modelCaps);
const MODELS = skus.map((sku, i) => ({
  sku,
  displayName: names[i],
  battery: BATTERY[names[i]],
  bajajCapPaise: rupeesToPaise(SEED.Bajaj.modelCapsBySku[sku]),
}));

// City eligibility (from the BRD "Applicable Locations"). state_code required for CITY rows.
const DELOVITA_CITIES: [string, string][] = [
  ["Sonipat", "HR"], ["Karnal", "HR"], ["Panipat", "HR"], ["Chandigarh", "CH"],
  ["Jaipur", "RJ"], ["Meerut", "UP"], ["Saharanpur", "UP"], ["Lucknow", "UP"],
  ["Mathura", "UP"], ["Varanasi", "UP"], ["Bareilly", "UP"], ["Bijnor", "UP"],
  ["Noida", "UP"], ["Ghaziabad", "UP"], ["Muzaffarnagar", "UP"],
];
const BATTERYPOOL_CITIES: [string, string][] = [
  ["Delhi", "DL"], ["Faridabad", "HR"], ["Ghaziabad", "UP"], ["Noida", "UP"],
  ["Gurgaon", "HR"], ["Jhansi", "UP"], ["Jaipur", "RJ"], ["Gwalior", "MP"],
  ["Bhopal", "MP"], ["Ujjain", "MP"], ["Indore", "MP"], ["Jabalpur", "MP"],
];

async function main() {
  const existing = await db
    .select({ id: calcConfigVersions.id })
    .from(calcConfigVersions)
    .where(eq(calcConfigVersions.note, SEED_NOTE))
    .limit(1);
  if (existing.length > 0) {
    console.log(`↷ calculator already seeded (config version #${existing[0].id}, note ${SEED_NOTE}). No-op.`);
    return;
  }

  await db.transaction(async (tx) => {
    // 1) config version
    const [ver] = await tx
      .insert(calcConfigVersions)
      .values({ createdBy: SYSTEM_ACTOR, note: SEED_NOTE, changeSummary: { seeded: "initial calculator config" } })
      .returning({ id: calcConfigVersions.id });
    const cv = ver.id;

    // 2) settings
    await tx.insert(calcSettings).values({
      dealerMarginPaise: rupeesToPaise(SEED.dealerMargin),
      nearBestWindowPct: "25",
      expectedEmiFilterRequired: false,
      upfrontFilterRequired: false,
      disclaimerText:
        "Figures shown are indicative and subject to individual consumer eligibility and NBFC approval.",
      cardFooterDisclaimer:
        "Final financing terms are determined per individual consumer eligibility and NBFC approval. Please reach out to your nearest iTarang dealer.",
      contactPhone: "+91-8076841497",
      contactEmail: "care@itarang.com",
      contactWhatsapp: "+91-8920828425",
      configVersionId: cv,
    });

    // 3) battery models + component prices
    const modelIdByName = new Map<string, number>();
    for (const m of MODELS) {
      const [row] = await tx
        .insert(calcBatteryModels)
        .values({ skuCode: m.sku, displayName: m.displayName, chargerSku: null })
        .returning({ id: calcBatteryModels.id });
      modelIdByName.set(m.displayName, row.id);

      const g = SEED.gst;
      await tx.insert(calcComponentPrices).values([
        { modelId: row.id, component: "battery", amountPaise: rupeesToPaise(m.battery), gstMultiplier: String(g.battery), configVersionId: cv },
        { modelId: row.id, component: "charger", amountPaise: rupeesToPaise(5100), gstMultiplier: String(g.charger), configVersionId: cv },
        { modelId: row.id, component: "harness", amountPaise: 0, gstMultiplier: String(g.harness), configVersionId: cv },
        { modelId: row.id, component: "soc", amountPaise: rupeesToPaise(600), gstMultiplier: String(g.soc), configVersionId: cv },
        { modelId: row.id, component: "iot", amountPaise: rupeesToPaise(4500), gstMultiplier: String(g.iot), configVersionId: cv },
      ]);
    }

    // 4) NBFCs
    const [bp] = await tx.insert(calcNbfcs).values({
      nbfcCode: "battery_pool", name: "BatteryPool", variant: "A",
      maxLoanCapPaise: rupeesToPaise(SEED.BatteryPool.flatMaxLoan),
      flatInterestRate: String(SEED.BatteryPool.flatRateGstInclusive),
      fileFeePaise: rupeesToPaise(SEED.BatteryPool.fileFee),
      defaultProcessingFeePaise: rupeesToPaise(SEED.BatteryPool.processingFee),
      configVersionId: cv,
    }).returning({ id: calcNbfcs.id });

    const [delo] = await tx.insert(calcNbfcs).values({
      nbfcCode: "delovita", name: "Delovita", variant: "A",
      maxLoanCapPaise: rupeesToPaise(SEED.Delovita.flatMaxLoan),
      flatInterestRate: String(SEED.Delovita.flatRateGstInclusive),
      fileFeePaise: rupeesToPaise(SEED.Delovita.fileFee),
      defaultProcessingFeePaise: rupeesToPaise(SEED.Delovita.processingFee),
      configVersionId: cv,
    }).returning({ id: calcNbfcs.id });

    const [bajaj] = await tx.insert(calcNbfcs).values({
      nbfcCode: "bajaj", name: "Bajaj", variant: "B",
      maxLoanCapPaise: null, flatInterestRate: null,
      fileFeePaise: rupeesToPaise(SEED.Bajaj.fileFee),
      defaultProcessingFeePaise: rupeesToPaise(1770),
      configVersionId: cv,
    }).returning({ id: calcNbfcs.id });

    // 5) schemes — Variant A copies flat rate + processing onto each scheme
    await tx.insert(calcSchemes).values(
      SEED.BatteryPool.schemes.map((s) => ({
        nbfcId: bp.id, tenureMonths: s.tenure, advanceMonths: s.advance, code: s.code,
        appliedInterestRate: String(SEED.BatteryPool.flatRateGstInclusive),
        processingFeePaise: rupeesToPaise(SEED.BatteryPool.processingFee),
        advanceInterestRate: "0", configVersionId: cv,
      })),
    );
    await tx.insert(calcSchemes).values(
      SEED.Delovita.schemes.map((s) => ({
        nbfcId: delo.id, tenureMonths: s.tenure, advanceMonths: s.advance, code: s.code,
        appliedInterestRate: String(SEED.Delovita.flatRateGstInclusive),
        processingFeePaise: rupeesToPaise(SEED.Delovita.processingFee),
        advanceInterestRate: "0", configVersionId: cv,
      })),
    );
    // Variant B (Bajaj) — per-scheme rate / processing / advance rate
    await tx.insert(calcSchemes).values(
      SEED.Bajaj.schemes.map((s) => ({
        nbfcId: bajaj.id, tenureMonths: s.tenure, advanceMonths: s.advance, code: s.code,
        appliedInterestRate: String(s.appliedInterestRate),
        processingFeePaise: rupeesToPaise(s.processingFee),
        advanceInterestRate: String(s.advanceInterestRate),
        configVersionId: cv,
      })),
    );

    // 6) Bajaj per-model caps
    await tx.insert(calcNbfcModelCaps).values(
      MODELS.map((m) => ({
        nbfcId: bajaj.id, modelId: modelIdByName.get(m.displayName)!,
        maxLoanCapPaise: m.bajajCapPaise, configVersionId: cv,
      })),
    );

    // 7) coverage — Bajaj Pan-India; BatteryPool + Delovita city lists
    await tx.insert(calcNbfcCoverage).values({
      nbfcId: bajaj.id, coverageType: "PAN_INDIA",
      cityNormalized: null, stateCode: null, cityDisplay: null, configVersionId: cv,
    });
    await tx.insert(calcNbfcCoverage).values(
      DELOVITA_CITIES.map(([city, st]) => ({
        nbfcId: delo.id, coverageType: "CITY" as const,
        cityNormalized: city.toLowerCase(), stateCode: st, cityDisplay: city, configVersionId: cv,
      })),
    );
    await tx.insert(calcNbfcCoverage).values(
      BATTERYPOOL_CITIES.map(([city, st]) => ({
        nbfcId: bp.id, coverageType: "CITY" as const,
        cityNormalized: city.toLowerCase(), stateCode: st, cityDisplay: city, configVersionId: cv,
      })),
    );

    console.log(`✅ seeded calculator config version #${cv}: ${MODELS.length} models, 3 NBFCs, ` +
      `${SEED.BatteryPool.schemes.length + SEED.Delovita.schemes.length + SEED.Bajaj.schemes.length} schemes, ` +
      `${MODELS.length} Bajaj caps, ${DELOVITA_CITIES.length + BATTERYPOOL_CITIES.length + 1} coverage rows.`);
  });
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error("❌ seed failed:", e); process.exit(1); });

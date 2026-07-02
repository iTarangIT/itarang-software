/**
 * Config resolver — the ONLY place that touches the DB for the calculator.
 * Loads the CURRENT (valid_to IS NULL) config, converts PAISE -> RUPEES, and hands
 * the verified engine a plain EngineContext. The engine stays pure/deterministic.
 *
 * Precedence & rules mirror the handoff spec:
 *   - dealer margin: per-model override -> global settings
 *   - eligible NBFCs: coverage_type = 'PAN_INDIA' OR city_normalized = :city
 *   - Variant A: flat cap + rate from calc_nbfcs; Variant B: per-model cap + per-scheme rate
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  calcSettings,
  calcBatteryModels,
  calcComponentPrices,
  calcDealerMarginOverrides,
  calcNbfcs,
  calcSchemes,
  calcNbfcModelCaps,
  calcNbfcCoverage,
  calcConfigVersions,
} from "@/lib/db/schema";
import {
  paiseToRupees,
  type EngineContext,
  type GlobalConfig,
  type ModelComponents,
  type NbfcConfig,
  type ResolvedNbfc,
  type SchemeConfig,
} from "@/lib/calculator/engine";

export class CalculatorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalculatorConfigError";
  }
}

export interface ResolvedFooter {
  disclaimer: string;
  phone: string;
  email: string;
  whatsapp: string;
}

export interface ResolvedConfig {
  ctx: EngineContext;
  configVersionId: number | null;
  model: { id: number; skuCode: string; displayName: string };
  footer: ResolvedFooter;
  /** Per-card indicative disclaimer (distinct from the footer block). */
  cardDisclaimer: string;
}

const n = (v: string | null | undefined, fallback = 0): number => (v == null ? fallback : Number(v));

/** Resolve everything the engine needs for one (model, city) request. */
export async function resolveEngineContext(params: {
  modelId: number;
  city?: string | null;
}): Promise<ResolvedConfig> {
  const cityNorm = params.city ? params.city.trim().toLowerCase() : null;

  const [settings] = await db
    .select()
    .from(calcSettings)
    .where(isNull(calcSettings.validTo))
    .limit(1);
  if (!settings) {
    throw new CalculatorConfigError(
      "No active calculator settings found. Apply E-177 and run `npm run seed:calculator`.",
    );
  }

  const [model] = await db
    .select()
    .from(calcBatteryModels)
    .where(and(eq(calcBatteryModels.id, params.modelId), eq(calcBatteryModels.status, "active")))
    .limit(1);
  if (!model) {
    throw new CalculatorConfigError(`Battery model ${params.modelId} not found or inactive.`);
  }

  // Component prices (current) for this model.
  const comps = await db
    .select()
    .from(calcComponentPrices)
    .where(and(eq(calcComponentPrices.modelId, params.modelId), isNull(calcComponentPrices.validTo)));
  const byComp = new Map(comps.map((c) => [c.component, c]));
  if (!byComp.has("battery")) {
    throw new CalculatorConfigError(`No current battery price for model ${model.displayName}.`);
  }
  const amt = (k: string) => {
    const c = byComp.get(k as never);
    return c ? paiseToRupees(c.amountPaise) : 0;
  };
  const gst = (k: string, fallback: number) => {
    const c = byComp.get(k as never);
    return c ? Number(c.gstMultiplier) : fallback;
  };
  const components: ModelComponents = {
    model: model.displayName,
    skuCode: model.skuCode,
    battery: amt("battery"),
    charger: amt("charger"),
    harness: amt("harness"),
    soc: amt("soc"),
    iot: amt("iot"),
    gstBattery: gst("battery", 1.18),
    gstCharger: gst("charger", 1.05),
    gstHarness: gst("harness", 1.18),
    gstSoc: gst("soc", 1.18),
    gstIot: gst("iot", 1.18),
  };

  // Dealer margin: per-model override -> global.
  const [override] = await db
    .select()
    .from(calcDealerMarginOverrides)
    .where(and(eq(calcDealerMarginOverrides.modelId, params.modelId), isNull(calcDealerMarginOverrides.validTo)))
    .limit(1);
  const dealerMargin = paiseToRupees(override ? override.dealerMarginPaise : settings.dealerMarginPaise);

  // Eligible NBFCs by coverage.
  const [nbfcs, coverage, schemes, caps] = await Promise.all([
    db.select().from(calcNbfcs).where(and(eq(calcNbfcs.status, "active"), isNull(calcNbfcs.validTo))),
    db.select().from(calcNbfcCoverage).where(isNull(calcNbfcCoverage.validTo)),
    db.select().from(calcSchemes).where(and(eq(calcSchemes.status, "active"), isNull(calcSchemes.validTo))),
    db
      .select()
      .from(calcNbfcModelCaps)
      .where(and(eq(calcNbfcModelCaps.modelId, params.modelId), isNull(calcNbfcModelCaps.validTo))),
  ]);

  const eligibleIds = new Set<number>();
  for (const c of coverage) {
    if (c.coverageType === "PAN_INDIA") eligibleIds.add(c.nbfcId);
    else if (cityNorm && c.cityNormalized === cityNorm) eligibleIds.add(c.nbfcId);
  }

  const schemesByNbfc = new Map<number, typeof schemes>();
  for (const s of schemes) {
    const arr = schemesByNbfc.get(s.nbfcId) ?? [];
    arr.push(s);
    schemesByNbfc.set(s.nbfcId, arr);
  }
  const capByNbfc = new Map(caps.map((c) => [c.nbfcId, c.maxLoanCapPaise]));

  const eligibleNbfcs: ResolvedNbfc[] = [];
  for (const nb of nbfcs) {
    if (!eligibleIds.has(nb.id)) continue;
    const rows = schemesByNbfc.get(nb.id) ?? [];
    const nbfcConfig: NbfcConfig = {
      name: nb.name,
      variant: nb.variant,
      flatMaxLoan: nb.maxLoanCapPaise != null ? paiseToRupees(nb.maxLoanCapPaise) : undefined,
      fileFee: paiseToRupees(nb.fileFeePaise),
      schemes: rows.map<SchemeConfig>((s) => ({
        code: s.code,
        tenure: s.tenureMonths,
        advance: s.advanceMonths,
        appliedInterestRate: n(s.appliedInterestRate),
        processingFee: paiseToRupees(s.processingFeePaise ?? nb.defaultProcessingFeePaise),
        advanceInterestRate: n(s.advanceInterestRate),
        active: true,
      })),
    };
    const modelCap =
      nb.variant === "B" && capByNbfc.get(nb.id) != null
        ? paiseToRupees(capByNbfc.get(nb.id)!)
        : undefined;
    eligibleNbfcs.push({ nbfc: nbfcConfig, modelCap });
  }

  const global: GlobalConfig = {
    dealerMargin,
    nearBestWindowPct: n(settings.nearBestWindowPct, 25),
    expectedEmiFilterRequired: settings.expectedEmiFilterRequired,
    upfrontFilterRequired: settings.upfrontFilterRequired,
  };

  const [latest] = await db
    .select({ id: calcConfigVersions.id })
    .from(calcConfigVersions)
    .orderBy(desc(calcConfigVersions.id))
    .limit(1);

  return {
    ctx: { global, components, eligibleNbfcs },
    configVersionId: latest?.id ?? null,
    model: { id: model.id, skuCode: model.skuCode, displayName: model.displayName },
    footer: {
      disclaimer: settings.cardFooterDisclaimer,
      phone: settings.contactPhone,
      email: settings.contactEmail,
      whatsapp: settings.contactWhatsapp,
    },
    cardDisclaimer: settings.disclaimerText,
  };
}

export interface ConfigMeta {
  models: { id: number; skuCode: string; displayName: string }[];
  tenures: number[];
  cities: { display: string; normalized: string; stateCode: string | null }[];
  filters: { expectedEmiRequired: boolean; upfrontRequired: boolean };
}

/** Dropdown data for Card 1: active models, available tenures, coverage cities. */
export async function resolveConfigMeta(): Promise<ConfigMeta> {
  const [models, schemeRows, coverageCities, settingsRow] = await Promise.all([
    db
      .select({ id: calcBatteryModels.id, skuCode: calcBatteryModels.skuCode, displayName: calcBatteryModels.displayName })
      .from(calcBatteryModels)
      .where(eq(calcBatteryModels.status, "active")),
    db
      .select({ tenure: calcSchemes.tenureMonths })
      .from(calcSchemes)
      .where(and(eq(calcSchemes.status, "active"), isNull(calcSchemes.validTo))),
    db
      .select({
        display: calcNbfcCoverage.cityDisplay,
        normalized: calcNbfcCoverage.cityNormalized,
        stateCode: calcNbfcCoverage.stateCode,
      })
      .from(calcNbfcCoverage)
      .where(and(eq(calcNbfcCoverage.coverageType, "CITY"), isNull(calcNbfcCoverage.validTo))),
    db.select().from(calcSettings).where(isNull(calcSettings.validTo)).limit(1),
  ]);

  const tenures = [...new Set(schemeRows.map((r) => r.tenure))].sort((a, b) => a - b);

  const cityMap = new Map<string, { display: string; normalized: string; stateCode: string | null }>();
  for (const c of coverageCities) {
    if (!c.normalized) continue;
    if (!cityMap.has(c.normalized)) {
      cityMap.set(c.normalized, {
        display: c.display ?? c.normalized,
        normalized: c.normalized,
        stateCode: c.stateCode,
      });
    }
  }
  const cities = [...cityMap.values()].sort((a, b) => a.display.localeCompare(b.display));

  const settings = settingsRow[0];
  return {
    models: models.sort((a, b) => a.displayName.localeCompare(b.displayName)),
    tenures,
    cities,
    filters: {
      expectedEmiRequired: settings?.expectedEmiFilterRequired ?? false,
      upfrontRequired: settings?.upfrontFilterRequired ?? false,
    },
  };
}

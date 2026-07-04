/**
 * iTarang Customer Loan Calculator — Calculation Engine (pure, deterministic).
 *
 * Reproduces the realisation workbook EXACTLY for both NBFC variants.
 * Verified: 15/15 golden cases pass (see itarang_calculator_golden_tests.ts).
 *
 *   Variant A (BatteryPool, Delovita): interest folded into EMI; flat cap;
 *       one flat interest rate + one processing fee for the whole NBFC.
 *   Variant B (Bajaj): down payment = 0 (cap > price); interest + advance interest
 *       absorbed into the FILE CHARGE, not the EMI; per-MODEL cap; and crucially
 *       interest rate / processing fee / advance-interest rate are PER-SCHEME,
 *       not NBFC-wide (the sheet varies all three by scheme).
 *
 * Column algebra reproduced (sheet → code):
 *   L price_with_gst = (battery+harness+soc+iot)*gstGoods + charger*gstCharger
 *   N price_to_driver = L + dealerMargin
 *   O loan = MIN(price_to_driver, cap)
 *   AB down_payment = price_to_driver - loan
 *   T interest = loan * rate * tenure/12              (rate is GST-inclusive)
 *   Y advance_interest = loan * advanceRate * tenure/12
 *   W advance_emi = round(loan/tenure * advance)
 *   AC file_charge = ROUNDUP(W + processing + Z + fileFee + Y + AB)
 *        where Z = interest (T) for variant B, else 0
 *   AD = loan - advance_emi + interest (A)  |  loan - advance_emi (B)
 *   AE emi = ROUNDUP(AD / (tenure - advance))
 *
 * MONEY UNITS: rupees (floats) internally to mirror the sheet; integer-rupee outputs.
 * DB stores paise — convert at the boundary (paiseToRupees/rupeesToPaise).
 */

/* ── TYPES ─────────────────────────────────────────────────────────────── */

export type EngineVariant = "A" | "B";

export interface ModelComponents {
  model: string;
  skuCode: string; // stable identity, e.g. "TKLiEV-51105" — joins use this, not the display name
  battery: number;
  charger: number;
  harness: number;
  soc: number;
  iot: number;
  // Per-component GST multipliers (e.g. 1.18 goods, 1.05 charger). Stored explicitly so the
  // engine never hardcodes GST and an admin can vary it per component.
  gstBattery: number;
  gstCharger: number;
  gstHarness: number;
  gstSoc: number;
  gstIot: number;
}

export interface SchemeConfig {
  code: string; // "16by3"
  tenure: number; // months
  advance: number; // advance-EMI months (must be < tenure)
  /** GST-inclusive monthly-rate multiplier; interest = loan*rate*tenure/12. */
  appliedInterestRate: number; // GST-inclusive rate actually used in interest = loan*rate*tenure/12 (NOT a display/MBD rate)
  /** GST-inclusive processing fee in rupees. Per-scheme for B; for A pass the NBFC flat value here too. */
  processingFee: number;
  /** advance-interest rate; advanceInterest = loan*rate*tenure/12. 0 for variant A. */
  advanceInterestRate: number;
  active: boolean;
}

export interface NbfcConfig {
  name: string;
  variant: EngineVariant;
  /** Variant A only: flat cap (rupees). Variant B: omit (per-model cap supplied separately). */
  flatMaxLoan?: number;
  /** GST-inclusive NBFC file fee in rupees (e.g. 5000*1.18). */
  fileFee: number;
  schemes: SchemeConfig[];
}

export interface GlobalConfig {
  dealerMargin: number; // rupees, GST-inclusive (e.g. 6000)
  nearBestWindowPct: number; // e.g. 25
  expectedEmiFilterRequired: boolean;
  upfrontFilterRequired: boolean;
}

export interface Card1Input {
  model: string;
  tenure: number;
  expectedEmi?: number; // optional filter
  upfrontAbility?: number; // optional filter (max TOTAL upfront)
  city?: string;
}

export interface ResolvedNbfc {
  nbfc: NbfcConfig;
  /** Variant B: per-model cap (rupees) for the requested model. Variant A: omit. */
  modelCap?: number;
}

export interface EngineContext {
  global: GlobalConfig;
  components: ModelComponents; // for the requested model
  eligibleNbfcs: ResolvedNbfc[]; // already city-filtered by caller
}

/* ── OUTPUT ────────────────────────────────────────────────────────────── */

export type Tier = "qualified" | "stretch";

export interface SchemeCard {
  nbfc: string;
  variant: EngineVariant;
  schemeCode: string;
  tenure: number;
  advance: number;
  remainingMonths: number; // tenure - advance (number of EMIs at `emi`)
  priceToDriver: number;
  loanAmount: number;
  emi: number;
  /** The single amount payable today. Itemised in `breakdown`. */
  totalUpfront: number;
  breakdown: UpfrontBreakdown;
  /** For honest comparison alongside "lowest EMI" recommendation. */
  estimatedTotalPayable: number; // totalUpfront + emi * remainingMonths
  tier: Tier;
  recommended: boolean;
  recommendationLabel?: string; // e.g. "Lowest monthly EMI" | "Closest to qualify"
  stretchDistance?: number; // normalised distance to qualifying (stretch cards only)
  stretch?: {
    failsEmi: boolean;
    failsUpfront: boolean;
    upfrontGap: number; // extra rupees of upfront ability needed
    requiredEmi: number; // EMI the customer must accept (only if failsEmi)
    distance: number; // normalised distance to qualifying (smaller = easier to unlock)
  };
}

export interface CalcResult {
  qualified: SchemeCard[];
  stretch: SchemeCard[];
  outcome: "qualified" | "stretch_only" | "none";
}

/* ── CORE: single scheme (rupee-exact vs sheet) ────────────────────────── */

// Excel ROUNDUP(x, 0): ceil to the next rupee. We must NOT pre-round to paise first —
// doing so collapses e.g. 25647.002075 -> 25647.00 and ceil() then returns 25647 instead
// of 25648. The tiny epsilon absorbs floating-point noise (e.g. 6097.0000000001) without
// swallowing a genuine fraction like .002075.
const EPS = 1e-6;
const roundUp = (x: number) => Math.ceil(x - EPS);
const round = (x: number) => Math.round(x);

export interface UpfrontBreakdown {
  downPayment: number;
  advanceInstallmentsTotal: number; // total of advance EMIs collected upfront (NOT one EMI)
  nbfcFileFee: number;
  processingFee: number;
  interestChargedUpfront: number;   // variant B only (folded into upfront); 0 for A
  advanceInterest: number;          // variant B only; 0 for A
  totalUpfront: number;             // = sum of the above = the workbook's single upfront figure
}

export interface RawScheme {
  priceToDriver: number;
  loanAmount: number;
  /** The single amount the customer pays today. Equals the workbook's "Driver upfront".
   *  Itemised in `breakdown`. Do NOT add downPayment/advance on top — they are already inside. */
  upfrontPayable: number;
  breakdown: UpfrontBreakdown;
  emi: number;                      // monthly EMI for the (tenure - advance) remaining months
  remainingMonths: number;          // tenure - advance
}

export function computeScheme(
  comp: ModelComponents,
  dealerMargin: number,
  nbfc: NbfcConfig,
  scheme: SchemeConfig,
  modelCap: number | undefined,
): RawScheme {
  if (scheme.advance >= scheme.tenure) {
    throw new Error(`Scheme ${scheme.code}: advance (${scheme.advance}) must be < tenure (${scheme.tenure})`);
  }

  // Per-component GST (flexible model). Each component carries its own multiplier so an
  // admin can set, e.g., a different GST on IoT without the engine ignoring it.
  const priceWithGst =
    comp.battery * comp.gstBattery +
    comp.harness * comp.gstHarness +
    comp.soc * comp.gstSoc +
    comp.iot * comp.gstIot +
    comp.charger * comp.gstCharger;
  const priceToDriver = priceWithGst + dealerMargin;

  const cap = nbfc.variant === "B" ? modelCap : nbfc.flatMaxLoan;
  if (cap == null || Number.isNaN(cap)) {
    throw new Error(
      `Missing max-loan cap for NBFC ${nbfc.name} (variant ${nbfc.variant}), model ${comp.model}`,
    );
  }

  const loanAmount = Math.min(priceToDriver, cap);
  const downPayment = priceToDriver - loanAmount;

  const { tenure, advance } = scheme;
  const interest = (loanAmount * scheme.appliedInterestRate * tenure) / 12;
  const advanceInterest = (loanAmount * scheme.advanceInterestRate * tenure) / 12;
  // Total advance instalments collected upfront (NOT a single EMI).
  const advanceInstallmentsTotal = round((loanAmount / tenure) * advance);

  // Variant B folds interest into the upfront; variant A folds it into the EMI instead.
  const interestChargedUpfront = nbfc.variant === "B" ? interest : 0;

  // The workbook's single upfront figure already CONTAINS down payment + advance instalments.
  // This is the only amount the customer pays today; never add the parts on top of it again.
  const upfrontPayable = roundUp(
    advanceInstallmentsTotal +
      scheme.processingFee +
      interestChargedUpfront +
      nbfc.fileFee +
      advanceInterest +
      downPayment,
  );

  const adBase =
    nbfc.variant === "B"
      ? loanAmount - advanceInstallmentsTotal
      : loanAmount - advanceInstallmentsTotal + interest;
  const remainingMonths = tenure - advance;
  const emi = roundUp(adBase / remainingMonths);

  const breakdown: UpfrontBreakdown = {
    downPayment,
    advanceInstallmentsTotal,
    nbfcFileFee: nbfc.fileFee,
    processingFee: scheme.processingFee,
    interestChargedUpfront,
    advanceInterest,
    totalUpfront: upfrontPayable,
  };

  return { priceToDriver, loanAmount, upfrontPayable, breakdown, emi, remainingMonths };
}

/* ── CARD 2: eligibility, three-tier filter, recommendation ─────────────── */

export class ValidationError extends Error {
  constructor(public field: string, message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function calculate(ctx: EngineContext, input: Card1Input): CalcResult {
  const { global, components, eligibleNbfcs } = ctx;

  // Enforce admin-configured required filters. The public API should catch ValidationError
  // and return a structured 400, rather than letting it bubble as a 500.
  if (global.expectedEmiFilterRequired && input.expectedEmi == null) {
    throw new ValidationError("expectedEmi", "Expected EMI is required");
  }
  if (global.upfrontFilterRequired && input.upfrontAbility == null) {
    throw new ValidationError("upfrontAbility", "Upfront payment ability is required");
  }
  if (input.expectedEmi != null && input.expectedEmi < 0) {
    throw new ValidationError("expectedEmi", "Expected EMI cannot be negative");
  }
  if (input.upfrontAbility != null && input.upfrontAbility < 0) {
    throw new ValidationError("upfrontAbility", "Upfront ability cannot be negative");
  }

  const cards: SchemeCard[] = [];

  for (const { nbfc, modelCap } of eligibleNbfcs) {
    for (const scheme of nbfc.schemes) {
      if (!scheme.active) continue;
      if (scheme.tenure !== input.tenure) continue; // exact-match; caller may map to nearest first

      const raw = computeScheme(components, global.dealerMargin, nbfc, scheme, modelCap);
      // FIX: totalUpfront is the workbook's single upfront figure — already contains
      // down payment + advance instalments. Do NOT re-add the parts.
      const totalUpfront = raw.upfrontPayable;
      const estimatedTotalPayable = totalUpfront + raw.emi * raw.remainingMonths;

      cards.push({
        nbfc: nbfc.name,
        variant: nbfc.variant,
        schemeCode: scheme.code,
        tenure: scheme.tenure,
        advance: scheme.advance,
        remainingMonths: raw.remainingMonths,
        priceToDriver: raw.priceToDriver,
        loanAmount: raw.loanAmount,
        emi: raw.emi,
        totalUpfront,
        breakdown: raw.breakdown,
        estimatedTotalPayable,
        tier: "qualified", // provisional; set below
        recommended: false,
      });
    }
  }

  const expEmi = input.expectedEmi;
  const upAbility = input.upfrontAbility;
  const windowFactor = 1 + global.nearBestWindowPct / 100;

  const qualified: SchemeCard[] = [];
  const stretch: SchemeCard[] = [];

  for (const card of cards) {
    const emiOk = expEmi == null ? true : card.emi <= expEmi;
    const upfrontOk = upAbility == null ? true : card.totalUpfront <= upAbility;

    if (emiOk && upfrontOk) {
      card.tier = "qualified";
      qualified.push(card);
      continue;
    }

    const failsEmi = expEmi != null && card.emi > expEmi;
    const failsUpfront = upAbility != null && card.totalUpfront > upAbility;
    const failCount = (failsEmi ? 1 : 0) + (failsUpfront ? 1 : 0);

    if (failCount === 1) {
      const withinWindow =
        (failsEmi && expEmi != null && card.emi <= expEmi * windowFactor) ||
        (failsUpfront && upAbility != null && card.totalUpfront <= upAbility * windowFactor);
      if (withinWindow) {
        // Normalised distance to qualifying — how big a change the customer must make.
        const distance =
          failsEmi && expEmi != null
            ? (card.emi - expEmi) / expEmi
            : failsUpfront && upAbility != null
              ? (card.totalUpfront - upAbility) / upAbility
              : 0;
        card.tier = "stretch";
        card.stretchDistance = distance;
        card.stretch = {
          failsEmi,
          failsUpfront,
          upfrontGap: failsUpfront && upAbility != null ? card.totalUpfront - upAbility : 0,
          requiredEmi: failsEmi ? card.emi : 0,
          distance,
        };
        stretch.push(card);
      }
    }
    // failCount === 2 → dropped
  }

  qualified.sort((a, b) => a.emi - b.emi || a.totalUpfront - b.totalUpfront);
  stretch.sort((a, b) => (a.stretchDistance ?? 0) - (b.stretchDistance ?? 0));

  if (qualified.length > 0) {
    qualified[0].recommended = true;
    qualified[0].recommendationLabel = "Lowest monthly EMI";
  } else if (stretch.length > 0) {
    stretch[0].recommended = true;
    stretch[0].recommendationLabel = "Closest to qualify";
  }

  const outcome: CalcResult["outcome"] =
    qualified.length > 0 ? "qualified" : stretch.length > 0 ? "stretch_only" : "none";

  return { qualified, stretch, outcome };
}

/* ── HELPERS ───────────────────────────────────────────────────────────── */

/** Variant A: every scheme shares the NBFC's flat rate + flat processing fee, advanceRate 0. */
export function buildVariantASchemes(
  raw: { code: string; tenure: number; advance: number; active: boolean }[],
  flatRateGstInclusive: number,
  flatProcessingFee: number,
): SchemeConfig[] {
  return raw.map((s) => ({
    ...s,
    appliedInterestRate: flatRateGstInclusive,
    processingFee: flatProcessingFee,
    advanceInterestRate: 0,
  }));
}

export const paiseToRupees = (p: number) => p / 100;
export const rupeesToPaise = (r: number) => Math.round(r * 100);

/* ── VERIFIED SEED CONSTANTS (from realisation workbook) ────────────────── */
/* GST-inclusive values. Use to seed config; admin can override per the schema. */

export const SEED = {
  // Per-component GST multipliers (goods 1.18 applies to battery/harness/soc/iot; charger 1.05).
  gst: { battery: 1.18, harness: 1.18, soc: 1.18, iot: 1.18, charger: 1.05 },
  dealerMargin: 6000,

  BatteryPool: {
    variant: "A" as const,
    flatMaxLoan: 62000,
    flatRateGstInclusive: 0.18,
    fileFee: 5000 * 1.18, // 5900
    processingFee: 1356 * 1.18, // 1600.08
    schemes: [
      { code: "12by0", tenure: 12, advance: 0, active: true },
      { code: "15by0", tenure: 15, advance: 0, active: true },
      { code: "18by0", tenure: 18, advance: 0, active: true },
    ],
  },

  Delovita: {
    variant: "A" as const,
    flatMaxLoan: 56700,
    flatRateGstInclusive: 0.2,
    fileFee: 3000 * 1.18, // 3540
    processingFee: 3271 * 1.18, // 3859.78
    schemes: [{ code: "12by0", tenure: 12, advance: 0, active: true }],
  },

  Bajaj: {
    variant: "B" as const,
    fileFee: 399 * 1.18, // 470.82
    // per-scheme: interest rate (GST-incl), processing fee (GST-incl rupees), advance-interest rate
    schemes: [
      { code: "16by3", tenure: 16, advance: 3, appliedInterestRate: 0.15222, processingFee: 1770, advanceInterestRate: 0.015, active: true },
      { code: "17by3", tenure: 17, advance: 3, appliedInterestRate: 0.15222, processingFee: 1770, advanceInterestRate: 0.015, active: true },
      { code: "18by3", tenure: 18, advance: 3, appliedInterestRate: 0.15222, processingFee: 1770, advanceInterestRate: 0.015, active: true },
      { code: "12by0", tenure: 12, advance: 0, appliedInterestRate: 0.15222, processingFee: 1770, advanceInterestRate: 0.015, active: true },
      { code: "12by1", tenure: 12, advance: 1, appliedInterestRate: 0.15222, processingFee: 1770, advanceInterestRate: 0.015, active: true },
      { code: "8by0", tenure: 8, advance: 0, appliedInterestRate: 0.1267084, processingFee: 1770, advanceInterestRate: 0.015, active: true },
      { code: "9by1", tenure: 9, advance: 1, appliedInterestRate: 0.1155692, processingFee: 1770, advanceInterestRate: 0.015, active: true },
      { code: "10by2", tenure: 10, advance: 2, appliedInterestRate: 0.10443, processingFee: 1770, advanceInterestRate: 0.015, active: true },
      { code: "12by4", tenure: 12, advance: 4, appliedInterestRate: 0.0863288, processingFee: 1180, advanceInterestRate: 0, active: true },
    ],
    // per-model max loan (rupees), keyed by STABLE SKU (display names can be reformatted).
    // Public calc must resolve: requested model -> model_id -> sku_code -> this cap.
    modelCapsBySku: {
      "TKLiEV-51105": 77500,
      "TKLiEV-51140": 102297,
      "TKLiEV-51153": 123551,
      "TKLiEV-51232 JN": 154015,
      "TKLiEV-61105": 88128,
      "TKLiEV-64105": 91670,
      "TKLiEV-61140": 115049,
      "TKLiEV-64140": 122134,
      "TKLiEV-61153": 139137,
      "TKLiEV-64153": 146931,
      "TKLiEV-61232 JN": 175978,
      "TKLi-51105 PRIME": 83168,
      "TKLiEV-51206 AN": 147639,
      "TKLiEV-51314 JN": 195815,
      "TKLiEV-61206 AN": 171727,
      "TKLiEV-64232 JN": 183771,
      "TKLiEV-61314 JN": 221320,
      "TKLiEV-73105": 101588,
      "TKLiEV-73140": 137720,
      "TKLiEV-73232 JN": 208567,
    } as Record<string, number>,
    // Back-compat display-name map (DERIVED; prefer modelCapsBySku for joins).
    modelCaps: {
      "51.2V - 105 AMP": 77500,
      "51.2V - 140 AMP": 102297,
      "51.2V - 153 AMP": 123551,
      "51.2V - 232 AMP - JN": 154015,
      "60.8V - 105 AMP": 88128,
      "64V - 105 AMP": 91670,
      "60.8V - 140 AMP": 115049,
      "64V - 140 AMP": 122134,
      "60.8V - 153 AMP": 139137,
      "64V - 153 AMP": 146931,
      "60.8V - 232 AMP - JN": 175978,
      "51.2V - 105 AMP - Prime": 83168,
      "51.2V - 206 AMP - AN": 147639,
      "51.2V - 314 AMP - JN": 195815,
      "60.8V - 206 AMP - AN": 171727,
      "64V - 232 AMP - JN": 183771,
      "60.8V - 314 AMP - JN": 221320,
      "73.6V - 105 AMP": 101588,
      "73.6V - 140 AMP": 137720,
      "73.6V - 232 AMP - JN": 208567,
    } as Record<string, number>,
  },
};

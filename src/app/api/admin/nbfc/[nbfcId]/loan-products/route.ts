import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { nbfc, nbfcLoanProducts } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/requireAdmin";

// E-009 — NBFC Loan Product Configuration (BRD 6.0.5)
// CRUD endpoints for the per-NBFC loan-product catalogue.

// Triple-guarded auth bypass for the in-process AC test runner. ALL three
// guards must hold:
//   1. NODE_ENV !== 'production'
//   2. NBFC_E009_TEST_BYPASS_AUTH === '1'
//   3. The request carries the matching x-nbfc-e009-test-bypass header.
function isTestBypass(req: NextRequest): boolean {
  if (process.env.NODE_ENV === "production") return false;
  if (process.env.NBFC_E009_TEST_BYPASS_AUTH !== "1") return false;
  const expected = process.env.NBFC_E009_TEST_BYPASS_TOKEN;
  if (!expected) return false;
  return req.headers.get("x-nbfc-e009-test-bypass") === expected;
}

const BATTERY_CATEGORIES = ["3W", "2W", "4W", "INVERTER", "SOLAR"] as const;
const DISBURSEMENT_METHODS = [
  "direct_to_dealer",
  "rtgs_to_dealer",
  "escrow",
] as const;
const STATUS_VALUES = ["active", "inactive"] as const;
const NBFC_ELIGIBLE_STATUSES = new Set(["approved", "active"]);

const createBodySchema = z
  .object({
    productName: z.string().min(1).max(120),
    eligibleBatteryCategories: z.array(z.enum(BATTERY_CATEGORIES)).min(1),
    loanAmountMin: z.number().int().nonnegative(),
    loanAmountMax: z.number().int().positive(),
    tenureMonthsMin: z.number().int().positive(),
    tenureMonthsMax: z.number().int().positive(),
    minRoiPct: z.number().nonnegative(),
    maxRoiPct: z.number().nonnegative(),
    downPaymentPct: z.number().min(0).max(100),
    subventionAvailable: z.boolean(),
    fileChargeFixed: z.number().nonnegative().optional(),
    fileChargePct: z.number().min(0).max(100).optional(),
    disbursementMethod: z.enum(DISBURSEMENT_METHODS),
    status: z.enum(STATUS_VALUES).default("active"),
    activeLocations: z
      .array(
        z.object({
          state: z.string().trim().min(1).max(80),
          city: z.string().trim().min(1).max(120),
        }),
      )
      .default([]),
    processingFeeOwnedRupees: z.number().int().nonnegative().optional(),
    processingFeeRentedRupees: z.number().int().nonnegative().optional(),
    healthLifeInsuranceOwnedRupees: z.number().int().nonnegative().optional(),
    healthLifeInsuranceRentedRupees: z.number().int().nonnegative().optional(),
    disbursementTatHours: z.number().int().positive().optional(),
    minCreditScore: z.number().int().min(300).max(900).optional(),
    maxCreditScore: z.number().int().min(300).max(900).optional(),
    cibilRequired: z.boolean().optional(),
    eligibilityDocuments: z
      .array(z.string().trim().min(1).max(500))
      .default([]),
  })
  .refine((d) => d.loanAmountMax > d.loanAmountMin, {
    message: "loanAmountMax must be > loanAmountMin",
    path: ["loanAmountMax"],
  })
  .refine((d) => d.tenureMonthsMax >= d.tenureMonthsMin, {
    message: "tenureMonthsMax must be >= tenureMonthsMin",
    path: ["tenureMonthsMax"],
  })
  .refine((d) => d.maxRoiPct >= d.minRoiPct, {
    message: "maxRoiPct must be >= minRoiPct",
    path: ["maxRoiPct"],
  })
  .refine(
    (d) =>
      d.cibilRequired !== true ||
      (d.minCreditScore !== undefined && d.maxCreditScore !== undefined),
    {
      message:
        "minCreditScore and maxCreditScore are required when cibilRequired is true",
      path: ["maxCreditScore"],
    },
  )
  .refine(
    (d) =>
      d.minCreditScore === undefined ||
      d.maxCreditScore === undefined ||
      d.maxCreditScore >= d.minCreditScore,
    {
      message: "maxCreditScore must be >= minCreditScore",
      path: ["maxCreditScore"],
    },
  );

const listQuerySchema = z.object({
  status: z.enum(STATUS_VALUES).optional(),
});

function parseNbfcId(raw: string): number | null {
  const id = Number.parseInt(raw, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ nbfcId: string }> },
) {
  if (!isTestBypass(req)) {
    const auth = await requireAdmin();
    if (!auth.ok) return auth.response;
  }

  const { nbfcId: nbfcIdRaw } = await params;
  const nbfcId = parseNbfcId(nbfcIdRaw);
  if (nbfcId === null) {
    return NextResponse.json(
      { success: false, message: "Invalid nbfcId" },
      { status: 400 },
    );
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, message: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const parsed = createBodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        message: "Validation failed",
        issues: parsed.error.issues,
      },
      { status: 422 },
    );
  }

  // Resolve NBFC and enforce status gate (AC4).
  const [nbfcRow] = await db
    .select({ id: nbfc.id, status: nbfc.status })
    .from(nbfc)
    .where(eq(nbfc.id, nbfcId))
    .limit(1);

  if (!nbfcRow) {
    return NextResponse.json(
      { success: false, message: "NBFC not found" },
      { status: 404 },
    );
  }

  if (!NBFC_ELIGIBLE_STATUSES.has(nbfcRow.status)) {
    return NextResponse.json(
      {
        success: false,
        message:
          "NBFC must be in 'approved' or 'active' status to add loan products",
        nbfcStatus: nbfcRow.status,
      },
      { status: 409 },
    );
  }

  const body = parsed.data;
  const [inserted] = await db
    .insert(nbfcLoanProducts)
    .values({
      nbfc_id: nbfcId,
      product_name: body.productName,
      eligible_battery_categories: body.eligibleBatteryCategories,
      loan_amount_min: body.loanAmountMin,
      loan_amount_max: body.loanAmountMax,
      tenure_months_min: body.tenureMonthsMin,
      tenure_months_max: body.tenureMonthsMax,
      min_roi_pct: body.minRoiPct.toString(),
      max_roi_pct: body.maxRoiPct.toString(),
      down_payment_pct: body.downPaymentPct.toString(),
      subvention_available: body.subventionAvailable,
      file_charge_fixed:
        body.fileChargeFixed !== undefined
          ? body.fileChargeFixed.toString()
          : null,
      file_charge_pct:
        body.fileChargePct !== undefined ? body.fileChargePct.toString() : null,
      disbursement_method: body.disbursementMethod,
      status: body.status,
      active_locations: body.activeLocations,
      processing_fee_owned_rupees: body.processingFeeOwnedRupees ?? null,
      processing_fee_rented_rupees: body.processingFeeRentedRupees ?? null,
      health_life_insurance_owned_rupees:
        body.healthLifeInsuranceOwnedRupees ?? null,
      health_life_insurance_rented_rupees:
        body.healthLifeInsuranceRentedRupees ?? null,
      disbursement_tat_hours: body.disbursementTatHours ?? null,
      // CIBIL gate: when explicitly waived, force both score columns to null
      // so a stale min_credit_score from a prior shape can't leak through.
      cibil_required: body.cibilRequired ?? null,
      min_credit_score:
        body.cibilRequired === false ? null : body.minCreditScore ?? null,
      max_credit_score:
        body.cibilRequired === false ? null : body.maxCreditScore ?? null,
      eligibility_documents: body.eligibilityDocuments,
    })
    .returning({
      id: nbfcLoanProducts.id,
      productName: nbfcLoanProducts.product_name,
      status: nbfcLoanProducts.status,
    });

  return NextResponse.json(
    { success: true, ...inserted },
    { status: 200 },
  );
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ nbfcId: string }> },
) {
  if (!isTestBypass(req)) {
    const auth = await requireAdmin();
    if (!auth.ok) return auth.response;
  }

  const { nbfcId: nbfcIdRaw } = await params;
  const nbfcId = parseNbfcId(nbfcIdRaw);
  if (nbfcId === null) {
    return NextResponse.json(
      { success: false, message: "Invalid nbfcId" },
      { status: 400 },
    );
  }

  const url = new URL(req.url);
  const parsed = listQuerySchema.safeParse({
    status: url.searchParams.get("status") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        message: "Validation failed",
        issues: parsed.error.issues,
      },
      { status: 422 },
    );
  }

  const where = parsed.data.status
    ? and(
        eq(nbfcLoanProducts.nbfc_id, nbfcId),
        eq(nbfcLoanProducts.status, parsed.data.status),
      )
    : eq(nbfcLoanProducts.nbfc_id, nbfcId);

  const items = await db
    .select({
      id: nbfcLoanProducts.id,
      productName: nbfcLoanProducts.product_name,
      loanAmountMin: nbfcLoanProducts.loan_amount_min,
      loanAmountMax: nbfcLoanProducts.loan_amount_max,
      status: nbfcLoanProducts.status,
    })
    .from(nbfcLoanProducts)
    .where(where);

  return NextResponse.json({ success: true, items }, { status: 200 });
}

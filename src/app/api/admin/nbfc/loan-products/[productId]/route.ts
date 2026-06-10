import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  nbfc,
  nbfcLeadAssignments,
  nbfcLoanProducts,
} from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/requireAdmin";

// E-009 — PATCH partial update + single-product GET for nbfc_loan_products.
// nbfc_id cannot change.

const BATTERY_CATEGORIES = ["3W", "2W", "4W", "INVERTER", "SOLAR"] as const;
const DISBURSEMENT_METHODS = [
  "direct_to_dealer",
  "rtgs_to_dealer",
  "escrow",
] as const;
const STATUS_VALUES = ["active", "inactive"] as const;
const CREDIT_BUREAUS = ["equifax", "cibil", "crif", "experian"] as const;

const patchBodySchema = z
  .object({
    productName: z.string().min(1).max(120).optional(),
    eligibleBatteryCategories: z
      .array(z.enum(BATTERY_CATEGORIES))
      .min(1)
      .optional(),
    loanAmountMin: z.number().int().nonnegative().optional(),
    loanAmountMax: z.number().int().positive().optional(),
    tenureMonthsMin: z.number().int().positive().optional(),
    tenureMonthsMax: z.number().int().positive().optional(),
    minRoiPct: z.number().nonnegative().optional(),
    maxRoiPct: z.number().nonnegative().optional(),
    downPaymentPct: z.number().min(0).max(100).optional(),
    subventionAvailable: z.boolean().optional(),
    fileChargeFixed: z.number().nonnegative().nullable().optional(),
    fileChargePct: z.number().min(0).max(100).nullable().optional(),
    disbursementMethod: z.enum(DISBURSEMENT_METHODS).optional(),
    status: z.enum(STATUS_VALUES).optional(),
    // Full-parity fields (mirror the create route). All optional so the older
    // limited payloads still validate.
    activeLocations: z
      .array(
        z.object({
          state: z.string().trim().min(1).max(80),
          city: z.string().trim().min(1).max(120),
        }),
      )
      .optional(),
    processingFeeOwnedRupees: z.number().int().nonnegative().nullable().optional(),
    processingFeeRentedRupees: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional(),
    healthLifeInsuranceOwnedRupees: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional(),
    healthLifeInsuranceRentedRupees: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional(),
    disbursementTatHours: z.number().int().positive().nullable().optional(),
    cibilRequired: z.boolean().nullable().optional(),
    minCreditScore: z.number().int().min(300).max(900).nullable().optional(),
    maxCreditScore: z.number().int().min(300).max(900).nullable().optional(),
    creditBureau: z.enum(CREDIT_BUREAUS).optional(),
    eligibilityDocuments: z
      .array(z.string().trim().min(1).max(500))
      .optional(),
  })
  .strict();

function parseProductId(raw: string): number | null {
  const id = Number.parseInt(raw, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ productId: string }> },
) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const { productId: pidRaw } = await params;
  const productId = parseProductId(pidRaw);
  if (productId === null) {
    return NextResponse.json(
      { success: false, message: "Invalid productId" },
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

  const parsed = patchBodySchema.safeParse(json);
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

  const [existing] = await db
    .select({
      id: nbfcLoanProducts.id,
      loanAmountMin: nbfcLoanProducts.loan_amount_min,
      loanAmountMax: nbfcLoanProducts.loan_amount_max,
      tenureMonthsMin: nbfcLoanProducts.tenure_months_min,
      tenureMonthsMax: nbfcLoanProducts.tenure_months_max,
      minRoiPct: nbfcLoanProducts.min_roi_pct,
      maxRoiPct: nbfcLoanProducts.max_roi_pct,
    })
    .from(nbfcLoanProducts)
    .where(eq(nbfcLoanProducts.id, productId))
    .limit(1);

  if (!existing) {
    return NextResponse.json(
      { success: false, message: "Loan product not found" },
      { status: 404 },
    );
  }

  const body = parsed.data;

  // Cross-field invariants must hold post-merge.
  const finalAmountMin = body.loanAmountMin ?? existing.loanAmountMin;
  const finalAmountMax = body.loanAmountMax ?? existing.loanAmountMax;
  const finalTenureMin = body.tenureMonthsMin ?? existing.tenureMonthsMin;
  const finalTenureMax = body.tenureMonthsMax ?? existing.tenureMonthsMax;
  const finalRoiMin =
    body.minRoiPct ?? Number.parseFloat(existing.minRoiPct);
  const finalRoiMax =
    body.maxRoiPct ?? Number.parseFloat(existing.maxRoiPct);

  if (finalAmountMax <= finalAmountMin) {
    return NextResponse.json(
      {
        success: false,
        message: "loanAmountMax must be > loanAmountMin",
      },
      { status: 422 },
    );
  }
  if (finalTenureMax < finalTenureMin) {
    return NextResponse.json(
      {
        success: false,
        message: "tenureMonthsMax must be >= tenureMonthsMin",
      },
      { status: 422 },
    );
  }
  if (finalRoiMax < finalRoiMin) {
    return NextResponse.json(
      { success: false, message: "maxRoiPct must be >= minRoiPct" },
      { status: 422 },
    );
  }

  const update: Record<string, unknown> = {
    updated_at: new Date(),
  };
  if (body.productName !== undefined) update.product_name = body.productName;
  if (body.eligibleBatteryCategories !== undefined)
    update.eligible_battery_categories = body.eligibleBatteryCategories;
  if (body.loanAmountMin !== undefined)
    update.loan_amount_min = body.loanAmountMin;
  if (body.loanAmountMax !== undefined)
    update.loan_amount_max = body.loanAmountMax;
  if (body.tenureMonthsMin !== undefined)
    update.tenure_months_min = body.tenureMonthsMin;
  if (body.tenureMonthsMax !== undefined)
    update.tenure_months_max = body.tenureMonthsMax;
  if (body.minRoiPct !== undefined)
    update.min_roi_pct = body.minRoiPct.toString();
  if (body.maxRoiPct !== undefined)
    update.max_roi_pct = body.maxRoiPct.toString();
  if (body.downPaymentPct !== undefined)
    update.down_payment_pct = body.downPaymentPct.toString();
  if (body.subventionAvailable !== undefined)
    update.subvention_available = body.subventionAvailable;
  if (body.fileChargeFixed !== undefined)
    update.file_charge_fixed =
      body.fileChargeFixed === null ? null : body.fileChargeFixed.toString();
  if (body.fileChargePct !== undefined)
    update.file_charge_pct =
      body.fileChargePct === null ? null : body.fileChargePct.toString();
  if (body.disbursementMethod !== undefined)
    update.disbursement_method = body.disbursementMethod;
  if (body.status !== undefined) update.status = body.status;
  if (body.activeLocations !== undefined)
    update.active_locations = body.activeLocations;
  if (body.processingFeeOwnedRupees !== undefined)
    update.processing_fee_owned_rupees = body.processingFeeOwnedRupees;
  if (body.processingFeeRentedRupees !== undefined)
    update.processing_fee_rented_rupees = body.processingFeeRentedRupees;
  if (body.healthLifeInsuranceOwnedRupees !== undefined)
    update.health_life_insurance_owned_rupees =
      body.healthLifeInsuranceOwnedRupees;
  if (body.healthLifeInsuranceRentedRupees !== undefined)
    update.health_life_insurance_rented_rupees =
      body.healthLifeInsuranceRentedRupees;
  if (body.disbursementTatHours !== undefined)
    update.disbursement_tat_hours = body.disbursementTatHours;
  if (body.creditBureau !== undefined)
    update.credit_bureau = body.creditBureau;
  if (body.eligibilityDocuments !== undefined)
    update.eligibility_documents = body.eligibilityDocuments;
  // CIBIL gate. Mirrors the create route: when explicitly waived, force both
  // score columns to null so a stale score can't leak through. Score columns
  // only move when the caller sends them.
  if (body.cibilRequired !== undefined) {
    update.cibil_required = body.cibilRequired;
    if (body.cibilRequired === false) {
      update.min_credit_score = null;
      update.max_credit_score = null;
    } else {
      if (body.minCreditScore !== undefined)
        update.min_credit_score = body.minCreditScore;
      if (body.maxCreditScore !== undefined)
        update.max_credit_score = body.maxCreditScore;
    }
  } else {
    if (body.minCreditScore !== undefined)
      update.min_credit_score = body.minCreditScore;
    if (body.maxCreditScore !== undefined)
      update.max_credit_score = body.maxCreditScore;
  }

  const [row] = await db
    .update(nbfcLoanProducts)
    .set(update)
    .where(eq(nbfcLoanProducts.id, productId))
    .returning({
      id: nbfcLoanProducts.id,
      updatedAt: nbfcLoanProducts.updated_at,
    });

  return NextResponse.json(
    { success: true, id: row.id, updatedAt: row.updatedAt },
    { status: 200 },
  );
}

// Single-product fetch for the admin edit screen. Returns the full row plus the
// owning NBFC's name so the edit form can prefill every field.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ productId: string }> },
) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const { productId: pidRaw } = await params;
  const productId = parseProductId(pidRaw);
  if (productId === null) {
    return NextResponse.json(
      { success: false, message: "Invalid productId" },
      { status: 400 },
    );
  }

  const [row] = await db
    .select({
      id: nbfcLoanProducts.id,
      nbfcId: nbfcLoanProducts.nbfc_id,
      nbfcLegalName: nbfc.legal_name,
      nbfcShortName: nbfc.short_name,
      productName: nbfcLoanProducts.product_name,
      eligibleBatteryCategories: nbfcLoanProducts.eligible_battery_categories,
      loanAmountMin: nbfcLoanProducts.loan_amount_min,
      loanAmountMax: nbfcLoanProducts.loan_amount_max,
      tenureMonthsMin: nbfcLoanProducts.tenure_months_min,
      tenureMonthsMax: nbfcLoanProducts.tenure_months_max,
      minRoiPct: nbfcLoanProducts.min_roi_pct,
      maxRoiPct: nbfcLoanProducts.max_roi_pct,
      downPaymentPct: nbfcLoanProducts.down_payment_pct,
      subventionAvailable: nbfcLoanProducts.subvention_available,
      fileChargeFixed: nbfcLoanProducts.file_charge_fixed,
      fileChargePct: nbfcLoanProducts.file_charge_pct,
      disbursementMethod: nbfcLoanProducts.disbursement_method,
      status: nbfcLoanProducts.status,
      activeLocations: nbfcLoanProducts.active_locations,
      processingFeeOwnedRupees: nbfcLoanProducts.processing_fee_owned_rupees,
      processingFeeRentedRupees: nbfcLoanProducts.processing_fee_rented_rupees,
      healthLifeInsuranceOwnedRupees:
        nbfcLoanProducts.health_life_insurance_owned_rupees,
      healthLifeInsuranceRentedRupees:
        nbfcLoanProducts.health_life_insurance_rented_rupees,
      disbursementTatHours: nbfcLoanProducts.disbursement_tat_hours,
      cibilRequired: nbfcLoanProducts.cibil_required,
      minCreditScore: nbfcLoanProducts.min_credit_score,
      maxCreditScore: nbfcLoanProducts.max_credit_score,
      creditBureau: nbfcLoanProducts.credit_bureau,
      eligibilityDocuments: nbfcLoanProducts.eligibility_documents,
    })
    .from(nbfcLoanProducts)
    .innerJoin(nbfc, eq(nbfcLoanProducts.nbfc_id, nbfc.id))
    .where(eq(nbfcLoanProducts.id, productId))
    .limit(1);

  if (!row) {
    return NextResponse.json(
      { success: false, message: "Loan product not found" },
      { status: 404 },
    );
  }

  return NextResponse.json({ success: true, product: row }, { status: 200 });
}

// Hard delete a loan product. Blocked when the product is already bound to one
// or more leads (nbfc_lead_assignments) — deleting it would orphan that
// history. In that case the admin should flip status to inactive instead,
// which hides it from dealer Section G while preserving the record.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ productId: string }> },
) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const { productId: pidRaw } = await params;
  const productId = parseProductId(pidRaw);
  if (productId === null) {
    return NextResponse.json(
      { success: false, message: "Invalid productId" },
      { status: 400 },
    );
  }

  const [existing] = await db
    .select({ id: nbfcLoanProducts.id })
    .from(nbfcLoanProducts)
    .where(eq(nbfcLoanProducts.id, productId))
    .limit(1);

  if (!existing) {
    return NextResponse.json(
      { success: false, message: "Loan product not found" },
      { status: 404 },
    );
  }

  const [reference] = await db
    .select({ id: nbfcLeadAssignments.id })
    .from(nbfcLeadAssignments)
    .where(eq(nbfcLeadAssignments.loan_product_id, productId))
    .limit(1);

  if (reference) {
    return NextResponse.json(
      {
        success: false,
        message:
          "This product is already assigned to one or more leads and can't be deleted. Set its status to Inactive instead — that removes it from dealer Section G while keeping the record.",
      },
      { status: 409 },
    );
  }

  await db.delete(nbfcLoanProducts).where(eq(nbfcLoanProducts.id, productId));

  return NextResponse.json({ success: true, id: productId }, { status: 200 });
}

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { nbfcLoanProducts } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/requireAdmin";

// E-009 — PATCH partial update for nbfc_loan_products. nbfc_id cannot change.

const BATTERY_CATEGORIES = ["3W", "2W", "4W", "INVERTER", "SOLAR"] as const;
const DISBURSEMENT_METHODS = [
  "direct_to_dealer",
  "rtgs_to_dealer",
  "escrow",
] as const;
const STATUS_VALUES = ["active", "inactive"] as const;

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

/**
 * E-010 — Loan sanction band guard.
 *
 * BRD §6.0.5: dealer cannot sanction a loan outside the active loan product's
 * (loan_amount_min..loan_amount_max) band, or outside its
 * (tenure_months_min..tenure_months_max) tenure band, and inactive products
 * are never selectable for new sanctions.
 *
 * This route is the server-side guard. The dealer/admin loan sanction form
 * already validates client-side, but the server is the source of truth — even
 * if the UI were bypassed, the API rejects out-of-band requests.
 *
 * Auth: admin-only via requireAdminOrTestBypass (triple-guarded loop bypass
 * supported in non-prod when NBFC_TEST_BYPASS_SECRET is set).
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { nbfcLoanProducts } from "@/lib/db/schema";
import { requireAdminOrTestBypass } from "@/lib/auth/adminTestBypass";

const bodySchema = z
  .object({
    loanProductId: z.number().int().positive(),
    sanctionAmount: z.number().positive(),
    tenureMonths: z.number().int().positive(),
  })
  .strict();

export type ValidateBandReason =
  | "product_inactive"
  | "amount_out_of_band"
  | "tenure_out_of_band"
  | null;

export async function POST(req: NextRequest) {
  const auth = await requireAdminOrTestBypass(req.headers);
  if (!auth.ok) return auth.response;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, message: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const parsed = bodySchema.safeParse(json);
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

  const { loanProductId, sanctionAmount, tenureMonths } = parsed.data;

  // Resolve the product. The guard always reads the product's CURRENT
  // min/max — never a cached snapshot — so admin edits via E-009 take effect
  // immediately for all subsequent sanction attempts.
  const [product] = await db
    .select({
      id: nbfcLoanProducts.id,
      status: nbfcLoanProducts.status,
      loan_amount_min: nbfcLoanProducts.loan_amount_min,
      loan_amount_max: nbfcLoanProducts.loan_amount_max,
      tenure_months_min: nbfcLoanProducts.tenure_months_min,
      tenure_months_max: nbfcLoanProducts.tenure_months_max,
    })
    .from(nbfcLoanProducts)
    .where(eq(nbfcLoanProducts.id, loanProductId))
    .limit(1);

  if (!product) {
    return NextResponse.json(
      { success: false, message: "Loan product not found" },
      { status: 404 },
    );
  }

  const productPayload = {
    loanAmountMin: product.loan_amount_min,
    loanAmountMax: product.loan_amount_max,
    tenureMonthsMin: product.tenure_months_min,
    tenureMonthsMax: product.tenure_months_max,
    status: product.status,
  };

  // 1. Inactive products MUST NOT be selectable for new sanctions.
  if (product.status !== "active") {
    return NextResponse.json(
      {
        ok: false,
        reason: "product_inactive" satisfies ValidateBandReason,
        product: productPayload,
      },
      { status: 200 },
    );
  }

  // 2. Amount band guard.
  if (
    sanctionAmount < product.loan_amount_min ||
    sanctionAmount > product.loan_amount_max
  ) {
    return NextResponse.json(
      {
        ok: false,
        reason: "amount_out_of_band" satisfies ValidateBandReason,
        product: productPayload,
      },
      { status: 200 },
    );
  }

  // 3. Tenure band guard.
  if (
    tenureMonths < product.tenure_months_min ||
    tenureMonths > product.tenure_months_max
  ) {
    return NextResponse.json(
      {
        ok: false,
        reason: "tenure_out_of_band" satisfies ValidateBandReason,
        product: productPayload,
      },
      { status: 200 },
    );
  }

  // All checks passed.
  return NextResponse.json(
    {
      ok: true,
      reason: null as ValidateBandReason,
      product: productPayload,
    },
    { status: 200 },
  );
}

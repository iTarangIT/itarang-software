/**
 * /admin/loan-products/[productId]/edit — edit a single NBFC loan product.
 *
 * Server-rendered: reads the full product row (joined to its NBFC for the
 * breadcrumb name) and renders the shared NbfcLoanProductForm in edit mode,
 * which PATCHes /api/admin/nbfc/loan-products/[productId] on save.
 */
import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { nbfc, nbfcLoanProducts } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { PageShell } from "@/components/layout/PageShell";
import NbfcLoanProductForm, {
  type LoanProductInitialValues,
} from "@/components/admin/nbfc/NbfcLoanProductForm";

export const dynamic = "force-dynamic";

export default async function EditLoanProductPage({
  params,
}: {
  params: Promise<{ productId: string }>;
}) {
  try {
    await requireAuth();
  } catch {
    redirect("/login");
  }

  const { productId: productIdRaw } = await params;
  const productId = Number.parseInt(productIdRaw, 10);
  if (!Number.isFinite(productId) || productId <= 0) notFound();

  const [row] = await db
    .select({
      nbfcId: nbfcLoanProducts.nbfc_id,
      nbfcName: nbfc.legal_name,
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
      eligibilityDocuments: nbfcLoanProducts.eligibility_documents,
    })
    .from(nbfcLoanProducts)
    .innerJoin(nbfc, eq(nbfcLoanProducts.nbfc_id, nbfc.id))
    .where(eq(nbfcLoanProducts.id, productId))
    .limit(1);

  if (!row) notFound();

  const initialValues: LoanProductInitialValues = {
    productName: row.productName,
    eligibleBatteryCategories: row.eligibleBatteryCategories,
    loanAmountMin: row.loanAmountMin,
    loanAmountMax: row.loanAmountMax,
    tenureMonthsMin: row.tenureMonthsMin,
    tenureMonthsMax: row.tenureMonthsMax,
    minRoiPct: row.minRoiPct,
    maxRoiPct: row.maxRoiPct,
    downPaymentPct: row.downPaymentPct,
    subventionAvailable: row.subventionAvailable,
    fileChargeFixed: row.fileChargeFixed,
    fileChargePct: row.fileChargePct,
    disbursementMethod: row.disbursementMethod,
    status: row.status === "inactive" ? "inactive" : "active",
    activeLocations: row.activeLocations,
    processingFeeOwnedRupees: row.processingFeeOwnedRupees,
    processingFeeRentedRupees: row.processingFeeRentedRupees,
    healthLifeInsuranceOwnedRupees: row.healthLifeInsuranceOwnedRupees,
    healthLifeInsuranceRentedRupees: row.healthLifeInsuranceRentedRupees,
    disbursementTatHours: row.disbursementTatHours,
    cibilRequired: row.cibilRequired,
    minCreditScore: row.minCreditScore,
    maxCreditScore: row.maxCreditScore,
    eligibilityDocuments: row.eligibilityDocuments,
  };

  return (
    <PageShell
      eyebrow="Loan Products"
      title={`Edit · ${row.productName}`}
      subtitle={`${row.nbfcName} — changes apply immediately to dealer Section G.`}
      breadcrumb={[
        { label: "Admin", href: "/admin" },
        { label: "Loan Products", href: "/admin/loan-products" },
        { label: "Edit" },
      ]}
    >
      <NbfcLoanProductForm
        nbfcId={row.nbfcId}
        productId={productId}
        initialValues={initialValues}
      />
    </PageShell>
  );
}

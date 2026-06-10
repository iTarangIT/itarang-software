/**
 * /admin/loan-products — global loan product catalogue.
 *
 * Server-rendered: queries every `nbfc_loan_products` row joined to its owning
 * NBFC for the display name, and passes them to the presentational
 * `LoanProductsDirectory` (client-side search by product name + status filter).
 *
 * This is the cross-NBFC management surface: products are searchable by name
 * and editable here without navigating through a numeric NBFC ID.
 */
import { asc, desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { nbfc, nbfcLoanProducts } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { PageShell } from "@/components/layout/PageShell";
import LoanProductsDirectory, {
  type LoanProductRow,
} from "@/components/admin/nbfc/LoanProductsDirectory";

export const dynamic = "force-dynamic";

export default async function AdminLoanProductsPage() {
  try {
    await requireAuth();
  } catch {
    redirect("/login");
  }

  const rows = await db
    .select({
      id: nbfcLoanProducts.id,
      productName: nbfcLoanProducts.product_name,
      nbfcName: nbfc.legal_name,
      status: nbfcLoanProducts.status,
      batteryCategories: nbfcLoanProducts.eligible_battery_categories,
      loanAmountMin: nbfcLoanProducts.loan_amount_min,
      loanAmountMax: nbfcLoanProducts.loan_amount_max,
      minRoiPct: nbfcLoanProducts.min_roi_pct,
      maxRoiPct: nbfcLoanProducts.max_roi_pct,
    })
    .from(nbfcLoanProducts)
    .innerJoin(nbfc, eq(nbfcLoanProducts.nbfc_id, nbfc.id))
    .orderBy(asc(nbfc.legal_name), desc(nbfcLoanProducts.id));

  const directoryRows: LoanProductRow[] = rows.map((r) => ({
    id: r.id,
    productName: r.productName,
    nbfcName: r.nbfcName,
    status: r.status,
    batteryCategories: r.batteryCategories ?? [],
    loanAmountMin: r.loanAmountMin,
    loanAmountMax: r.loanAmountMax,
    minRoiPct: r.minRoiPct,
    maxRoiPct: r.maxRoiPct,
  }));

  return (
    <PageShell
      eyebrow="Loan Products"
      title="Loan product catalogue"
      subtitle="Every NBFC loan product. Search by product name; click Edit to update terms, fees, eligibility, or status."
      breadcrumb={[
        { label: "Admin", href: "/admin" },
        { label: "Loan Products" },
      ]}
    >
      <LoanProductsDirectory rows={directoryRows} />
    </PageShell>
  );
}

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { nbfc } from "@/lib/db/schema";
import NbfcLoanProductForm from "@/components/admin/nbfc/NbfcLoanProductForm";
import { PageShell } from "@/components/layout/PageShell";

// E-009 — /admin/nbfc/[nbfcId]/loan-products
// Admin page for configuring per-NBFC loan products (BRD §6.0.5).
// Locked behind activation: the NBFC must be `active` before this page is
// accessible. Anyone hitting the URL pre-activation is bounced back to
// /review where the Activate Account button lives. Reachable from the
// NBFC Directory's per-row "Loan products" action; no longer part of the
// onboarding wizard step ribbon.

export const dynamic = "force-dynamic";

export default async function Page({
  params,
}: {
  params: Promise<{ nbfcId: string }>;
}) {
  const { nbfcId: nbfcIdRaw } = await params;
  const nbfcId = Number.parseInt(nbfcIdRaw, 10);

  const [row] = await db
    .select({ status: nbfc.status, legal_name: nbfc.legal_name })
    .from(nbfc)
    .where(eq(nbfc.id, nbfcId))
    .limit(1);
  if (!row || row.status !== "active") {
    redirect(`/admin/nbfc/${nbfcId}/review`);
  }

  return (
    <PageShell
      eyebrow="Loan Products"
      title="Per-NBFC catalogue"
      subtitle={`Only products with status "active" appear in the dealer loan-sanction form. Per BRD §6.0.5.`}
      breadcrumb={[
        { label: "Admin", href: "/admin" },
        { label: "NBFC", href: "/admin/nbfc" },
        { label: row.legal_name, href: `/admin/nbfc/${nbfcId}/edit` },
        { label: "Loan Products" },
      ]}
    >
      <NbfcLoanProductForm nbfcId={nbfcId} />
    </PageShell>
  );
}

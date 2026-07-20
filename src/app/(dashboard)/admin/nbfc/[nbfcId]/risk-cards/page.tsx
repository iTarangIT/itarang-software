import { redirect } from "next/navigation";
import { eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { nbfc, riskHypotheses, nbfcRiskCardVisibility } from "@/lib/db/schema";
import NbfcRiskCardVisibilityForm from "@/components/admin/nbfc/NbfcRiskCardVisibilityForm";
import { PageShell } from "@/components/layout/PageShell";

// E-199 — /admin/nbfc/[nbfcId]/risk-cards
// Admin curation of which risk-hypothesis cards an NBFC partner may see on the
// /nbfc/risk dashboard. Locked behind activation: the NBFC must be `active` and
// have a portal tenant (nbfc.tenant_id, set at activation) before this page is
// reachable. Anyone hitting the URL earlier is bounced to /review where the
// Activate Account button lives. Reached from the NBFC Directory row action.

export const dynamic = "force-dynamic";

export default async function Page({
  params,
}: {
  params: Promise<{ nbfcId: string }>;
}) {
  const { nbfcId: nbfcIdRaw } = await params;
  const nbfcId = Number.parseInt(nbfcIdRaw, 10);

  const [row] = await db
    .select({
      status: nbfc.status,
      legal_name: nbfc.legal_name,
      tenant_id: nbfc.tenant_id,
    })
    .from(nbfc)
    .where(eq(nbfc.id, nbfcId))
    .limit(1);
  if (!row || row.status !== "active" || !row.tenant_id) {
    redirect(`/admin/nbfc/${nbfcId}/review`);
  }

  // Full catalogue an admin may choose from (non-retired only) + the tenant's
  // currently-enabled set, both server-fetched so the form renders pre-checked.
  const [catalogue, selectedRows] = await Promise.all([
    db
      .select({
        id: riskHypotheses.id,
        slug: riskHypotheses.slug,
        title: riskHypotheses.title,
        description: riskHypotheses.description,
        source: riskHypotheses.source,
      })
      .from(riskHypotheses)
      .where(isNull(riskHypotheses.retired_at))
      .orderBy(riskHypotheses.source, riskHypotheses.slug),
    db
      .select({ hypothesis_id: nbfcRiskCardVisibility.hypothesis_id })
      .from(nbfcRiskCardVisibility)
      .where(eq(nbfcRiskCardVisibility.tenant_id, row.tenant_id)),
  ]);

  return (
    <PageShell
      eyebrow="Risk Cards"
      title="Visible risk cards"
      subtitle="Only the cards you select here appear on this partner's Risk dashboard. Unselected cards stay hidden on every re-run."
      breadcrumb={[
        { label: "Admin", href: "/admin" },
        { label: "NBFC", href: "/admin/nbfc" },
        { label: row.legal_name, href: `/admin/nbfc/${nbfcId}/edit` },
        { label: "Risk Cards" },
      ]}
    >
      <NbfcRiskCardVisibilityForm
        nbfcId={nbfcId}
        catalogue={catalogue}
        initialSelected={selectedRows.map((r) => r.hypothesis_id)}
      />
    </PageShell>
  );
}

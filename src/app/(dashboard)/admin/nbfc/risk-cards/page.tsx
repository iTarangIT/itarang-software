/**
 * /admin/nbfc/risk-cards — Risk Cards catalogue (card-centric view).
 *
 * Lists every non-retired risk hypothesis as a card. Each card exposes:
 *   • Info   — what the card does, its logic, the data it pulls, what it shows,
 *              and how its severity is decided (from src/lib/risk/card-info.ts).
 *   • Select — multi-select the activated NBFC partners this card should appear
 *              for. Saving writes the nbfc_risk_card_visibility allowlist, so the
 *              card immediately shows in those partners' Risk Alert dashboard.
 *
 * This is the inverse pivot of /admin/nbfc/[nbfcId]/risk-cards (which curates
 * cards for one partner). Both edit the same allowlist table.
 */
import { desc, eq, isNotNull, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { nbfc, riskHypotheses, nbfcRiskCardVisibility } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { PageShell } from "@/components/layout/PageShell";
import RiskCardCatalogue, {
  type CatalogueCard,
  type CatalogueNbfc,
} from "@/components/admin/nbfc/RiskCardCatalogue";

export const dynamic = "force-dynamic";

export default async function AdminNbfcRiskCardsPage() {
  try {
    await requireAuth();
  } catch {
    redirect("/login");
  }

  // Everything is server-fetched so the Select dialogs render pre-checked
  // without a round-trip.
  const [hypotheses, nbfcs, visibilityRows] = await Promise.all([
    db
      .select({
        id: riskHypotheses.id,
        slug: riskHypotheses.slug,
        title: riskHypotheses.title,
        description: riskHypotheses.description,
        source: riskHypotheses.source,
        promoted_at: riskHypotheses.promoted_at,
      })
      .from(riskHypotheses)
      .where(isNull(riskHypotheses.retired_at))
      .orderBy(riskHypotheses.source, riskHypotheses.slug),
    db
      .select({
        id: nbfc.id,
        nbfcId: nbfc.nbfc_id,
        legalName: nbfc.legal_name,
        tenantId: nbfc.tenant_id,
      })
      .from(nbfc)
      .where(eq(nbfc.status, "active"))
      .orderBy(desc(nbfc.created_at)),
    db
      .select({
        hypothesis_id: nbfcRiskCardVisibility.hypothesis_id,
        tenant_id: nbfcRiskCardVisibility.tenant_id,
      })
      .from(nbfcRiskCardVisibility),
  ]);

  // Only activated NBFCs with a portal tenant can be shown a card.
  const activeNbfcs: CatalogueNbfc[] = nbfcs
    .filter((n): n is typeof n & { tenantId: string } => n.tenantId != null)
    .map((n) => ({ id: n.id, nbfcId: n.nbfcId, legalName: n.legalName }));

  // tenant_id → nbfc.id, so we can express visibility in the nbfc-id terms the
  // Select dialog works in.
  const nbfcIdByTenant = new Map<string, number>();
  for (const n of nbfcs) {
    if (n.tenantId != null) nbfcIdByTenant.set(n.tenantId, n.id);
  }

  // hypothesis_id → the nbfc ids it is currently visible to.
  const selectedByCard: Record<string, number[]> = {};
  for (const row of visibilityRows) {
    const nbfcId = nbfcIdByTenant.get(row.tenant_id);
    if (nbfcId == null) continue; // orphan / non-active tenant
    (selectedByCard[row.hypothesis_id] ??= []).push(nbfcId);
  }

  const cards: CatalogueCard[] = hypotheses.map((h) => ({
    id: h.id,
    slug: h.slug,
    title: h.title,
    description: h.description,
    source: h.source,
    isPromoted: h.promoted_at != null,
  }));

  return (
    <PageShell
      eyebrow="Risk Cards"
      title="Risk cards"
      subtitle="Every risk-hypothesis card. Open Info to see what a card does and the data behind it, or Select to choose which NBFC partners it appears for on their Risk Alert dashboard."
      breadcrumb={[
        { label: "Admin", href: "/admin" },
        { label: "NBFC", href: "/admin/nbfc" },
        { label: "Risk Cards" },
      ]}
    >
      <RiskCardCatalogue
        cards={cards}
        nbfcs={activeNbfcs}
        selectedByCard={selectedByCard}
      />
    </PageShell>
  );
}

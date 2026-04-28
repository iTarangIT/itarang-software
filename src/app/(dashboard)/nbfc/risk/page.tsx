import { db } from "@/lib/db";
import { riskCardRuns, riskHypotheses } from "@/lib/db/schema";
import { and, eq, desc } from "drizzle-orm";
import { getCurrentTenant, getTenantLoanSlice } from "@/lib/nbfc/tenant";
import { HAND_CODED_CARDS, type CardEvaluation } from "@/lib/risk/hand-coded-cards";
import SeverityTabs from "./_components/SeverityTabs";
import RerunButton from "./_components/RerunButton";

export const dynamic = "force-dynamic";

interface CardForUi extends CardEvaluation {
  hypothesis_id: string;
  title: string;
  description: string;
  source: string;
  run_at: string | null;
}

/**
 * Fetch the latest stored card per hypothesis for a tenant. Falls back to
 * running the hand-coded evaluator inline if no run exists yet (so a fresh
 * tenant with no cron history still sees data on first load).
 */
async function loadCards(tenantId: string): Promise<CardForUi[]> {
  // 1. Catalogue — show both hand-coded (always) and LLM-generated (after first
  // "Re-run analysis" populates them).
  const hyps = await db
    .select()
    .from(riskHypotheses)
    .orderBy(riskHypotheses.source, riskHypotheses.slug);

  // 2. Latest run per hypothesis (group-by-max-run via per-hyp queries — fine for ~5 cards)
  const latestByHyp = new Map<string, typeof riskCardRuns.$inferSelect>();
  for (const h of hyps) {
    const rows = await db
      .select()
      .from(riskCardRuns)
      .where(and(eq(riskCardRuns.tenant_id, tenantId), eq(riskCardRuns.hypothesis_id, h.id)))
      .orderBy(desc(riskCardRuns.run_at))
      .limit(1);
    if (rows[0]) latestByHyp.set(h.id, rows[0]);
  }

  // 3. Hand-coded fallback for hypotheses with no stored run yet
  const loans = await getTenantLoanSlice(tenantId);
  const out: CardForUi[] = [];
  for (const h of hyps) {
    const stored = latestByHyp.get(h.id);
    if (stored) {
      const ev = (stored.evidence_json as CardEvaluation["evidence"] | null) ?? {};
      out.push({
        slug: h.slug,
        hypothesis_id: h.id,
        title: h.title,
        description: h.description,
        source: h.source,
        severity: stored.severity as CardEvaluation["severity"],
        finding_summary: stored.finding_summary,
        affected_count: stored.affected_count,
        total_count: stored.total_count,
        evidence: ev,
        run_at: stored.run_at?.toISOString() ?? null,
      });
      continue;
    }
    const evaluator = HAND_CODED_CARDS[h.slug];
    if (!evaluator) continue;
    const evalResult = await evaluator(loans);
    out.push({
      ...evalResult,
      hypothesis_id: h.id,
      title: h.title,
      description: h.description,
      source: h.source,
      run_at: null,
    });
  }
  return out;
}

export default async function RiskPage() {
  const tenant = await getCurrentTenant();
  const cards = await loadCards(tenant.id);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Risk</h1>
          <p className="text-sm text-slate-500 mt-1">
            Hypothesis-driven cards. {cards.length} active hypotheses for {tenant.display_name}.
          </p>
        </div>
        <RerunButton />
      </div>
      <SeverityTabs cards={cards} />
    </div>
  );
}

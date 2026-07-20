import { db } from "@/lib/db";
import { riskCardRuns, riskHypotheses, nbfcTenants, nbfcRiskCardVisibility } from "@/lib/db/schema";
import { eq, desc, isNull } from "drizzle-orm";
import { getCurrentTenant, getTenantLoanSlice } from "@/lib/nbfc/tenant";
import { HAND_CODED_CARDS, type CardEvaluation } from "@/lib/risk/hand-coded-cards";
import type { Severity, VerdictSource } from "@/lib/risk/severity";
import { isComputed } from "@/lib/risk/severity";
import { loadRiskThresholds } from "@/lib/nbfc/risk-thresholds";
import { getRunFreshness, STALE_AFTER_HOURS } from "@/lib/nbfc/risk-run";
import SeverityTabs from "./_components/SeverityTabs";
import RerunButton from "./_components/RerunButton";
import RiskActionFramework from "./_components/RiskActionFramework";

export const dynamic = "force-dynamic";

interface CardForUi extends CardEvaluation {
  hypothesis_id: string;
  title: string;
  description: string;
  source: string;
  /** E-188 — vetted by a human. Unpromoted agent hypotheses are capped at warn. */
  promoted: boolean;
  critique: string | null;
  run_at: string | null;
}

interface LoadCardsResult {
  cards: CardForUi[];
  vpsError: string | null;
}

/**
 * Fetch the latest stored card per hypothesis for a tenant. Falls back to
 * running the hand-coded evaluator inline if no run exists yet (so a fresh
 * tenant with no cron history still sees data on first load).
 */
async function loadCards(tenantId: string): Promise<LoadCardsResult> {
  // 1. Catalogue — show both hand-coded (always) and LLM-generated (after first
  // "Re-run analysis" populates them).
  // Retired hypotheses (E-188) keep their history but are no longer run or
  // rendered — a test whose generated code is broken is not a risk signal.
  const catalogue = await db
    .select()
    .from(riskHypotheses)
    .where(isNull(riskHypotheses.retired_at))
    .orderBy(riskHypotheses.source, riskHypotheses.slug);

  // 1b. Admin allowlist gate (E-199). The catalogue is global, but each NBFC
  // partner sees ONLY the cards an admin has explicitly enabled for their
  // tenant. This is a STRICT allowlist: a hypothesis with no visibility row is
  // hidden, and a tenant with no rows at all sees zero cards. The filter lives
  // here — at display time — so it holds on every "Re-run analysis" (a re-run
  // only writes risk_card_runs; it never bypasses loadCards). Managed from
  // /admin/nbfc/[nbfcId]/risk-cards.
  const visibleRows = await db
    .select({ hypothesis_id: nbfcRiskCardVisibility.hypothesis_id })
    .from(nbfcRiskCardVisibility)
    .where(eq(nbfcRiskCardVisibility.tenant_id, tenantId));
  const allowed = new Set(visibleRows.map((r) => r.hypothesis_id));
  const hyps = catalogue.filter((h) => allowed.has(h.id));

  // 2. Latest run per hypothesis — one DISTINCT ON query, not one query per
  // hypothesis in a serial loop. The catalogue grows every time the agent
  // proposes a new hypothesis, so the old N+1 got slower with each run.
  const latestRows = await db
    .select()
    .from(riskCardRuns)
    .where(eq(riskCardRuns.tenant_id, tenantId))
    .orderBy(riskCardRuns.hypothesis_id, desc(riskCardRuns.run_at))
    .then((rows) => rows);

  const latestByHyp = new Map<string, (typeof latestRows)[number]>();
  for (const row of latestRows) {
    // Rows arrive grouped by hypothesis, newest first — keep the first of each.
    if (!latestByHyp.has(row.hypothesis_id)) latestByHyp.set(row.hypothesis_id, row);
  }

  // 3. Hand-coded fallback for hypotheses with no stored run yet. Each
  // evaluator may hit the IoT VPS — when that's unreachable the call throws.
  // Catch per-hypothesis so one bad evaluator does not blank the whole page;
  // surface a single banner with the first error message.
  const loans = await getTenantLoanSlice(tenantId);
  const thresholds = await loadRiskThresholds();
  const out: CardForUi[] = [];
  let vpsError: string | null = null;
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
        promoted: h.promoted_at != null,
        severity: stored.severity as Severity,
        // Rows written before E-185 have no provenance. They are backfilled to
        // legacy_llm by the migration; treat a still-null value the same way
        // rather than passing it off as a measurement.
        verdict_source: (stored.verdict_source as VerdictSource | null) ?? "legacy_llm",
        finding_summary: stored.finding_summary,
        affected_count: stored.affected_count,
        total_count: stored.total_count,
        evidence: ev,
        critique: stored.llm_critique,
        run_at: stored.run_at?.toISOString() ?? null,
      });
      continue;
    }
    const evaluator = HAND_CODED_CARDS[h.slug];
    if (!evaluator) {
      // An agent-proposed hypothesis with no stored run and no TS evaluator —
      // nothing has ever tested it. Say that instead of hiding the card.
      out.push({
        slug: h.slug,
        hypothesis_id: h.id,
        title: h.title,
        description: h.description,
        source: h.source,
        promoted: h.promoted_at != null,
        severity: "inconclusive",
        verdict_source: "none",
        finding_summary: "Never tested — no run recorded for this hypothesis yet.",
        affected_count: 0,
        total_count: 0,
        evidence: { notes: ["Run the analysis to produce a verdict for this card."] },
        critique: null,
        run_at: null,
      });
      continue;
    }
    try {
      const evalResult = await evaluator(loans, thresholds);
      out.push({
        ...evalResult,
        hypothesis_id: h.id,
        title: h.title,
        description: h.description,
        source: h.source,
        promoted: h.promoted_at != null,
        critique: null,
        run_at: null,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!vpsError) vpsError = msg;
      out.push({
        slug: h.slug,
        hypothesis_id: h.id,
        title: h.title,
        description: h.description,
        source: h.source,
        promoted: h.promoted_at != null,
        // Was "warn" — which read as a mild finding about the portfolio. It is
        // not a finding at all: the test never ran.
        severity: "error",
        verdict_source: "none",
        finding_summary: "Test failed to run — the IoT telemetry database is unreachable.",
        affected_count: 0,
        total_count: 0,
        evidence: { notes: [msg] },
        critique: null,
        run_at: null,
      });
    }
  }
  return { cards: out, vpsError };
}

export default async function RiskPage() {
  const tenant = await getCurrentTenant();
  const [{ cards, vpsError }, freshness, tenantLegalRows] = await Promise.all([
    loadCards(tenant.id),
    getRunFreshness(tenant.id),
    db
      .select({
        legal_name: nbfcTenants.nbfc_legal_name,
        grievance_url: nbfcTenants.grievance_url,
        grievance_helpline: nbfcTenants.grievance_helpline,
      })
      .from(nbfcTenants)
      .where(eq(nbfcTenants.id, tenant.id))
      .limit(1),
  ]);
  const tenantLegal = {
    legal_name: tenantLegalRows[0]?.legal_name ?? null,
    display_name: tenant.display_name,
    grievance_url: tenantLegalRows[0]?.grievance_url ?? null,
    grievance_helpline: tenantLegalRows[0]?.grievance_helpline ?? null,
  };

  const computed = cards.filter((c) => isComputed(c.verdict_source)).length;
  const unverified = cards.filter((c) => c.verdict_source === "legacy_llm").length;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Risk</h1>
          <p className="text-sm text-slate-500 mt-1">
            Hypothesis-driven cards. {computed} of {cards.length} hypotheses produced a computed
            verdict for {tenant.display_name}.
          </p>
          <p className="text-xs text-slate-500 mt-1">
            {freshness.in_flight ? (
              <span className="text-slate-600 dark:text-slate-400">Analysis running now…</span>
            ) : freshness.last_run_at ? (
              <>
                Last analysis {new Date(freshness.last_run_at).toLocaleString()}
                {freshness.is_stale ? (
                  <span className="ml-2 px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400 font-medium">
                    Stale — older than {STALE_AFTER_HOURS}h
                  </span>
                ) : null}
              </>
            ) : (
              <span className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400 font-medium">
                Never run — these cards are computed live on page load, not from a recorded run
              </span>
            )}
          </p>
        </div>
        <RerunButton />
      </div>

      {vpsError ? (
        <div className="border border-amber-200 bg-amber-50 text-amber-900 text-sm rounded p-3">
          IoT telemetry database unreachable — the cards that depend on it could not be evaluated and
          are shown as Errors, not as findings. ({vpsError})
        </div>
      ) : null}

      {unverified > 0 ? (
        <div className="border border-violet-200 bg-violet-50 text-violet-900 text-sm rounded p-3">
          {unverified} card{unverified === 1 ? "" : "s"} pre-date verdict tracking (E-185). Their
          severity and counts may have been stated by the language model rather than computed from
          data — treat them as unverified and re-run the analysis to replace them.
        </div>
      ) : null}

      <SeverityTabs cards={cards} />

      <RiskActionFramework tenant={tenantLegal} />
    </div>
  );
}

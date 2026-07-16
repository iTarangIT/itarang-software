/**
 * Exercise `writeCards()` — node 6, the last one — on its own.
 *
 *   npm run risk:write -- --tenant=<slug>            # DRY RUN — simulates, writes nothing
 *   npm run risk:write -- --tenant=<slug> --fixture  # DRY RUN over synthetic results (see below)
 *   npm run risk:write -- --tenant=<slug> --write    # REALLY writes: cards + a risk_runs row
 *   node --import tsx --env-file=.env.local scripts/run-write-cards.ts --tenant=<slug>   //run command
 *
 * THIS IS THE ONLY NODE IN THE GRAPH THAT WRITES. Everything upstream computes
 * into state; this is where it lands in the DB. So the default here is a dry run
 * that reproduces the node's decisions WITHOUT calling it — because calling it at
 * all is a write. `--write` calls the real function.
 *
 * ── INPUT ────────────────────────────────────────────────────────────────────
 *   state.results[]             — from run_test. Each carries severity, counts,
 *                                 finding_summary, evidence, critique, and
 *                                 (if it came from the catalogue) id + promoted.
 *   state.tenantId              — NOT state.tenant. Different field; this node is
 *                                 the only one that reads the flat id.
 *   state.runId                 — the risk_runs row (E-187) these cards belong to.
 *                                 The Risk page's freshness clock reads from it.
 *   state.totalPromptTokens     — the RUN's totals…
 *   state.totalCompletionTokens — …see the note in READING THE RESULT.
 *
 * ── OUTPUT ───────────────────────────────────────────────────────────────────
 *   Returns {} — the node's product is its side effects:
 *     1. INSERT risk_hypotheses   … only for results with no `id` (newly proposed).
 *     2. INSERT risk_card_runs    … one row per result, always.
 *     3. UPDATE risk_hypotheses   … retire, if this result is `error` AND the last
 *                                   3 card runs were all `error`.
 *
 * ── THE THREE BRANCHES, AND WHY --fixture EXISTS ─────────────────────────────
 * A real run today can only exercise the boring one. The catalogue is at 12/12 so
 * nothing new is proposed (every result has an `id` → no hypothesis INSERT), and
 * the sandbox is down so every result is `inconclusive` (never `high` → the cap
 * never fires; never `error` → retirement never fires).
 *
 * `--fixture` feeds writeCards synthetic results that reach all three:
 *   · an unpromoted `high`  → must be CAPPED to warn (E-188)
 *   · a promoted `high`     → must pass through UNCAPPED
 *   · a fresh draft, no id  → must INSERT a new risk_hypotheses row
 *   · an `error` with an id → must run the 3-strikes retirement check
 * --fixture is DRY-RUN ONLY and refuses to combine with --write: it would mint a
 * junk hypothesis row in the live catalogue, which is exactly the mess this
 * codebase has been digging itself out of.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { nbfcTenants, riskCardRuns, riskHypotheses } from "@/lib/db/schema";
import { getTenantLoanSlice, type TenantContext } from "@/lib/nbfc/tenant";
import { beginRiskRun, completeRiskRun, failRiskRun } from "@/lib/nbfc/risk-run";
import { loadCatalogue, runTest, writeCards } from "@/lib/ai/langgraph/risk-hypothesis-graph";

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const FIXTURE = args.includes("--fixture");
const tenantArg = args.find((a) => a.startsWith("--tenant="))?.split("=")[1];

/** Mirrors capUnpromotedSeverity — duplicated so the dry run can PREDICT it without writing. */
function predictCap(severity: string, promoted: boolean) {
  if (!promoted && severity === "high") return { severity: "warn", capped: true };
  return { severity, capped: false };
}

const RETIRE_AFTER = 3;

/** The retirement check, read-only. The node's version does the UPDATE too. */
async function wouldRetire(hypothesisId: string): Promise<boolean> {
  const recent = await db
    .select({ severity: riskCardRuns.severity })
    .from(riskCardRuns)
    .where(eq(riskCardRuns.hypothesis_id, hypothesisId))
    .orderBy(desc(riskCardRuns.run_at))
    .limit(RETIRE_AFTER);
  return recent.length >= RETIRE_AFTER && recent.every((c) => c.severity === "error");
}

function fixtureResults(catalogue: Array<{ id?: string; slug: string; promoted?: boolean }>) {
  const base = {
    verdict_source: "sandbox" as const,
    affected_count: 7,
    total_count: 7,
    evidence: { notes: ["synthetic fixture — not a real measurement"] },
    critique: "fixture",
    title: "Fixture",
    description: "Synthetic result used to exercise writeCards' branches.",
    test_plan: "n/a",
  };
  const c0 = catalogue[0];
  const c1 = catalogue[1];
  return [
    // Unpromoted high → the E-188 cap must knock this to warn.
    { ...base, ...c0, severity: "high", promoted: false, finding_summary: "Unpromoted HIGH — expect cap to warn." },
    // Same row, pretending a human promoted it → must pass through as high.
    { ...base, ...c0, severity: "high", promoted: true, finding_summary: "Promoted HIGH — expect NO cap." },
    // No id → the node would INSERT a new risk_hypotheses row.
    {
      ...base,
      id: undefined,
      slug: "fixture-brand-new-hypothesis",
      severity: "warn",
      promoted: false,
      python_code: "def evaluate(loans, vehicle_states, daily_km):\n    return {}",
      finding_summary: "Fresh draft with no id — expect an INSERT into risk_hypotheses.",
    },
    // error + id → the 3-strikes retirement check runs.
    { ...base, ...c1, severity: "error", promoted: false, affected_count: 0, total_count: 0, finding_summary: "Errored — expect the retirement check to run." },
  ];
}

async function main() {
  const slug = tenantArg ?? process.env.NBFC_DEMO_TENANT_SLUG;
  if (!slug) throw new Error("No tenant. Pass --tenant=<slug> or set NBFC_DEMO_TENANT_SLUG in .env.local.");
  if (FIXTURE && WRITE) {
    throw new Error(
      "--fixture cannot be combined with --write. The fixture invents a hypothesis " +
        "with no id, and writeCards would persist it into the real catalogue.",
    );
  }

  const [row] = await db
    .select({
      id: nbfcTenants.id,
      slug: nbfcTenants.slug,
      display_name: nbfcTenants.display_name,
      contact_email: nbfcTenants.contact_email,
      aum_inr: nbfcTenants.aum_inr,
    })
    .from(nbfcTenants)
    .where(and(eq(nbfcTenants.slug, slug), eq(nbfcTenants.is_active, true)))
    .limit(1);
  if (!row) throw new Error(`No active NBFC tenant with slug "${slug}".`);

  const loans = await getTenantLoanSlice(row.id);
  const tenant: TenantContext = { ...row, active_loans: loans.length, via: "cron" };

  const { hypotheses: catalogue = [] } = await loadCatalogue({} as never);

  // Results either come from the real upstream node, or from the fixture.
  const results = FIXTURE
    ? (fixtureResults(catalogue) as never[])
    : (((await runTest({ tenant, hypotheses: catalogue } as never)).results ?? []) as never[]);

  console.log(`\n──── INPUT ────`);
  console.log(`  tenant / tenantId : ${tenant.display_name} (${tenant.id})`);
  console.log(`  results to write  : ${results.length}${FIXTURE ? "  — SYNTHETIC FIXTURE, not real measurements" : ""}`);
  console.log(`  mode              : ${WRITE ? "WRITE — rows will be inserted" : "DRY RUN — nothing is written"}`);

  // ── Simulate, always. This is what the node WILL do, derived without doing it.
  console.log(`\n──── WHAT writeCards WOULD DO (per result) ────\n`);
  let newHypotheses = 0;
  let capped = 0;
  let retirements = 0;

  for (const r of results as Array<Record<string, string & boolean & number>>) {
    const hasId = Boolean(r.id);
    const promoted = Boolean(r.promoted);
    const cap = predictCap(String(r.severity), promoted);
    const retire = r.severity === "error" && hasId ? await wouldRetire(String(r.id)) : false;

    if (!hasId) newHypotheses++;
    if (cap.capped) capped++;
    if (retire) retirements++;

    console.log(`  ${String(r.slug).padEnd(34)} ${String(r.severity).toUpperCase()}`);
    console.log(
      `    hypothesis : ${hasId ? `reuse ${String(r.id).slice(0, 8)}… (${promoted ? "PROMOTED" : "unvetted"})` : "INSERT a new risk_hypotheses row"}`,
    );
    console.log(
      `    card       : INSERT risk_card_runs severity='${cap.severity}'` +
        (cap.capped ? `   ← CAPPED from high (unpromoted, E-188)` : ``),
    );
    if (r.severity === "error") {
      console.log(
        `    retirement : ${hasId ? (retire ? "RETIRE — last 3 card runs were all error" : "check runs, not yet 3 strikes") : "NOT CHECKED — no id (a first-run error can never retire)"}`,
      );
    }
    console.log();
  }

  console.log(`──── SUMMARY ────`);
  console.log(`  risk_hypotheses INSERTs : ${newHypotheses}`);
  console.log(`  risk_card_runs  INSERTs : ${results.length}`);
  console.log(`  severities capped       : ${capped}`);
  console.log(`  hypotheses retired      : ${retirements}`);

  if (!WRITE) {
    console.log(
      `\n  Dry run — nothing written.` +
        (FIXTURE
          ? `\n  (Fixture mode: these were synthetic results, chosen to reach the cap /\n` +
            `   insert / retire branches that a real run cannot currently reach.)\n`
          : `\n  Re-run with --write to persist. Note what a real run writes TODAY: with the\n` +
            `  sandbox down every result is inconclusive, so this would stamp ${results.length} "not tested"\n` +
            `  cards over whatever is on the Risk page now.\n`),
    );
    return;
  }

  // ── Real write. Cards must belong to a run: risk_card_runs.run_id → risk_runs,
  // and the page's freshness clock reads it. Same per-tenant lock the button takes.
  const runId = await beginRiskRun(tenant.id, "manual", null);
  try {
    await writeCards({
      tenantId: tenant.id,
      runId,
      results,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
    } as never);
    await completeRiskRun(runId, {
      cards_generated: results.length,
      cards_computed: (results as Array<{ verdict_source: string }>).filter((r) => r.verdict_source === "sandbox").length,
      cards_inconclusive: (results as Array<{ severity: string }>).filter((r) => r.severity === "inconclusive").length,
      cards_errored: (results as Array<{ severity: string }>).filter((r) => r.severity === "error").length,
      prompt_tokens: 0,
      completion_tokens: 0,
    });
    console.log(`\n  Wrote ${results.length} cards. run_id=${runId}\n`);
  } catch (e) {
    await failRiskRun(runId, e);
    throw e;
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nFailed:", e instanceof Error ? e.message : e);
    process.exit(1);
  });

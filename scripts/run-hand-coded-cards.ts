/**
 * Run the 5 hand-coded risk evaluators on their own — node 1 of the risk graph,
 * in isolation, without OpenAI and without the sandbox.
 *
 *   npm run risk:hand-coded                      # DRY RUN — computes, prints, writes nothing
 *   npm run risk:hand-coded -- --tenant=<slug>   # pick the NBFC (default: NBFC_DEMO_TENANT_SLUG)
 *   npm run risk:hand-coded -- --write           # actually persist cards to risk_card_runs
 *   node --import tsx --env-file=.env.local scripts/run-hand-coded-cards.ts --tenant=nbfc-lryx1chs  // run for a specific tenant
 *
 * NOTE: `npm run … -- --tenant=x` can drop the flag on Windows. If the run says
 * `No active NBFC tenant with slug "demo-nbfc"`, the flag never arrived and it
 * fell back to NBFC_DEMO_TENANT_SLUG — use the bare `node …` form above.
 *
 * Dry run is the default on purpose. `runHandCodedCards()` in the graph always
 * writes, and when the IoT tunnel is down every evaluator throws and it writes
 * five `error` cards over your good ones. This script computes the same verdicts
 * and shows them to you first.
 *
 * Prerequisite for real numbers: the IoT bridge must be up, or all five cards
 * come back `error`.
 *
 *   ssh -N iot-bastion
 *
 * ── INPUT ────────────────────────────────────────────────────────────────────
 * The node reads four things, and NOTHING from the LLM or the sandbox:
 *
 *   state.tenantId  → getTenantLoanSlice()  — the tenant's ACTIVE loan slice:
 *                     loan_application_id, vehicleno, current_dpd, emi_amount,
 *                     outstanding_amount. This is the denominator of every card.
 *   loadRiskThresholds()                    — the governed rule catalogue
 *                     (cds_*, emi_overdue_days, usage_drop_pct, geo_shift_km,
 *                     offline_alert_hours, pci_concern). Resolved ONCE per run so
 *                     every card is judged by the same numbers, and snapshotted
 *                     into each card's evidence_json.
 *   risk_hypotheses WHERE source='human'    — which cards exist. The DB row is the
 *                     registry entry; HAND_CODED_CARDS[slug] is the code.
 *   HAND_CODED_CARDS[slug]                  — the TS evaluator. A slug with no
 *                     entry is SKIPPED (the graph does this silently; this script
 *                     prints it).
 *   IoT telemetry DB (via each evaluator)   — reachable in dev only through
 *                     `ssh -N iot-bastion`.
 *
 * Note there is no `python_code` anywhere: these five are hand-written TypeScript,
 * reviewed by humans, and promoted by definition — which is why they are the only
 * cards allowed to raise a High Alert unreduced (the E-188 cap applies to llm-v1).
 *
 * ── OUTPUT ───────────────────────────────────────────────────────────────────
 * The graph's node returns {} — its product is the rows it INSERTs into
 * risk_card_runs, one per evaluator, with llm_model='hand-coded'. This script
 * computes the same CardEvaluation objects and, by default, only prints them:
 *
 *   severity        high | warn | ok | error   (never `inconclusive`, unlike llm-v1)
 *   verdict_source  'hand_coded', or 'none' when the evaluator threw
 *   affected_count / total_count               — total_count is the ASSESSABLE pool,
 *                   not the portfolio: a vehicle with no usable telemetry baseline
 *                   is EXCLUDED, not counted as healthy. So 0/4 on a 7-loan book
 *                   means "4 measurable, none affected", not "all 7 are fine".
 *   finding_summary / evidence.notes           — the notes carry the coverage gaps.
 *
 * ── HOW THIS DIFFERS FROM THE GRAPH'S NODE ───────────────────────────────────
 * Deliberately, in two ways:
 *   1. It does not write unless you pass --write.
 *   2. Even with --write, it REFUSES if any evaluator errored — the graph does
 *      not. In the graph a down IoT tunnel silently overwrites five good cards
 *      with five `error` cards, and the Risk page loses its last real verdicts.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { nbfcTenants, riskHypotheses } from "@/lib/db/schema";
import { getTenantLoanSlice } from "@/lib/nbfc/tenant";
import { loadRiskThresholds } from "@/lib/nbfc/risk-thresholds";
import { HAND_CODED_CARDS, type CardEvaluation } from "@/lib/risk/hand-coded-cards";
import { beginRiskRun, completeRiskRun, failRiskRun } from "@/lib/nbfc/risk-run";
import { riskCardRuns } from "@/lib/db/schema";

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const tenantArg = args.find((a) => a.startsWith("--tenant="))?.split("=")[1];

async function main() {
  const slug = tenantArg ?? process.env.NBFC_DEMO_TENANT_SLUG;
  if (!slug) {
    throw new Error(
      "No tenant. Pass --tenant=<slug> or set NBFC_DEMO_TENANT_SLUG in .env.local.",
    );
  }

  const [tenant] = await db
    .select({ id: nbfcTenants.id, slug: nbfcTenants.slug, display_name: nbfcTenants.display_name })
    .from(nbfcTenants)
    .where(and(eq(nbfcTenants.slug, slug), eq(nbfcTenants.is_active, true)))
    .limit(1);

  if (!tenant) throw new Error(`No active NBFC tenant with slug "${slug}".`);

  // Exactly what node 1 does: the loan slice and the governed thresholds,
  // resolved once so every card in the run is judged by the same numbers.
  const loans = await getTenantLoanSlice(tenant.id);
  const thresholds = await loadRiskThresholds();
  const hyps = await db.select().from(riskHypotheses).where(eq(riskHypotheses.source, "human"));

  const registered = hyps.filter((h) => HAND_CODED_CARDS[h.slug]);
  const unregistered = hyps.filter((h) => !HAND_CODED_CARDS[h.slug]);

  console.log(`\n──── INPUT (everything the evaluators are given) ────`);
  console.log(`  tenant           : ${tenant.display_name} (${tenant.slug})`);
  console.log(`  mode             : ${WRITE ? "WRITE — cards will be persisted" : "DRY RUN — nothing is written"}`);
  console.log(`  loans            : ${loans.length} active  ← getTenantLoanSlice(), the denominator of every card`);
  console.log(`  thresholds       : the governed rule catalogue, resolved ONCE for the whole run`);
  for (const [k, v] of Object.entries(thresholds)) console.log(`      ${k.padEnd(22)} ${v}`);
  console.log(`  hypotheses       : ${hyps.length} rows with source='human'  ← which cards exist`);
  console.log(`  evaluators       : ${registered.length} matched in HAND_CODED_CARDS  ← the TS code that runs`);
  for (const h of registered) console.log(`      ${h.slug}`);
  if (unregistered.length > 0) {
    console.log(`  UNREGISTERED     : ${unregistered.length} — a DB row with no evaluator, silently skipped by the graph`);
    for (const h of unregistered) console.log(`      ${h.slug}`);
  }
  console.log(`  telemetry        : each evaluator reads the IoT DB itself (dev needs: ssh -N iot-bastion)`);
  console.log(`\n  No LLM. No Python sandbox. These five are hand-written TypeScript.`);

  console.log(`\n──── OUTPUT (one CardEvaluation per evaluator) ────`);
  console.log(`  format: slug  SEVERITY  affected/ASSESSABLE (share)  [verdict_source]`);
  console.log(`  NOTE: the denominator is the ASSESSABLE pool, not the ${loans.length}-loan book — a vehicle`);
  console.log(`  with no usable telemetry baseline is EXCLUDED, never counted as healthy.\n`);

  const results: Array<{ slug: string; hypothesis_id: string; ev: CardEvaluation }> = [];

  for (const h of hyps) {
    const evaluator = HAND_CODED_CARDS[h.slug];
    if (!evaluator) {
      console.log(`- ${h.slug.padEnd(30)} SKIPPED (no evaluator registered for this slug)`);
      continue;
    }
    try {
      const ev = await evaluator(loans, thresholds);
      results.push({ slug: h.slug, hypothesis_id: h.id, ev });
      const share = ev.total_count > 0 ? ` (${Math.round((100 * ev.affected_count) / ev.total_count)}%)` : "";
      console.log(
        `- ${h.slug.padEnd(30)} ${ev.severity.toUpperCase().padEnd(13)} ` +
          `${ev.affected_count}/${ev.total_count}${share}  [${ev.verdict_source}]`,
      );
      console.log(`  ${ev.finding_summary}`);
      for (const note of ev.evidence.notes ?? []) console.log(`    · ${note}`);
      console.log();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Same classification the graph makes: a test that could not run is an
      // ERROR, never a clean bill of health.
      results.push({
        slug: h.slug,
        hypothesis_id: h.id,
        ev: {
          slug: h.slug,
          severity: "error",
          verdict_source: "none",
          finding_summary: `Test failed to run: ${msg}`,
          affected_count: 0,
          total_count: 0,
          evidence: { notes: [msg] },
        },
      });
      console.log(`- ${h.slug.padEnd(30)} ERROR         — ${msg}\n`);
    }
  }

  const errored = results.filter((r) => r.ev.severity === "error").length;

  console.log(`──── READING THE RESULT ────`);
  const by = (s: string) => results.filter((r) => r.ev.severity === s).length;
  console.log(
    `  high ${by("high")} · warn ${by("warn")} · ok ${by("ok")} · error ${errored}` +
      `   (hand-coded cards are never 'inconclusive' — that severity is llm-v1 only)`,
  );

  // The share of the book each card could actually see. An all-OK board built on
  // half the portfolio is a coverage report, not a clean bill of health.
  const measured = results.filter((r) => r.ev.severity !== "error");
  if (measured.length > 0 && loans.length > 0) {
    const worst = Math.min(...measured.map((r) => r.ev.total_count));
    const best = Math.max(...measured.map((r) => r.ev.total_count));
    console.log(
      `  coverage: each card assessed ${worst}–${best} of the ${loans.length} active loans.\n` +
        `  The rest were EXCLUDED as unmeasurable (no telemetry baseline) — read the '·' notes\n` +
        `  above for which, and why. An OK verdict only covers the loans it could see.`,
    );
  }

  if (errored === results.length && results.length > 0) {
    console.log(
      "\n!! Every evaluator failed. That is almost always the IoT tunnel being down,\n" +
        "!! not a finding about the portfolio. Start it and re-run:\n" +
        "!!     ssh -N iot-bastion",
    );
  }

  if (!WRITE) {
    console.log("\n  Dry run — nothing written. Re-run with --write to persist these as cards.\n");
    return;
  }

  if (errored > 0) {
    console.log(
      `Refusing to write: ${errored} evaluator(s) failed, and persisting them would\n` +
        `overwrite good cards with error cards. Fix the cause, then re-run with --write.\n`,
    );
    return;
  }

  // Cards must belong to a run — risk_card_runs.run_id points at risk_runs, and
  // the page's freshness clock reads from it. Take the same per-tenant lock the
  // button takes, so this cannot race a cron sweep.
  const runId = await beginRiskRun(tenant.id, "manual", null);
  try {
    for (const { hypothesis_id, ev } of results) {
      await db.insert(riskCardRuns).values({
        tenant_id: tenant.id,
        hypothesis_id,
        run_id: runId,
        severity: ev.severity,
        verdict_source: ev.verdict_source,
        finding_summary: ev.finding_summary,
        affected_count: ev.affected_count,
        total_count: ev.total_count,
        evidence_json: ev.evidence,
        llm_model: "hand-coded",
      });
    }
    await completeRiskRun(runId, {
      cards_generated: results.length,
      cards_computed: results.filter((r) => r.ev.verdict_source === "hand_coded").length,
      cards_inconclusive: results.filter((r) => r.ev.severity === "inconclusive").length,
      cards_errored: errored,
      prompt_tokens: 0,
      completion_tokens: 0,
    });
    console.log(`Wrote ${results.length} cards. run_id=${runId}\n`);
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

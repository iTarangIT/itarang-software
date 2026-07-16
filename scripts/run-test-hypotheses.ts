/**
 * Exercise `runTest()` — node 5 of the risk graph — on its own.
 *
 *   npm run risk:test -- --tenant=<slug>                        # execute the whole catalogue
 *   npm run risk:test -- --tenant=<slug> --slug=low-soc-vehicles # execute ONE hypothesis
 *   node --import tsx --env-file=.env.local scripts/run-test-hypotheses.ts --tenant=<slug>   //run command
 *
 * Writes NOTHING. runTest only computes results into state; write_cards (node 6)
 * persists them. So this is the safe way to see what a run WOULD put on the Risk
 * page before it puts it there. No OpenAI either — the Python already exists.
 *
 * ── PREREQUISITES ────────────────────────────────────────────────────────────
 * Both, or every card comes back `inconclusive`:
 *   1. The Python sandbox:  NBFC_SANDBOX_URL (default http://127.0.0.1:8091)
 *                           + NBFC_SANDBOX_TOKEN matching the service's SANDBOX_TOKEN
 *   2. The IoT telemetry DB, which in dev means the tunnel:  ssh -N iot-bastion
 *
 * ── INPUT ────────────────────────────────────────────────────────────────────
 *   state.hypotheses[] — the catalogue from load_catalogue. Each needs .python_code.
 *   state.tenant       — passed to fetchSandboxData() to build the DataFrames:
 *                          loans          (CRM: the tenant's active loan slice)
 *                          vehicle_states (IoT: latest telemetry per vehicle)
 *                          daily_km       (IoT: last 14 days)
 *   NBFC_SANDBOX_URL / NBFC_SANDBOX_TOKEN — the execution service.
 *
 * ── OUTPUT ───────────────────────────────────────────────────────────────────
 *   { results: HypothesisResult[] } — one per hypothesis, each carrying
 *   severity / verdict_source / affected_count / total_count / finding_summary.
 *   This is the ONLY node that decides a severity for an agent hypothesis.
 *
 * ── THE FIVE OUTCOMES ────────────────────────────────────────────────────────
 * The node's whole design is that a test which could not run is never `ok`:
 *   sandbox down       → EVERY hypothesis inconclusive, one probe, no execution
 *   telemetry down     → EVERY hypothesis inconclusive (a coverage gap, not a finding)
 *   no python_code     → that one inconclusive
 *   Python raised      → error   (a defect in the generated test)
 *   bad severity value → inconclusive (executed, but returned a non-verdict)
 *   clean execution    → high | warn | ok, verdict_source='sandbox'
 *
 * ── WHAT THIS SCRIPT ADDS ────────────────────────────────────────────────────
 * A sanity pass the node does not make. A test that flags 100% of the portfolio
 * is not a finding, it is a broken test — and the node will happily return it as
 * `high`. Known live example: `low-repayment-frequency` computes
 * `loans.groupby('loan_application_id').size()`, which is ALWAYS 1 because that
 * column is the primary key, then flags everything at `<= 1`. It cannot crash, so
 * the 3-strikes auto-retirement never fires. This script prints affected/total as
 * a share and calls out anything at 100%.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { nbfcTenants } from "@/lib/db/schema";
import { getTenantLoanSlice, type TenantContext } from "@/lib/nbfc/tenant";
import { sandboxHealthy } from "@/lib/ai/langgraph/risk-sandbox-client";
import { loadCatalogue, runTest } from "@/lib/ai/langgraph/risk-hypothesis-graph";

const args = process.argv.slice(2);
const tenantArg = args.find((a) => a.startsWith("--tenant="))?.split("=")[1];
const slugArg = args.find((a) => a.startsWith("--slug="))?.split("=")[1];

async function main() {
  const slug = tenantArg ?? process.env.NBFC_DEMO_TENANT_SLUG;
  if (!slug) throw new Error("No tenant. Pass --tenant=<slug> or set NBFC_DEMO_TENANT_SLUG in .env.local.");

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
  const hypotheses = slugArg ? catalogue.filter((h) => h.slug === slugArg) : catalogue;
  if (slugArg && hypotheses.length === 0) {
    throw new Error(`No executable catalogue hypothesis with slug "${slugArg}".`);
  }

  // Probe the same way the node does, so the report explains itself before the
  // node silently downgrades everything.
  const sandboxUrl = process.env.NBFC_SANDBOX_URL ?? "http://127.0.0.1:8091";
  const healthy = await sandboxHealthy();

  console.log(`\n──── INPUT ────`);
  console.log(`  tenant             : ${tenant.display_name} (${tenant.slug})`);
  console.log(`  active loans       : ${tenant.active_loans}`);
  console.log(`  hypotheses to run  : ${hypotheses.length}${slugArg ? `  (filtered to --slug=${slugArg})` : ""}`);
  console.log(`  sandbox            : ${sandboxUrl}  →  ${healthy ? "HEALTHY" : "UNREACHABLE"}`);
  console.log(`  sandbox token      : ${process.env.NBFC_SANDBOX_TOKEN ? "set" : "NOT SET — expect 401"}`);

  if (!healthy) {
    console.log(
      `\n  The sandbox is down, so the node will short-circuit: every hypothesis comes\n` +
        `  back inconclusive without executing. That is the honest degradation, not a bug —\n` +
        `  but you are testing the fallback path, not the tests. Start the sandbox to run for real.`,
    );
  }

  const started = process.hrtime.bigint();
  const out = await runTest({ tenant, hypotheses } as never);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const results = out.results ?? [];

  console.log(`\n──── OUTPUT (${results.length} results · ${ms.toFixed(0)} ms · nothing written) ────\n`);

  const suspect: string[] = [];
  for (const r of results) {
    const share = r.total_count > 0 ? Math.round((100 * r.affected_count) / r.total_count) : null;
    const shareTxt = share === null ? "" : ` (${share}%)`;
    console.log(
      `  ${r.slug.padEnd(34)} ${r.severity.toUpperCase().padEnd(13)} ` +
        `${r.affected_count}/${r.total_count}${shareTxt}  [${r.verdict_source}]`,
    );
    console.log(`    ${r.finding_summary}`);
    if (r.critique) console.log(`    · ${r.critique}`);
    console.log();

    // The node has no opinion about this; it will return `high` for a test that
    // matched every single loan. That is a broken test, not a portfolio finding.
    if (r.total_count > 0 && r.affected_count === r.total_count) suspect.push(r.slug);
  }

  console.log(`──── READING THE RESULT ────`);
  const by = (s: string) => results.filter((r) => r.severity === s).length;
  console.log(
    `  high ${by("high")} · warn ${by("warn")} · ok ${by("ok")} · ` +
      `inconclusive ${by("inconclusive")} · error ${by("error")}`,
  );

  const executed = results.filter((r) => r.verdict_source === "sandbox").length;
  console.log(`  ${executed}/${results.length} actually executed in the sandbox (verdict_source='sandbox').`);

  if (by("inconclusive") === results.length && results.length > 0) {
    console.log(
      `\n  !! Nothing executed. Either the sandbox is down or the IoT telemetry DB is\n` +
        `  !! unreachable (dev needs: ssh -N iot-bastion). Every card says "not tested",\n` +
        `  !! which is correct behaviour — but you have measured nothing.`,
    );
  }

  if (suspect.length > 0) {
    console.log(
      `\n  !! ${suspect.length} test(s) flagged 100% OF THE PORTFOLIO: ${suspect.join(", ")}\n` +
        `  !! A test that matches every loan is a broken test, not a finding — but the node\n` +
        `  !! returns it as a normal verdict, and it never raises an error so the 3-strikes\n` +
        `  !! auto-retirement cannot catch it. Inspect the Python:\n` +
        `  !!     npm run risk:catalogue -- --code`,
    );
  }

  const errored = results.filter((r) => r.severity === "error");
  if (errored.length > 0) {
    console.log(
      `\n  ${errored.length} test(s) raised inside the sandbox. Three consecutive such runs\n` +
        `  retire the hypothesis as broken. Slugs: ${errored.map((e) => e.slug).join(", ")}`,
    );
  }
  console.log(`\n  Nothing was persisted — write_cards (node 6) does that. This was a dry run.\n`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nFailed:", e instanceof Error ? e.message : e);
    process.exit(1);
  });

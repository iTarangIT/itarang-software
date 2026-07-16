/**
 * Exercise `loadCatalogue()` — node 2 of the risk graph — on its own.
 *
 *   npm run risk:catalogue            # summary: what the node would hand downstream
 *   npm run risk:catalogue -- --code  # also print each hypothesis's stored Python
 *   node --import tsx --env-file=.env.local scripts/run-catalogue.ts    //run command
 *
 * Read-only. No OpenAI, no sandbox, no IoT tunnel — it is one SELECT.
 *
 * The node is deliberately tenant-agnostic: it ignores `state` and loads the
 * GLOBAL llm-v1 catalogue, so every tenant re-runs the same hypotheses. That is
 * why there is no --tenant flag here.
 *
 * What this actually checks is the node's filter. `loadCatalogue` returns a row
 * only when it is source='llm-v1' AND retired_at IS NULL AND test_definition
 * carries python_code. So the script queries the raw population itself and
 * reconciles it against what the node returned — if the two disagree, the
 * filter is wrong. A dropped row is not a neutral event: a hypothesis that
 * silently falls out of the catalogue stops being measured, and its card just
 * disappears from the Risk page rather than reporting that it could not run.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { riskHypotheses } from "@/lib/db/schema";
import { loadCatalogue, MAX_ACTIVE_LLM_HYPOTHESES } from "@/lib/ai/langgraph/risk-hypothesis-graph";

const SHOW_CODE = process.argv.slice(2).includes("--code");

async function main() {
  // The node under test. It reads nothing from state, so an empty one is a
  // faithful call — not a stub.
  const out = await loadCatalogue({} as Parameters<typeof loadCatalogue>[0]);
  const drafts = out.hypotheses ?? [];

  // The raw population, so we can account for every row the node dropped.
  const all = await db.select().from(riskHypotheses).where(eq(riskHypotheses.source, "llm-v1"));

  const retired = all.filter((r) => r.retired_at != null);
  const live = all.filter((r) => r.retired_at == null);
  const noCode = live.filter((r) => {
    const def = (r.test_definition ?? {}) as { python_code?: string };
    return !def.python_code;
  });

  console.log(`\nCatalogue (source='llm-v1')`);
  console.log(`  rows in table     : ${all.length}`);
  console.log(`  retired           : ${retired.length}  (retired_at set — excluded)`);
  console.log(`  live but no code  : ${noCode.length}  (no test_definition.python_code — skipped, cannot re-run)`);
  console.log(`  → returned by node: ${drafts.length}  (cap ${MAX_ACTIVE_LLM_HYPOTHESES})`);

  // Reconciliation: live − no-code must equal what the node handed back. If this
  // fails, the node is dropping rows for a reason this script does not model.
  const expected = live.length - noCode.length;
  if (drafts.length !== expected) {
    console.log(
      `\n!! MISMATCH: expected ${expected} executable hypotheses, node returned ${drafts.length}.\n` +
        `!! The node's filter and this script's disagree — one of them is wrong.`,
    );
  }

  if (retired.length > 0) {
    console.log(`\nRetired (kept for history, never re-run):`);
    for (const r of retired) {
      console.log(`  - ${r.slug.padEnd(34)} ${r.retire_reason ?? "no reason recorded"}`);
    }
  }

  if (noCode.length > 0) {
    console.log(
      `\nLive but unexecutable — these were stored before the Python was persisted.\n` +
        `They stay in the catalogue but produce NO card, so nothing on the Risk page\n` +
        `tells you they went unmeasured:`,
    );
    for (const r of noCode) console.log(`  - ${r.slug.padEnd(34)} ${r.title}`);
  }

  if (drafts.length === 0) {
    console.log(
      `\nNothing executable. The graph will fall through to propose_hypotheses and\n` +
        `mint a fresh set on the next real run (that needs OPENAI_API_KEY).\n`,
    );
    return;
  }

  console.log(`\nExecutable hypotheses the graph would re-run:\n`);
  for (const d of drafts) {
    const badge = d.promoted ? "PROMOTED" : "unvetted";
    const lines = (d.python_code ?? "").split("\n").length;
    console.log(`  ${d.slug}`);
    console.log(`    ${d.title}`);
    console.log(`    ${badge.padEnd(9)} ${lines} lines of Python`);
    if (d.test_plan) console.log(`    plan: ${d.test_plan}`);
    if (SHOW_CODE) {
      console.log();
      for (const line of (d.python_code ?? "").split("\n")) console.log(`      ${line}`);
    }
    console.log();
  }

  // An unpromoted hypothesis is capped at `warn` when its card is written (E-188),
  // so a catalogue with no promotions can never raise a High Alert.
  const promoted = drafts.filter((d) => d.promoted).length;
  console.log(
    `${promoted}/${drafts.length} promoted. Unpromoted ones are capped at severity=warn — ` +
      `they cannot raise a High Alert until a human vets them.`,
  );

  if (drafts.length >= MAX_ACTIVE_LLM_HYPOTHESES) {
    console.log(
      `\nAt capacity (${drafts.length} ≥ ${MAX_ACTIVE_LLM_HYPOTHESES}) — a real run would SKIP\n` +
        `plan_dimensions and propose_hypotheses entirely and just re-execute these.`,
    );
  } else {
    console.log(
      `\nRoom for ${MAX_ACTIVE_LLM_HYPOTHESES - drafts.length} more — a real run would propose new ones.`,
    );
  }
  console.log();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nFailed:", e instanceof Error ? e.message : e);
    process.exit(1);
  });

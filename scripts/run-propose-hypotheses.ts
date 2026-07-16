/**
 * Exercise `proposeHypotheses()` — node 4 of the risk graph — on its own.
 *
 *   npm run risk:propose                                   # the branch a REAL run takes today (no-op, 0 tokens)
 *   npm run risk:propose -- --dims=asset_health,repayment  # force the LLM branch with your own dimensions
 *   npm run risk:propose -- --dims=asset_health --code     # ...and print the Python the model wrote
 *   node --import tsx --env-file=.env.local scripts/run-propose-hypotheses.ts --dims=asset_health   //run command
 *
 * NO --tenant flag: unlike plan_dimensions, this node never touches state.tenant.
 * The model proposes hypotheses knowing NOTHING about the portfolio — not the
 * NBFC, not the loan count, not a single row of telemetry. Only a dimension name
 * and the list of slugs it may not reuse.
 *
 * Read-only w.r.t. the DB — the node SELECTs slugs and returns drafts in state.
 * It does not INSERT; persistence happens later in the graph. But --dims SPENDS
 * OPENAI TOKENS: one gpt-4o-mini call per dimension, and these are the expensive
 * calls in the whole graph (each response carries ~60 lines of generated Python).
 *
 * ── INPUT ────────────────────────────────────────────────────────────────────
 *   state.dimensions[]  — from plan_dimensions (node 3). The loop runs once per
 *                         dimension, so this array IS the token bill.
 *   state.hypotheses[]  — the existing catalogue, from load_catalogue (node 2).
 *                         Used for two things: `room` (how many may be added)
 *                         and pass-through (the return value is existing + fresh).
 *   risk_hypotheses.slug — every slug EVER created, re-SELECTed here (not just the
 *                         live ones). Injected into the user message as a
 *                         do-not-reuse list, and used to reject collisions.
 *
 * ── OUTPUT ───────────────────────────────────────────────────────────────────
 *   { hypotheses: [...existing, ...fresh], totalPromptTokens, totalCompletionTokens }
 *
 *   `fresh` is capped at `room = MAX_ACTIVE_LLM_HYPOTHESES - existing.length`.
 *   Each fresh draft has NO `id` (unsaved) and NO `promoted` flag — that is how
 *   downstream code tells a new proposal from a catalogue row.
 *
 * ── THE TWO BRANCHES ─────────────────────────────────────────────────────────
 * A. dimensions == []  → returns the catalogue untouched, zero LLM calls. This is
 *    the branch your real run takes today, because the catalogue is at 12/12 and
 *    plan_dimensions short-circuits to []. Nothing is ever proposed again.
 *
 * B. dimensions non-empty → one LLM call per dimension. Note that `room` is
 *    computed from the catalogue you pass in, and the loop breaks immediately
 *    when `fresh.length >= room`. So with a FULL catalogue and non-empty
 *    dimensions, room is 0 and it breaks before the first call — belt and braces.
 *    To actually reach the model you need BOTH dimensions AND room, which is what
 *    --dims gives you (it also empties the catalogue so room = the full cap).
 *
 * ── WHAT THIS SCRIPT CHECKS THAT THE NODE DOESN'T ────────────────────────────
 * The prompt lays down rules for the generated Python — pandas/numpy only, no
 * file I/O, no network, no exec/eval, under 60 lines, exact `evaluate` signature.
 * `proposeHypotheses` enforces NONE of them. It checks that `slug` and
 * `python_code` are non-empty and stops there; `runTest` then ships the code
 * straight to `executeInSandbox`. The sandbox is the real security boundary — but
 * a rule the prompt states and nothing verifies is worth seeing, so this script
 * lints each proposal against the prompt's own constraints and prints violations.
 */
import { db } from "@/lib/db";
import { riskHypotheses } from "@/lib/db/schema";
import {
  loadCatalogue,
  proposeHypotheses,
  MAX_ACTIVE_LLM_HYPOTHESES,
} from "@/lib/ai/langgraph/risk-hypothesis-graph";

const args = process.argv.slice(2);
const SHOW_CODE = args.includes("--code");
const dimsArg = args.find((a) => a.startsWith("--dims="))?.split("=")[1];
const DIMENSIONS = dimsArg ? dimsArg.split(",").map((d) => d.trim()).filter(Boolean) : [];

/** The prompt's stated rules for generated Python. The node enforces none of them. */
function lintGeneratedCode(code: string): string[] {
  const problems: string[] = [];
  const lines = code.split("\n");

  if (!/def\s+evaluate\s*\(\s*loans\s*,\s*vehicle_states\s*,\s*daily_km\s*\)/.test(code)) {
    problems.push("does not define evaluate(loans, vehicle_states, daily_km) with the required signature");
  }
  if (lines.length > 60) problems.push(`${lines.length} lines — the prompt caps it at 60`);

  // "Use only pandas (as pd) and numpy (as np) — no other imports allowed."
  for (const m of code.matchAll(/^\s*(?:import\s+(\w+)|from\s+(\w+)\s+import)/gm)) {
    const mod = m[1] ?? m[2];
    if (mod !== "pandas" && mod !== "numpy") problems.push(`imports "${mod}" — only pandas/numpy are allowed`);
  }
  for (const banned of ["exec(", "eval(", "open(", "__import__", "subprocess", "requests", "socket"]) {
    if (code.includes(banned)) problems.push(`contains "${banned}" — the prompt forbids file I/O, network, exec/eval`);
  }

  // It must RETURN a verdict, or the sandbox has nothing to take.
  if (!/\breturn\b/.test(code)) problems.push("has no return statement — the sandbox would get no verdict");
  for (const key of ["severity", "affected_count", "total_count", "finding_summary"]) {
    if (!code.includes(key)) problems.push(`never mentions "${key}" — a required key of the returned dict`);
  }
  return problems;
}

async function main() {
  const { hypotheses: catalogue = [] } = await loadCatalogue({} as never);

  // --dims means "show me the LLM branch", which needs room. The real catalogue is
  // full, so we hand the node an EMPTY one — a deliberate lie about the state, and
  // the only way to reach a code path the live catalogue can no longer trigger.
  const forcing = DIMENSIONS.length > 0;
  const existing = forcing ? [] : catalogue;
  const room = MAX_ACTIVE_LLM_HYPOTHESES - existing.length;

  const allSlugs = await db.select({ slug: riskHypotheses.slug }).from(riskHypotheses);

  console.log(`\n──── INPUT ────`);
  console.log(`  state.dimensions      : ${JSON.stringify(DIMENSIONS)}  (${DIMENSIONS.length} → one LLM call each)`);
  console.log(
    `  state.hypotheses.length: ${existing.length}` +
      (forcing ? `  (FORCED to 0 — real catalogue has ${catalogue.length})` : ``),
  );
  console.log(`  room (cap − existing) : ${room}`);
  console.log(`  do-not-reuse slugs    : ${allSlugs.length} (every slug ever created, live or retired)`);

  if (DIMENSIONS.length === 0) {
    console.log(`\n  → branch: A — no dimensions, returns the catalogue untouched, ZERO LLM calls`);
  } else if (room <= 0) {
    console.log(`\n  → branch: B, but room is ${room} — the loop breaks before the first call`);
  } else {
    console.log(`\n  → branch: B — will call gpt-4o-mini ${DIMENSIONS.length}×, may add up to ${room} hypotheses`);
    if (!process.env.OPENAI_API_KEY) throw new Error("Branch B needs OPENAI_API_KEY in .env.local.");
  }

  const started = process.hrtime.bigint();
  const out = await proposeHypotheses({ dimensions: DIMENSIONS, hypotheses: existing } as never);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  const returned = out.hypotheses ?? [];
  const fresh = returned.slice(existing.length); // the node appends: [...existing, ...fresh]

  console.log(`\n──── OUTPUT ────`);
  console.log(`  hypotheses returned   : ${returned.length}  (${existing.length} existing + ${fresh.length} fresh)`);
  console.log(`  totalPromptTokens     : ${out.totalPromptTokens ?? 0}`);
  console.log(`  totalCompletionTokens : ${out.totalCompletionTokens ?? 0}`);
  console.log(`  elapsed               : ${ms.toFixed(0)} ms`);

  if (fresh.length === 0) {
    console.log(
      `\n──── READING THE RESULT ────\n` +
        `  Nothing proposed. The run re-executes the ${catalogue.length} catalogue hypotheses as-is.\n` +
        (DIMENSIONS.length === 0
          ? `  This is what a real run does TODAY — plan_dimensions returns [] at capacity,\n` +
            `  so this node no-ops. To see the LLM path: --dims=asset_health,repayment_history\n`
          : `  Dimensions were supplied but nothing survived — either room was 0, every slug\n` +
            `  collided with the catalogue, or the model emitted no python_code.\n`),
    );
    return;
  }

  console.log(`\n──── FRESH PROPOSALS (unsaved drafts — no id, not yet in the DB) ────\n`);
  let violations = 0;
  for (const h of fresh) {
    const code = h.python_code ?? "";
    const problems = lintGeneratedCode(code);
    violations += problems.length;

    console.log(`  ${h.slug}`);
    console.log(`    title : ${h.title}`);
    console.log(`    desc  : ${h.description}`);
    console.log(`    plan  : ${h.test_plan}`);
    console.log(`    code  : ${code.split("\n").length} lines`);
    if (problems.length === 0) {
      console.log(`    lint  : OK — obeys every rule the prompt states`);
    } else {
      for (const p of problems) console.log(`    LINT !! ${p}`);
    }
    if (SHOW_CODE) {
      console.log();
      for (const line of code.split("\n")) console.log(`      ${line}`);
    }
    console.log();
  }

  console.log(`──── READING THE RESULT ────`);
  console.log(
    `  ${fresh.length} proposed, room was ${room}. These are drafts in memory only — this\n` +
      `  script does not persist them, and neither does the node.`,
  );
  if (violations > 0) {
    console.log(
      `\n  !! ${violations} lint violation(s) across ${fresh.length} proposal(s). The node does not\n` +
        `  !! check any of this — it only requires slug and python_code to be non-empty,\n` +
        `  !! then runTest ships the code straight to the sandbox. The sandbox is the real\n` +
        `  !! boundary; these rules live in the prompt and are enforced nowhere in TS.`,
    );
  }

  // The near-duplicate slugs already in the catalogue (low-soc-vehicles vs
  // low-soc-vehicles-risk, …) came from exactly this: the collision check is
  // exact-match on the slug string, so a reworded restatement always gets through.
  const echoes = fresh.filter((h) =>
    catalogue.some((c) => {
      const a = c.slug.replace(/-/g, " ");
      const b = h.slug.replace(/-/g, " ");
      return a.includes(b) || b.includes(a);
    }),
  );
  if (echoes.length > 0) {
    console.log(
      `\n  Note: ${echoes.length} proposal(s) look like restatements of catalogue slugs ` +
        `(${echoes.map((e) => e.slug).join(", ")}).\n` +
        `  The node's collision check is EXACT string match, so a reworded duplicate passes.\n` +
        `  That is how the catalogue accumulated its near-identical pairs.`,
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

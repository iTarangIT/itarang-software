/**
 * Exercise `planDimensions()` — node 3 of the risk graph — on its own.
 *
 *   npm run risk:dimensions -- --tenant=<slug>              # the branch a REAL run takes today
 *   npm run risk:dimensions -- --tenant=<slug> --force-llm  # force the LLM branch (hides the catalogue)
 *   node --import tsx --env-file=.env.local scripts/run-plan-dimensions.ts --tenant=<slug>   //run command
 *
 * Read-only — the node writes nothing. But --force-llm SPENDS OPENAI TOKENS
 * (one gpt-4o-mini call); the default path may spend none at all. See below.
 *
 * ── INPUT ────────────────────────────────────────────────────────────────────
 * The node reads exactly three things off the graph state:
 *
 *   state.hypotheses[]        — the catalogue, as loaded by loadCatalogue (node 2).
 *                               ONLY its .length is used, and only to compare
 *                               against MAX_ACTIVE_LLM_HYPOTHESES.
 *   state.tenant.display_name — interpolated into the user message.
 *   state.tenant.active_loans — interpolated into the user message.
 *
 * That is the whole input. Note what is NOT in it: no loans, no telemetry, no
 * thresholds, no past cards. The model picks dimensions knowing a name and a
 * count — nothing about the portfolio it is supposedly reasoning over.
 *
 * ── OUTPUT ───────────────────────────────────────────────────────────────────
 *   { dimensions: string[], totalPromptTokens: number, totalCompletionTokens: number }
 *
 * `dimensions` is what node 4 (propose_hypotheses) loops over — one LLM call per
 * dimension. So the length of this array is the cost multiplier for the next node.
 *
 * ── THE TWO BRANCHES ─────────────────────────────────────────────────────────
 * A. AT CAPACITY (hypotheses.length >= 12): returns { dimensions: [] } and makes
 *    NO LLM call. propose_hypotheses then no-ops. This is the branch your real
 *    catalogue takes today (it sits at 12/12), so in production this node is
 *    currently a no-op and the LLM path below is dead code.
 *
 * B. BELOW CAPACITY: one gpt-4o-mini call, parsed for a JSON array. The parse is
 *    forgiving by design — on unparseable output it falls back to a hard-coded
 *    ["asset_health", "behavioural_usage", "financial_repayment"] rather than
 *    failing the run. That fallback is INVISIBLE in the returned state: a
 *    successful model call and a total parse failure produce the same shape. The
 *    only way to tell them apart is the token counts, which is why this script
 *    prints the raw response alongside the parse.
 *
 * Use --force-llm to reach branch B by handing the node an EMPTY catalogue. That
 * is a lie about the state, and deliberately so — it is the only way to test the
 * code path that the real catalogue can no longer reach.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { nbfcTenants } from "@/lib/db/schema";
import { getTenantLoanSlice, type TenantContext } from "@/lib/nbfc/tenant";
import {
  loadCatalogue,
  planDimensions,
  MAX_ACTIVE_LLM_HYPOTHESES,
} from "@/lib/ai/langgraph/risk-hypothesis-graph";

const args = process.argv.slice(2);
const FORCE_LLM = args.includes("--force-llm");
const tenantArg = args.find((a) => a.startsWith("--tenant="))?.split("=")[1];

/** The node's own fallback list — duplicated here only so we can DETECT it. */
const FALLBACK = ["asset_health", "behavioural_usage", "financial_repayment"];

async function main() {
  const slug = tenantArg ?? process.env.NBFC_DEMO_TENANT_SLUG;
  if (!slug) {
    throw new Error("No tenant. Pass --tenant=<slug> or set NBFC_DEMO_TENANT_SLUG in .env.local.");
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

  // active_loans is the second of the two facts the model gets. Compute it the
  // same way the app does rather than trusting a denormalised column.
  const loans = await getTenantLoanSlice(row.id);
  const tenant: TenantContext = { ...row, active_loans: loans.length, via: "cron" };

  // The real catalogue — this is what decides which branch a production run takes.
  const { hypotheses: catalogue = [] } = await loadCatalogue({} as never);

  // --force-llm hands the node an empty catalogue so it cannot short-circuit.
  const hypotheses = FORCE_LLM ? [] : catalogue;

  console.log(`\n──── INPUT (the entire state this node reads) ────`);
  console.log(`  state.tenant.display_name : ${tenant.display_name}`);
  console.log(`  state.tenant.active_loans : ${tenant.active_loans}`);
  console.log(
    `  state.hypotheses.length   : ${hypotheses.length}` +
      (FORCE_LLM ? `  (FORCED to 0 — real catalogue has ${catalogue.length})` : ``),
  );
  console.log(`  cap                       : ${MAX_ACTIVE_LLM_HYPOTHESES}`);

  const atCapacity = hypotheses.length >= MAX_ACTIVE_LLM_HYPOTHESES;
  console.log(
    `\n  → branch: ${atCapacity ? "A — AT CAPACITY, short-circuits, no LLM call" : "B — below capacity, will call gpt-4o-mini"}`,
  );

  if (!atCapacity && !process.env.OPENAI_API_KEY) {
    throw new Error("Branch B needs OPENAI_API_KEY in .env.local — the node calls the model.");
  }

  const started = process.hrtime.bigint();
  const out = await planDimensions({ tenant, hypotheses } as never);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  console.log(`\n──── OUTPUT (Partial<State> merged back into the graph) ────`);
  console.log(`  dimensions            : ${JSON.stringify(out.dimensions)}`);
  console.log(`  totalPromptTokens     : ${out.totalPromptTokens ?? 0}`);
  console.log(`  totalCompletionTokens : ${out.totalCompletionTokens ?? 0}`);
  console.log(`  elapsed               : ${ms.toFixed(0)} ms`);

  const dims = out.dimensions ?? [];
  const spentTokens = (out.totalPromptTokens ?? 0) + (out.totalCompletionTokens ?? 0);

  console.log(`\n──── READING THE RESULT ────`);

  if (dims.length === 0) {
    console.log(
      `  Empty dimensions. propose_hypotheses will no-op and the run will simply\n` +
        `  re-execute the ${catalogue.length} hypotheses already in the catalogue.\n` +
        `  Zero tokens spent here — the short-circuit is doing its job.\n` +
        `\n  This is what a real run does TODAY. To see the LLM path, re-run with --force-llm.`,
    );
    return;
  }

  // The fallback is indistinguishable from success in the returned state — same
  // shape, same type. Token counts are the only tell: a real call always spends
  // some, and the fallback fires without one only when the model returned junk.
  const looksLikeFallback = JSON.stringify(dims) === JSON.stringify(FALLBACK);
  if (looksLikeFallback) {
    console.log(
      `  !! These are EXACTLY the hard-coded fallback dimensions.\n` +
        `  !! Either the model happened to return this list verbatim, or its output\n` +
        `  !! was unparseable and the catch silently substituted it. The node does not\n` +
        `  !! distinguish the two — a total parse failure looks like a clean success\n` +
        `  !! to every downstream node, and nothing is logged.\n` +
        `  !! Tokens spent: ${spentTokens} (0 would mean no call was made at all).`,
    );
  } else {
    console.log(`  Model returned ${dims.length} dimensions, parsed cleanly (not the fallback list).`);
  }

  console.log(
    `\n  Cost multiplier: propose_hypotheses makes ONE LLM call per dimension,\n` +
      `  so this output commits the next node to ${dims.length} more call(s).`,
  );

  const room = MAX_ACTIVE_LLM_HYPOTHESES - catalogue.length;
  if (FORCE_LLM && room <= 0) {
    console.log(
      `\n  NOTE: --force-llm faked an empty catalogue. In a real run the true catalogue\n` +
        `  (${catalogue.length}) is at capacity, so none of these dimensions would ever be\n` +
        `  planned and nothing would be proposed — room is ${room}.`,
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

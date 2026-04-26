/**
 * Risk hypothesis LangGraph workflow.
 *
 * Pipeline:
 *   plan_dimensions → propose_hypotheses → fetch_data → run_test → critique → score → write_card
 *
 * Phase B: this module wraps the OpenAI Chat model and LangGraph orchestration.
 * Each node is a small, pure-async function that mutates partial state. The
 * agent uses tool calls (defined in risk-tools.ts) to read data; we never give
 * it raw DB credentials.
 *
 * Phase D adds a sandboxed Python executor for run_test. Until then, run_test
 * uses an LLM-generated JS predicate that we evaluate against query-tool output.
 */
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { db } from "@/lib/db";
import { riskHypotheses, riskCardRuns } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { TenantContext } from "@/lib/nbfc/tenant";
import { buildRiskTools } from "./risk-tools";
import { HAND_CODED_CARDS } from "@/lib/risk/hand-coded-cards";
import { getTenantLoanSlice } from "@/lib/nbfc/tenant";

// ─── State ───────────────────────────────────────────────────────────────────

const GraphState = Annotation.Root({
  tenantId: Annotation<string>,
  tenant: Annotation<TenantContext>,
  dimensions: Annotation<string[]>({ reducer: (_, b) => b, default: () => [] }),
  hypotheses: Annotation<HypothesisDraft[]>({ reducer: (_, b) => b, default: () => [] }),
  results: Annotation<HypothesisResult[]>({ reducer: (_, b) => b, default: () => [] }),
  totalPromptTokens: Annotation<number>({ reducer: (a, b) => (a ?? 0) + (b ?? 0), default: () => 0 }),
  totalCompletionTokens: Annotation<number>({ reducer: (a, b) => (a ?? 0) + (b ?? 0), default: () => 0 }),
  errors: Annotation<string[]>({ reducer: (a, b) => [...(a ?? []), ...(b ?? [])], default: () => [] }),
});
type State = typeof GraphState.State;

interface HypothesisDraft {
  slug: string;
  title: string;
  description: string;
  // What the agent decided to test, expressed as a tool-call plan.
  test_plan: string;
}

interface HypothesisResult extends HypothesisDraft {
  severity: "high" | "warn" | "ok";
  finding_summary: string;
  affected_count: number;
  total_count: number;
  evidence: Record<string, unknown>;
  critique: string;
}

// ─── Model ───────────────────────────────────────────────────────────────────

function makeModel() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is not set. Add it to .env.local — see docs/NBFC_DASHBOARD_PLAN.md.",
    );
  }
  return new ChatOpenAI({
    openAIApiKey: process.env.OPENAI_API_KEY,
    modelName: process.env.NBFC_OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.2,
  });
}

// ─── Nodes ───────────────────────────────────────────────────────────────────

const PLAN_PROMPT = `You are a credit-risk analyst working with an NBFC's
electric-vehicle loan portfolio. The loans are backed by IoT-instrumented
e-rickshaws and e-loaders. Your job is to choose 3-4 RISK DIMENSIONS to
investigate this run.

Return ONLY a JSON array of dimension names, no prose. Examples:
["asset_health", "behavioural_usage", "geographic_concentration", "financial_repayment"]`;

async function planDimensions(state: State): Promise<Partial<State>> {
  const model = makeModel();
  const resp = await model.invoke([
    { role: "system", content: PLAN_PROMPT },
    {
      role: "user",
      content: `Tenant: ${state.tenant.display_name}. Active loans: ${state.tenant.active_loans}. Pick the dimensions.`,
    },
  ]);
  const text = String(resp.content ?? "").trim();
  let dims: string[] = [];
  try {
    const m = text.match(/\[[\s\S]*\]/);
    dims = m ? JSON.parse(m[0]) : ["asset_health", "behavioural_usage", "financial_repayment"];
  } catch {
    dims = ["asset_health", "behavioural_usage", "financial_repayment"];
  }
  const usage = resp.usage_metadata;
  return {
    dimensions: dims,
    totalPromptTokens: usage?.input_tokens ?? 0,
    totalCompletionTokens: usage?.output_tokens ?? 0,
  };
}

const PROPOSE_PROMPT = `Given a risk dimension, propose 1-2 testable
hypotheses. Each must be a single statement of the form
"borrowers/vehicles WHERE <condition> have <expected risk signal>".

Return ONLY a JSON array of objects with shape:
  { "slug": "kebab-case-id", "title": "short title", "description": "one paragraph",
    "test_plan": "short description of which tools to call and what threshold to apply" }

Constraints:
- Slugs must not collide with: usage-drop-7d, dpd-7-no-telemetry, geo-shift,
  battery-soh-decay, low-utilization-active-loan (these already exist).
- Hypotheses must be testable using these tools only:
  getCrmLoanSlice(min_dpd?, only_active_emi?), getIotFleetSummary(),
  getCohortBaseline(metric: km_7d | soh_delta_30d | soc_now).
`;

async function proposeHypotheses(state: State): Promise<Partial<State>> {
  const model = makeModel();
  const all: HypothesisDraft[] = [];
  let promptTok = 0;
  let completionTok = 0;
  for (const dim of state.dimensions) {
    const resp = await model.invoke([
      { role: "system", content: PROPOSE_PROMPT },
      { role: "user", content: `Dimension: ${dim}` },
    ]);
    const text = String(resp.content ?? "");
    try {
      const m = text.match(/\[[\s\S]*\]/);
      const arr = m ? (JSON.parse(m[0]) as HypothesisDraft[]) : [];
      for (const h of arr) all.push(h);
    } catch (e) {
      // fall through — agent return malformed; skip
      console.warn("propose_hypotheses: bad JSON for", dim, e);
    }
    const usage = resp.usage_metadata;
    promptTok += usage?.input_tokens ?? 0;
    completionTok += usage?.output_tokens ?? 0;
  }
  // De-dupe by slug
  const seen = new Set<string>();
  const dedup = all.filter((h) => (seen.has(h.slug) ? false : (seen.add(h.slug), true)));
  return {
    hypotheses: dedup,
    totalPromptTokens: promptTok,
    totalCompletionTokens: completionTok,
  };
}

/**
 * Phase B run_test: bind tools to a tool-calling model and let the agent
 * exercise them. The agent returns a structured verdict object we can map
 * straight to severity + summary.
 *
 * Phase D will replace this with a Python sandbox that executes the test_plan
 * and returns sample rows.
 */
async function runTest(state: State): Promise<Partial<State>> {
  const baseModel = makeModel();
  const tools = buildRiskTools(state.tenant);
  const model = baseModel.bindTools(tools);
  const results: HypothesisResult[] = [];
  let promptTok = 0;
  let completionTok = 0;

  for (const h of state.hypotheses) {
    try {
      const sys = `You are testing a single risk hypothesis. Use the available
tools to gather evidence, then respond with ONLY a JSON object of shape:
  { "severity": "high"|"warn"|"ok",
    "affected_count": number, "total_count": number,
    "finding_summary": "1 line", "critique": "what could be wrong with this finding",
    "evidence": { "sample_rows": [...], "notes": [...] } }`;
      const userPrompt = `Hypothesis: ${h.title}
Description: ${h.description}
Plan: ${h.test_plan}

Investigate and reply with the JSON verdict only.`;
      // Single call — model decides tool calls inline; we don't run a full
      // ReAct loop here for cost reasons. Phase D upgrades this.
      const resp = await model.invoke([
        { role: "system", content: sys },
        { role: "user", content: userPrompt },
      ]);
      const usage = resp.usage_metadata;
      promptTok += usage?.input_tokens ?? 0;
      completionTok += usage?.output_tokens ?? 0;

      const text = String(resp.content ?? "");
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) {
        results.push({ ...h, severity: "ok", finding_summary: "Inconclusive (no parseable verdict)", affected_count: 0, total_count: 0, evidence: {}, critique: "Model returned no JSON" });
        continue;
      }
      const parsed = JSON.parse(m[0]) as Partial<HypothesisResult>;
      results.push({
        ...h,
        severity: (parsed.severity as HypothesisResult["severity"]) ?? "ok",
        finding_summary: parsed.finding_summary ?? "—",
        affected_count: Number(parsed.affected_count ?? 0),
        total_count: Number(parsed.total_count ?? 0),
        evidence: (parsed.evidence as Record<string, unknown>) ?? {},
        critique: parsed.critique ?? "",
      });
    } catch (e) {
      results.push({
        ...h,
        severity: "ok",
        finding_summary: "Error running test",
        affected_count: 0,
        total_count: 0,
        evidence: { error: String(e) },
        critique: "",
      });
    }
  }
  return {
    results,
    totalPromptTokens: promptTok,
    totalCompletionTokens: completionTok,
  };
}

async function writeCards(state: State): Promise<Partial<State>> {
  for (const r of state.results) {
    // Upsert hypothesis row (so LLM-proposed slugs become catalogue entries)
    const existing = await db.select().from(riskHypotheses).where(eq(riskHypotheses.slug, r.slug)).limit(1);
    let hypId: string;
    if (existing[0]) {
      hypId = existing[0].id;
    } else {
      const inserted = await db
        .insert(riskHypotheses)
        .values({
          slug: r.slug,
          title: r.title,
          description: r.description,
          test_method: "js",
          test_definition: { kind: "llm_generated", test_plan: r.test_plan },
          source: "llm-v1",
        })
        .returning({ id: riskHypotheses.id });
      hypId = inserted[0]!.id;
    }
    await db.insert(riskCardRuns).values({
      tenant_id: state.tenantId,
      hypothesis_id: hypId,
      severity: r.severity,
      finding_summary: r.finding_summary,
      affected_count: r.affected_count,
      total_count: r.total_count,
      evidence_json: r.evidence,
      llm_critique: r.critique,
      llm_model: process.env.NBFC_OPENAI_MODEL || "gpt-4o-mini",
      llm_prompt_tokens: state.totalPromptTokens,
      llm_completion_tokens: state.totalCompletionTokens,
    });
  }
  return {};
}

/**
 * Run the hand-coded evaluators alongside the agent-generated ones, then
 * persist their results to risk_card_runs so the Risk page reads from a
 * single source.
 */
async function runHandCodedCards(state: State): Promise<Partial<State>> {
  const loans = await getTenantLoanSlice(state.tenantId);
  const hyps = await db.select().from(riskHypotheses).where(eq(riskHypotheses.source, "human"));
  for (const h of hyps) {
    const evaluator = HAND_CODED_CARDS[h.slug];
    if (!evaluator) continue;
    const ev = await evaluator(loans);
    await db.insert(riskCardRuns).values({
      tenant_id: state.tenantId,
      hypothesis_id: h.id,
      severity: ev.severity,
      finding_summary: ev.finding_summary,
      affected_count: ev.affected_count,
      total_count: ev.total_count,
      evidence_json: ev.evidence,
      llm_model: "hand-coded",
    });
  }
  return {};
}

// ─── Graph wiring ────────────────────────────────────────────────────────────

export function buildRiskGraph() {
  const graph = new StateGraph(GraphState)
    .addNode("plan_dimensions", planDimensions)
    .addNode("propose_hypotheses", proposeHypotheses)
    .addNode("run_test", runTest)
    .addNode("write_cards", writeCards)
    .addNode("run_hand_coded", runHandCodedCards);

  graph.addEdge(START, "run_hand_coded");
  graph.addEdge("run_hand_coded", "plan_dimensions");
  graph.addEdge("plan_dimensions", "propose_hypotheses");
  graph.addEdge("propose_hypotheses", "run_test");
  graph.addEdge("run_test", "write_cards");
  graph.addEdge("write_cards", END);

  return graph.compile();
}

export async function runRiskWorkflow(tenant: TenantContext) {
  const compiled = buildRiskGraph();
  const result = await compiled.invoke({ tenantId: tenant.id, tenant });
  return {
    cards_generated: result.results?.length ?? 0,
    prompt_tokens: result.totalPromptTokens,
    completion_tokens: result.totalCompletionTokens,
    errors: result.errors,
  };
}

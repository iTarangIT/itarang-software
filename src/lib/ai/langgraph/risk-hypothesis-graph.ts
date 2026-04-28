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
import { executeInSandbox, sandboxHealthy } from "./risk-sandbox-client";
import { HAND_CODED_CARDS } from "@/lib/risk/hand-coded-cards";
import { getTenantLoanSlice } from "@/lib/nbfc/tenant";
import { db as crmDb } from "@/lib/db";
import { nbfcLoans } from "@/lib/db/schema";
import { and } from "drizzle-orm";
import { getDailyKm, getVehicleStates } from "@/lib/db/iot-queries";

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
  // Phase D: optional Python source defining `def evaluate(**dataframes) -> dict`.
  // When the sandbox is healthy, runTest executes this against tenant data
  // instead of asking the LLM to verdict from tool-call output.
  python_code?: string;
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
  {
    "slug": "kebab-case-id",
    "title": "short title (≤8 words)",
    "description": "one paragraph (≤2 sentences)",
    "test_plan": "1-2 sentences describing what to test",
    "python_code": "def evaluate(loans, vehicle_states, daily_km):\\n    ..."
  }

The python_code field MUST define a function with this exact signature:

    def evaluate(loans, vehicle_states, daily_km):
        # loans:          DataFrame with columns
        #   loan_application_id, vehicleno, current_dpd, emi_amount, outstanding_amount
        # vehicle_states: DataFrame with columns
        #   vehicleno, online, last_gps_at, sec_since_gps, lat, lon, speed_kph,
        #   ignition, soc_pct, soh_pct, pack_voltage, pack_temp_c
        # daily_km:       DataFrame with columns day, vehicleno, km (last 14 days)
        #
        # MUST return a dict with keys:
        #   severity:        "high" | "warn" | "ok"
        #   affected_count:  int
        #   total_count:     int
        #   finding_summary: str (1 line)
        #   evidence:        { "sample_rows": [...up to 10 rows], "notes": [...] }
        ...

Use only pandas (as pd) and numpy (as np) — no other imports allowed.
No file I/O, no network, no exec/eval.

Severity rule of thumb:
  high: ≥5% of loans affected
  warn: 1-5% of loans affected
  ok:   <1% of loans affected

Constraints:
- Slugs must not collide with: usage-drop-7d, dpd-7-no-telemetry, geo-shift,
  battery-soh-decay, low-utilization-active-loan (these already exist).
- Don't reference data sources beyond loans / vehicle_states / daily_km.
- Keep code under 60 lines.
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
 * Phase D run_test: prefer the Python sandbox when it's available — the agent
 * proposed `python_code`, we hand it real DataFrames, and we trust the
 * deterministic verdict. Falls back to the Phase B LLM-tool-call path if the
 * sandbox is unhealthy or the agent didn't produce code.
 */
async function runTest(state: State): Promise<Partial<State>> {
  const baseModel = makeModel();
  const tools = buildRiskTools(state.tenant);
  const model = baseModel.bindTools(tools);
  const results: HypothesisResult[] = [];
  let promptTok = 0;
  let completionTok = 0;

  // Probe the sandbox once per run rather than per-hypothesis.
  const sandboxOk = await sandboxHealthy();
  // Fetch the tenant data slice once — the same DataFrames are reused for
  // every sandbox call.
  const sandboxData = sandboxOk ? await fetchSandboxData(state.tenant) : null;
  if (sandboxOk) console.log("[risk-graph] sandbox OK — using Python execution path");
  else console.log("[risk-graph] sandbox unavailable — falling back to LLM-tool-call verdict");

  for (const h of state.hypotheses) {
    // ── Phase D: Python sandbox path ────────────────────────────────────
    if (sandboxOk && sandboxData && h.python_code) {
      try {
        const sb = await executeInSandbox({
          hypothesis_slug: h.slug,
          code: h.python_code,
          data: sandboxData,
        });
        if (sb.ok && sb.result) {
          results.push({
            ...h,
            severity: (sb.result.severity as HypothesisResult["severity"]) ?? "ok",
            finding_summary: sb.result.finding_summary ?? "—",
            affected_count: Number(sb.result.affected_count ?? 0),
            total_count: Number(sb.result.total_count ?? 0),
            evidence: (sb.result.evidence as Record<string, unknown>) ?? {},
            critique: `python sandbox · ${sb.elapsed_ms}ms`,
          });
          continue;
        }
        // Sandbox returned an error — log it on the card so operators can see
        // what went wrong, but don't crash the whole run.
        results.push({
          ...h,
          severity: "ok",
          finding_summary: `Sandbox error: ${sb.error ?? "unknown"}`,
          affected_count: 0,
          total_count: 0,
          evidence: { sandbox_error: sb.error, elapsed_ms: sb.elapsed_ms },
          critique: "Phase D sandbox could not evaluate this hypothesis",
        });
        continue;
      } catch (e) {
        // Network/transport failure — fall through to LLM path.
        console.warn(`[risk-graph] sandbox transport error for ${h.slug}; falling back to LLM`, e);
      }
    }

    // ── Phase B fallback: LLM-tool-call verdict ─────────────────────────
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

/**
 * Phase D helper: snapshot of the tenant's data shaped as JSON arrays the
 * sandbox can wrap into pandas DataFrames. Single fetch reused across all
 * hypotheses in a run.
 */
async function fetchSandboxData(
  tenant: TenantContext,
): Promise<Record<string, unknown[]>> {
  // 1. Loans for this tenant
  const loanRows = await crmDb
    .select({
      loan_application_id: nbfcLoans.loan_application_id,
      vehicleno: nbfcLoans.vehicleno,
      current_dpd: nbfcLoans.current_dpd,
      emi_amount: nbfcLoans.emi_amount,
      outstanding_amount: nbfcLoans.outstanding_amount,
    })
    .from(nbfcLoans)
    .where(and(eq(nbfcLoans.tenant_id, tenant.id), eq(nbfcLoans.is_active, true)));
  const loans = loanRows.map((l) => ({
    loan_application_id: l.loan_application_id,
    vehicleno: l.vehicleno,
    current_dpd: l.current_dpd,
    emi_amount: l.emi_amount != null ? Number(l.emi_amount) : null,
    outstanding_amount: l.outstanding_amount != null ? Number(l.outstanding_amount) : null,
  }));
  const vnos = loans.map((l) => l.vehicleno).filter((v): v is string => !!v);

  // 2. Per-vehicle current state from IoT
  const states = await getVehicleStates(vnos);

  // 3. Last 14 days of km per vehicle
  const daily = await getDailyKm(vnos, 14);
  const dailyKm = daily.map((r) => ({
    day: r.day.toISOString().slice(0, 10),
    vehicleno: r.vehicleno,
    km: r.km,
  }));

  return {
    loans,
    vehicle_states: states.map((s) => ({
      ...s,
      last_gps_at: s.last_gps_at?.toISOString() ?? null,
    })),
    daily_km: dailyKm,
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

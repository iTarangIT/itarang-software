/**
 * Risk hypothesis LangGraph workflow.
 *
 * Pipeline (actual):
 *   run_hand_coded → plan_dimensions → propose_hypotheses → run_test → write_cards
 *
 * The LLM's job is to PROPOSE hypotheses and author the Python that tests them.
 * It never states a verdict. Severity and counts come from exactly two places:
 * the hand-coded TS evaluators, and Python executed deterministically against
 * real DataFrames in the sandbox. If the sandbox is unavailable, or the agent
 * emitted no code, the card is `inconclusive` — never `ok`. A card that says OK
 * must mean "we tested this and found nothing", not "we could not test this".
 */
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { db } from "@/lib/db";
import { riskHypotheses, riskCardRuns } from "@/lib/db/schema";
import { desc, eq, isNull } from "drizzle-orm";
import type { TenantContext } from "@/lib/nbfc/tenant";
import { executeInSandbox, sandboxHealthy } from "./risk-sandbox-client";
import { HAND_CODED_CARDS } from "@/lib/risk/hand-coded-cards";
import { loadRiskThresholds } from "@/lib/nbfc/risk-thresholds";
import {
  beginRiskRun,
  completeRiskRun,
  failRiskRun,
  type RunTrigger,
} from "@/lib/nbfc/risk-run";
import type { Severity, VerdictSource } from "@/lib/risk/severity";
import { getTenantLoanSlice } from "@/lib/nbfc/tenant";
import { db as crmDb } from "@/lib/db";
import { nbfcLoans } from "@/lib/db/schema";
import { and } from "drizzle-orm";
import { getDailyKm, getVehicleStates } from "@/lib/db/iot-queries";

// ─── State ───────────────────────────────────────────────────────────────────

const GraphState = Annotation.Root({
  tenantId: Annotation<string>,
  tenant: Annotation<TenantContext>,
  /** The risk_runs row this invocation belongs to (E-187). */
  runId: Annotation<string>,
  dimensions: Annotation<string[]>({ reducer: (_, b) => b, default: () => [] }),
  hypotheses: Annotation<HypothesisDraft[]>({ reducer: (_, b) => b, default: () => [] }),
  results: Annotation<HypothesisResult[]>({ reducer: (_, b) => b, default: () => [] }),
  totalPromptTokens: Annotation<number>({ reducer: (a, b) => (a ?? 0) + (b ?? 0), default: () => 0 }),
  totalCompletionTokens: Annotation<number>({ reducer: (a, b) => (a ?? 0) + (b ?? 0), default: () => 0 }),
});
type State = typeof GraphState.State;

interface HypothesisDraft {
  slug: string;
  title: string;
  description: string;
  // What the agent decided to test, expressed as a tool-call plan.
  test_plan: string;
  // Python source defining `def evaluate(loans, vehicle_states, daily_km) -> dict`.
  // Persisted to risk_hypotheses.test_definition so later runs re-execute the
  // same test instead of the agent inventing a fresh one every time.
  python_code?: string;
  /** Set for hypotheses loaded from the catalogue; absent for newly proposed ones. */
  id?: string;
  /**
   * Vetted by a human (E-188). An unpromoted llm-v1 hypothesis is capped at
   * `warn` when its card is written — a machine-invented test does not get to
   * declare a High Alert on the strength of its own say-so.
   */
  promoted?: boolean;
}

/**
 * How many live agent-authored hypotheses we keep. Below this, a run proposes
 * new ones; at or above it, the run simply re-executes what is already in the
 * catalogue.
 *
 * Without a cap, every click of "Re-run analysis" minted 6-8 fresh slugs, tested
 * them once, and abandoned them — the catalogue hit 45 with only ~8 current, so
 * the page filled with stale one-shot verdicts that reshuffled on every click.
 */
const MAX_ACTIVE_LLM_HYPOTHESES = 12;

/** Consecutive failed runs after which a hypothesis is retired as broken. */
const RETIRE_AFTER_CONSECUTIVE_ERRORS = 3;

interface HypothesisResult extends HypothesisDraft {
  severity: Severity;
  verdict_source: VerdictSource;
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

/**
 * Load the live agent-authored hypotheses and their stored Python.
 *
 * This is what makes a run reproducible. Previously the catalogue was write-only:
 * the agent proposed hypotheses, we tested them once, stored the slug, threw the
 * code away, and next run invented entirely different ones. Nothing was ever
 * re-measured, so no card could be compared to itself over time.
 */
async function loadCatalogue(state: State): Promise<Partial<State>> {
  const rows = await db
    .select()
    .from(riskHypotheses)
    .where(and(eq(riskHypotheses.source, "llm-v1"), isNull(riskHypotheses.retired_at)));

  const drafts: HypothesisDraft[] = [];
  for (const r of rows) {
    const def = (r.test_definition ?? {}) as { python_code?: string; test_plan?: string };
    // Hypotheses stored before code was persisted have nothing to re-run. Leave
    // them in the catalogue (their history is real) but skip them this run —
    // they cannot be executed, and we will not guess a verdict for them.
    if (!def.python_code) continue;
    drafts.push({
      id: r.id,
      slug: r.slug,
      title: r.title,
      description: r.description,
      test_plan: def.test_plan ?? "",
      python_code: def.python_code,
      promoted: r.promoted_at != null,
    });
  }

  console.log(
    `[risk-graph] catalogue: ${drafts.length} executable agent hypotheses (cap ${MAX_ACTIVE_LLM_HYPOTHESES})`,
  );
  return { hypotheses: drafts };
}

async function planDimensions(state: State): Promise<Partial<State>> {
  // At capacity: re-run what we have rather than inventing more. This is the
  // single change that stops the catalogue growing without bound — and it also
  // skips two LLM calls per run.
  if (state.hypotheses.length >= MAX_ACTIVE_LLM_HYPOTHESES) {
    console.log("[risk-graph] catalogue at capacity — re-running existing hypotheses, proposing none");
    return { dimensions: [] };
  }

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
- The user message lists every slug already in the catalogue. Do not reuse any of
  them, and do not propose a hypothesis that merely restates one.
- Don't reference data sources beyond loans / vehicle_states / daily_km.
- Keep code under 60 lines.
- python_code is MANDATORY. A hypothesis with no executable test is discarded.

Propose hypotheses worth acting on. A test that flags most of the portfolio
("vehicles with an ignition status", "vehicles with demand") is noise, not risk:
it tells a credit officer nothing they can do anything about. Prefer a specific,
actionable condition that a minority of borrowers meet.

Return ONLY the JSON array — no prose, no markdown fences.
`;

async function proposeHypotheses(state: State): Promise<Partial<State>> {
  const existing = state.hypotheses; // loaded from the catalogue by loadCatalogue
  if (state.dimensions.length === 0) {
    return { hypotheses: existing }; // at capacity — nothing to propose
  }

  const model = makeModel();
  const fresh: HypothesisDraft[] = [];
  let promptTok = 0;
  let completionTok = 0;

  // Slug collisions must be checked against the WHOLE catalogue, not just this
  // run: the old code only de-duped within a single run and hard-coded a stale
  // list of five slugs into the prompt, so a re-proposed slug silently reused
  // the existing row's title while overwriting nothing.
  const takenSlugs = new Set(
    (await db.select({ slug: riskHypotheses.slug }).from(riskHypotheses)).map((r) => r.slug),
  );

  const room = MAX_ACTIVE_LLM_HYPOTHESES - existing.length;

  for (const dim of state.dimensions) {
    if (fresh.length >= room) break;
    const resp = await model.invoke([
      { role: "system", content: PROPOSE_PROMPT },
      {
        role: "user",
        content: `Dimension: ${dim}\n\nSlugs already taken (do not reuse): ${[...takenSlugs].join(", ")}`,
      },
    ]);
    const usage = resp.usage_metadata;
    promptTok += usage?.input_tokens ?? 0;
    completionTok += usage?.output_tokens ?? 0;

    const parsed = parseHypothesisArray(String(resp.content ?? ""));
    if (!parsed) {
      // The model returned unparseable JSON. This used to be a console.warn and
      // the whole dimension vanished — a silent loss of work the operator never
      // saw. It is still not fatal, but it is now counted and reported.
      console.warn(`[risk-graph] propose_hypotheses: unparseable JSON for dimension "${dim}" — dropped`);
      continue;
    }

    for (const h of parsed) {
      if (fresh.length >= room) break;
      if (!h?.slug || takenSlugs.has(h.slug)) continue; // never collide with the catalogue
      if (!h.python_code) continue; // no code means no test; do not store a hypothesis we cannot run
      takenSlugs.add(h.slug);
      fresh.push(h);
    }
  }

  console.log(`[risk-graph] proposed ${fresh.length} new hypotheses (room was ${room})`);
  return {
    hypotheses: [...existing, ...fresh],
    totalPromptTokens: promptTok,
    totalCompletionTokens: completionTok,
  };
}

/**
 * Pull a JSON array of hypotheses out of a model response. Tolerates the usual
 * offences — ```json fences, prose before the array, a trailing comma — because
 * the alternative is silently dropping a whole dimension of work.
 */
function parseHypothesisArray(text: string): HypothesisDraft[] | null {
  const withoutFences = text.replace(/```(?:json)?/gi, "");
  const start = withoutFences.indexOf("[");
  const end = withoutFences.lastIndexOf("]");
  if (start === -1 || end <= start) return null;

  const candidate = withoutFences.slice(start, end + 1);
  for (const attempt of [candidate, candidate.replace(/,\s*([\]}])/g, "$1")]) {
    try {
      const parsed = JSON.parse(attempt);
      if (Array.isArray(parsed)) return parsed as HypothesisDraft[];
    } catch {
      // try the next repair
    }
  }
  return null;
}

/** Severities the sandbox is allowed to return. Anything else is not a verdict. */
const SANDBOX_SEVERITIES = new Set<Severity>(["high", "warn", "ok"]);

/**
 * A hypothesis we could not test. Deliberately NOT `ok` — see the module header.
 * Counts are zeroed because we have no measurement, and the UI renders
 * `inconclusive` without a share bar rather than as a healthy 0%.
 */
function inconclusive(h: HypothesisDraft, why: string, evidence: Record<string, unknown> = {}): HypothesisResult {
  return {
    ...h,
    severity: "inconclusive",
    verdict_source: "none",
    finding_summary: why,
    affected_count: 0,
    total_count: 0,
    evidence: { ...evidence, notes: [why] },
    critique: "",
  };
}

/**
 * run_test — the only place a card's severity is decided.
 *
 * The agent authored `python_code`; we hand the sandbox real DataFrames and take
 * the deterministic verdict it computes. There is no LLM fallback: asking a
 * model to *state* an affected_count produces a number that looks exactly like a
 * measured one and is not. When we cannot execute, we say so.
 */
async function runTest(state: State): Promise<Partial<State>> {
  const results: HypothesisResult[] = [];

  // Probe the sandbox once per run rather than per-hypothesis.
  const sandboxOk = await sandboxHealthy();
  if (!sandboxOk) {
    console.warn(
      "[risk-graph] sandbox unavailable (NBFC_SANDBOX_URL) — all agent hypotheses this run are inconclusive",
    );
    return {
      results: state.hypotheses.map((h) =>
        inconclusive(
          h,
          "Not tested — the Python execution sandbox is unavailable, so no verdict was computed.",
        ),
      ),
    };
  }

  // Fetch the tenant data slice once — the same DataFrames are reused for
  // every sandbox call.
  //
  // This reads the IoT telemetry DB, which in dev is only reachable through the
  // `ssh -N iot-bastion` tunnel. When that is down the query throws
  // ECONNREFUSED, and an unguarded throw here used to abort the entire graph and
  // 500 the route. A missing telemetry feed is a coverage gap, not an engine
  // failure: the run completes and every agent hypothesis says it wasn't tested.
  let sandboxData: Record<string, unknown[]>;
  try {
    sandboxData = await fetchSandboxData(state.tenant);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[risk-graph] could not load telemetry for the sandbox: ${msg}`);
    return {
      results: state.hypotheses.map((h) =>
        inconclusive(
          h,
          "Not tested — the IoT telemetry database is unreachable, so there was no data to run the test against.",
          { error: msg },
        ),
      ),
    };
  }
  console.log("[risk-graph] sandbox OK — executing agent-authored Python");

  for (const h of state.hypotheses) {
    if (!h.python_code) {
      results.push(inconclusive(h, "Not tested — the agent proposed this hypothesis but emitted no test code."));
      continue;
    }
    try {
      const sb = await executeInSandbox({
        hypothesis_slug: h.slug,
        code: h.python_code,
        data: sandboxData,
      });

      if (sb.ok && sb.result && SANDBOX_SEVERITIES.has(sb.result.severity as Severity)) {
        results.push({
          ...h,
          severity: sb.result.severity as Severity,
          verdict_source: "sandbox",
          finding_summary: sb.result.finding_summary ?? "—",
          affected_count: Number(sb.result.affected_count ?? 0),
          total_count: Number(sb.result.total_count ?? 0),
          evidence: (sb.result.evidence as Record<string, unknown>) ?? {},
          critique: `python sandbox · ${sb.elapsed_ms}ms`,
        });
        continue;
      }

      if (sb.ok) {
        // Executed, but returned something that isn't a verdict we recognise.
        results.push(
          inconclusive(h, `Not tested — sandbox returned an unrecognised severity (${String(sb.result?.severity)}).`, {
            sandbox_result: sb.result,
          }),
        );
        continue;
      }

      // The agent's Python blew up. That is a defect in the generated test, not
      // a clean bill of health for the portfolio.
      results.push({
        ...h,
        severity: "error",
        verdict_source: "none",
        finding_summary: `Test failed to run: ${sb.error ?? "unknown sandbox error"}`,
        affected_count: 0,
        total_count: 0,
        evidence: { sandbox_error: sb.error, elapsed_ms: sb.elapsed_ms },
        critique: "The agent-generated Python raised inside the sandbox.",
      });
    } catch (e) {
      // Transport failure mid-run (sandbox died, timeout, network).
      results.push({
        ...h,
        severity: "error",
        verdict_source: "none",
        finding_summary: `Test failed to run: ${e instanceof Error ? e.message : String(e)}`,
        affected_count: 0,
        total_count: 0,
        evidence: { error: String(e) },
        critique: "Transport failure talking to the sandbox.",
      });
    }
  }

  return { results };
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

/**
 * An unpromoted agent-authored hypothesis may report a concern, but it may not
 * declare a crisis. Nobody has reviewed the question it asks or the code that
 * answers it; giving it the same authority as a hand-written, human-reviewed
 * evaluator is how "Ignition Status Risk — 7 of 7 affected" ends up in a credit
 * officer's High Alert queue.
 *
 * `high` is capped to `warn` until a human promotes the hypothesis (E-188).
 * Everything else passes through untouched.
 */
function capUnpromotedSeverity(
  severity: Severity,
  promoted: boolean,
): { severity: Severity; capped: boolean } {
  if (!promoted && severity === "high") return { severity: "warn", capped: true };
  return { severity, capped: false };
}

async function writeCards(state: State): Promise<Partial<State>> {
  for (const r of state.results) {
    let hypId: string;
    let promoted: boolean;

    if (r.id) {
      // Came from the catalogue — reuse it. No re-insert, no overwrite.
      hypId = r.id;
      promoted = r.promoted ?? false;
    } else {
      // Newly proposed. Persist the Python alongside the hypothesis so future
      // runs re-execute this exact test — previously the code was discarded and
      // the card could never be reproduced or audited.
      const inserted = await db
        .insert(riskHypotheses)
        .values({
          slug: r.slug,
          title: r.title,
          description: r.description,
          test_method: r.python_code ? "python" : "js",
          test_definition: {
            kind: "llm_generated",
            test_plan: r.test_plan,
            python_code: r.python_code ?? null,
          },
          source: "llm-v1",
        })
        .returning({ id: riskHypotheses.id });
      hypId = inserted[0]!.id;
      promoted = false; // new agent hypotheses start unvetted
    }

    const { severity, capped } = capUnpromotedSeverity(r.severity, promoted);
    const critique = capped
      ? `${r.critique} · Severity capped from HIGH to WARN: this hypothesis was written by the agent and has not been reviewed by a human.`.trim()
      : r.critique;

    await db.insert(riskCardRuns).values({
      tenant_id: state.tenantId,
      hypothesis_id: hypId,
      run_id: state.runId,
      severity,
      verdict_source: r.verdict_source,
      finding_summary: r.finding_summary,
      affected_count: r.affected_count,
      total_count: r.total_count,
      evidence_json: { ...r.evidence, severity_capped: capped || undefined },
      llm_critique: critique,
      llm_model: process.env.NBFC_OPENAI_MODEL || "gpt-4o-mini",
      llm_prompt_tokens: state.totalPromptTokens,
      llm_completion_tokens: state.totalCompletionTokens,
    });

    if (r.severity === "error" && r.id) {
      await retireIfPersistentlyBroken(r.id, r.slug);
    }
  }
  return {};
}

/**
 * Retire an agent hypothesis whose test keeps blowing up.
 *
 * A generated test that has errored on its last N runs is not a risk signal, it
 * is a bug — and left alone it would sit in the catalogue erroring forever,
 * consuming a sandbox slot every night. Retiring is soft: the row and its whole
 * card history stay, it is simply no longer executed or rendered.
 */
async function retireIfPersistentlyBroken(hypothesisId: string, slug: string): Promise<void> {
  const recent = await db
    .select({ severity: riskCardRuns.severity })
    .from(riskCardRuns)
    .where(eq(riskCardRuns.hypothesis_id, hypothesisId))
    .orderBy(desc(riskCardRuns.run_at))
    .limit(RETIRE_AFTER_CONSECUTIVE_ERRORS);

  if (
    recent.length < RETIRE_AFTER_CONSECUTIVE_ERRORS ||
    !recent.every((c) => c.severity === "error")
  ) {
    return;
  }

  await db
    .update(riskHypotheses)
    .set({
      retired_at: new Date(),
      retire_reason: `Test failed to run on ${RETIRE_AFTER_CONSECUTIVE_ERRORS} consecutive runs — the generated code is broken, not the portfolio.`,
    })
    .where(eq(riskHypotheses.id, hypothesisId));

  console.warn(`[risk-graph] retired hypothesis "${slug}" after ${RETIRE_AFTER_CONSECUTIVE_ERRORS} consecutive errors`);
}

/**
 * Run the hand-coded evaluators alongside the agent-generated ones, then
 * persist their results to risk_card_runs so the Risk page reads from a
 * single source.
 */
async function runHandCodedCards(state: State): Promise<Partial<State>> {
  const loans = await getTenantLoanSlice(state.tenantId);
  // Resolved once per run so every card in this run is judged by the same
  // thresholds, and snapshotted into each card's evidence_json.
  const thresholds = await loadRiskThresholds();
  const hyps = await db.select().from(riskHypotheses).where(eq(riskHypotheses.source, "human"));
  for (const h of hyps) {
    const evaluator = HAND_CODED_CARDS[h.slug];
    if (!evaluator) continue;
    try {
      const ev = await evaluator(loans, thresholds);
      await db.insert(riskCardRuns).values({
        tenant_id: state.tenantId,
        hypothesis_id: h.id,
        run_id: state.runId,
        severity: ev.severity,
        verdict_source: ev.verdict_source,
        finding_summary: ev.finding_summary,
        affected_count: ev.affected_count,
        total_count: ev.total_count,
        evidence_json: ev.evidence,
        llm_model: "hand-coded",
      });
    } catch (e) {
      // Evaluator threw — almost always the IoT DB being unreachable. Persist
      // the failure as `error` so the card stops claiming the portfolio is fine.
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[risk-graph] hand-coded evaluator ${h.slug} failed:`, msg);
      await db.insert(riskCardRuns).values({
        tenant_id: state.tenantId,
        hypothesis_id: h.id,
        run_id: state.runId,
        severity: "error",
        verdict_source: "none",
        finding_summary: `Test failed to run: ${msg}`,
        affected_count: 0,
        total_count: 0,
        evidence_json: { notes: [msg] },
        llm_model: "hand-coded",
      });
    }
  }
  return {};
}

// ─── Graph wiring ────────────────────────────────────────────────────────────

export function buildRiskGraph() {
  const graph = new StateGraph(GraphState)
    .addNode("run_hand_coded", runHandCodedCards)
    .addNode("load_catalogue", loadCatalogue)
    .addNode("plan_dimensions", planDimensions)
    .addNode("propose_hypotheses", proposeHypotheses)
    .addNode("run_test", runTest)
    .addNode("write_cards", writeCards);

  graph.addEdge(START, "run_hand_coded");
  // load_catalogue runs BEFORE planning: what we already have determines whether
  // we propose anything at all. At capacity, plan/propose become no-ops and the
  // run is a pure re-execution of the existing tests.
  graph.addEdge("run_hand_coded", "load_catalogue");
  graph.addEdge("load_catalogue", "plan_dimensions");
  graph.addEdge("plan_dimensions", "propose_hypotheses");
  graph.addEdge("propose_hypotheses", "run_test");
  graph.addEdge("run_test", "write_cards");
  graph.addEdge("write_cards", END);

  return graph.compile();
}

/**
 * Run the engine for one tenant.
 *
 * Takes the per-tenant lock first (E-187), so a double-clicked button or a cron
 * sweep overlapping a manual run cannot fire two workflows at the same tenant —
 * previously both ran, each wrote a full set of cards, and whichever finished
 * last silently shadowed the other.
 *
 * Throws RunInFlightError if a run is already in progress. The caller decides
 * whether that is a 409 (the button) or a skip (the cron).
 */
export async function runRiskWorkflow(
  tenant: TenantContext,
  opts: { trigger: RunTrigger; actorUserId?: string | null } = { trigger: "manual" },
) {
  const runId = await beginRiskRun(tenant.id, opts.trigger, opts.actorUserId);

  try {
    const compiled = buildRiskGraph();
    const result = await compiled.invoke({ tenantId: tenant.id, tenant, runId });
    const results = result.results ?? [];

    const summary = {
      cards_generated: results.length,
      // Surfaced so the caller can tell "we tested 6 hypotheses" from "we tested
      // none because the sandbox is down" — both used to report the same number.
      cards_computed: results.filter((r) => r.verdict_source === "sandbox").length,
      cards_inconclusive: results.filter((r) => r.severity === "inconclusive").length,
      cards_errored: results.filter((r) => r.severity === "error").length,
      prompt_tokens: result.totalPromptTokens ?? 0,
      completion_tokens: result.totalCompletionTokens ?? 0,
    };

    await completeRiskRun(runId, summary);
    return { run_id: runId, ...summary };
  } catch (e) {
    // Record the failure rather than leaving a 'running' row to be reaped —
    // a run that died deserves a reason attached to it.
    await failRiskRun(runId, e);
    throw e;
  }
}

/**
 * The security-scanner LangGraph agent.
 *
 * Pipeline:  plan_targets → run_probes → llm_triage → write_findings
 *
 * The LLM plans WHICH extra surfaces to probe (starting from dealer onboarding)
 * and narrates/dedups findings afterwards. It NEVER sets severity or invents a
 * finding — every finding comes from a deterministic probe, and severity is
 * fixed by the probe rule. If OPENAI_API_KEY is absent, plan/triage are no-ops
 * and the deterministic probe path still runs end-to-end.
 */
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import type { ProbeContext } from "../probe-context";
import { probesForMode } from "../probes";
import type { Probe } from "../probe-context";
import { unauthDataProbe } from "../probes/exposure";
import { get, looksLikeData, detectPii } from "../probes/util";
import { navigateAndInspect } from "./tools";
import { db } from "@/lib/db";
import { securityChecks } from "@/lib/db/schema";
import type { RawFinding } from "../types";
import type { ScanSummary } from "../scan-run";

export interface GraphDeps {
  ctx: ProbeContext;
  /** Persist enriched findings and return the run summary (counts). */
  persist: (findings: RawFinding[]) => Promise<ScanSummary>;
}

export interface GraphResult {
  summary: ScanSummary;
  promptTokens: number;
  completionTokens: number;
  extraTargets: string[];
}

const S = Annotation.Root({
  extraTargets: Annotation<string[]>({ reducer: (_, b) => b, default: () => [] }),
  raw: Annotation<RawFinding[]>({ reducer: (_, b) => b, default: () => [] }),
  enriched: Annotation<RawFinding[]>({ reducer: (_, b) => b, default: () => [] }),
  summary: Annotation<ScanSummary | null>({ reducer: (_, b) => b, default: () => null }),
  promptTokens: Annotation<number>({ reducer: (a, b) => (a ?? 0) + (b ?? 0), default: () => 0 }),
  completionTokens: Annotation<number>({ reducer: (a, b) => (a ?? 0) + (b ?? 0), default: () => 0 }),
});
type State = typeof S.State;

function makeModel(): ChatOpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;
  return new ChatOpenAI({
    openAIApiKey: process.env.OPENAI_API_KEY,
    modelName: process.env.SECURITY_OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.2,
  });
}

export const LLM_MODEL_NAME = process.env.SECURITY_OPENAI_MODEL || "gpt-4o-mini";

function buildGraph({ ctx, persist }: GraphDeps) {
  const model = makeModel();

  // ── plan_targets ──────────────────────────────────────────────────────────
  async function planTargets(): Promise<Partial<State>> {
    if (!model) {
      ctx.log("plan_targets: no LLM — using curated surfaces only");
      return {};
    }
    try {
      // Look at the dealer-onboarding entry point to ground the suggestions.
      const page = await navigateAndInspect(ctx, "/dealer-onboarding");
      const prompt = `You are a web application security tester scanning an internal CRM.
Starting point: the dealer-onboarding page. Observed links: ${JSON.stringify(page.links)}.
Observed form actions: ${JSON.stringify(page.forms)}.
Propose up to 8 additional app-relative API paths (starting with /api/) that are worth
testing for missing authentication or IDOR, based on these links/forms and typical CRM
patterns (documents, kyc, leads, uploads). Return ONLY a JSON array of path strings.`;
      const res = await model.invoke(prompt);
      const usage = res.usage_metadata;
      const text = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
      const paths = parsePathArray(text).slice(0, 8);
      ctx.log(`plan_targets: proposed ${paths.length} extra target(s)`);
      return {
        extraTargets: paths,
        promptTokens: usage?.input_tokens ?? 0,
        completionTokens: usage?.output_tokens ?? 0,
      };
    } catch (e) {
      ctx.log(`plan_targets failed: ${(e as Error).message}`);
      return {};
    }
  }

  // ── run_probes ──────────────────────────────────────────────────────────────
  async function runProbes(state: State): Promise<Partial<State>> {
    const probes = probesForMode(ctx.mode);
    await seedCatalogue(probes);
    const raw: RawFinding[] = [];

    for (const probe of probes) {
      try {
        const found = await probe.run(ctx);
        ctx.log(`probe ${probe.slug}: ${found.length} finding(s)`);
        raw.push(...found);
      } catch (e) {
        ctx.log(`probe ${probe.slug} errored: ${(e as Error).message}`);
      }
    }

    // Sweep the LLM-proposed extra targets for unauthenticated data exposure.
    for (const path of state.extraTargets) {
      try {
        const f = await get(ctx.anon, ctx.baseUrl, path);
        if (!looksLikeData(f)) continue;
        const pii = detectPii(f.body);
        raw.push({
          check_slug: unauthDataProbe.slug,
          category: "exposure",
          severity: pii.length ? "critical" : "medium",
          confidence: "confirmed",
          title: pii.length
            ? `Unauthenticated PII exposure at ${path} (agent-discovered)`
            : `Unauthenticated data exposure at ${path} (agent-discovered)`,
          summary: `The agent proposed ${path}; it returned records to a request with no session${
            pii.length ? `, including ${pii.join(", ")}.` : "."
          }`,
          target_url: path,
          http_method: "GET",
          evidence: { status: f.status, pii, discoveredBy: "agent", bodySnippet: f.body.slice(0, 400) },
          reproduction: `curl -s ${ctx.baseUrl}${path} (no auth) → ${f.status} with data.`,
          remediation: "Add a server-side auth/role check at the top of this route handler.",
          owasp_ref: "A01:2021",
          cwe_ref: pii.length ? "CWE-359" : "CWE-306",
        });
      } catch {
        /* ignore extra-target errors */
      }
    }

    return { raw };
  }

  // ── llm_triage ────────────────────────────────────────────────────────────
  async function llmTriage(state: State): Promise<Partial<State>> {
    if (!model || state.raw.length === 0) {
      return { enriched: state.raw };
    }
    try {
      const compact = state.raw.map((f, i) => ({
        i,
        slug: f.check_slug,
        title: f.title,
        url: f.target_url,
        summary: f.summary.slice(0, 300),
      }));
      const prompt = `You are triaging automated web-security findings. For each finding, you MAY
improve the wording and add references, but you MUST NOT change or invent severity.
Return ONLY a JSON array where each item is:
{ "i": <index>, "drop": <true if this is a duplicate of an earlier finding>,
  "remediation": <one concise sentence or null>, "owasp_ref": <e.g. "A01:2021" or null>,
  "cwe_ref": <e.g. "CWE-306" or null>, "confidence": <"confirmed"|"likely"|"possible"|null> }
Findings: ${JSON.stringify(compact)}`;
      const res = await model.invoke(prompt);
      const usage = res.usage_metadata;
      const text = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
      const edits = parseTriage(text);

      const enriched: RawFinding[] = [];
      for (let i = 0; i < state.raw.length; i++) {
        const e = edits.get(i);
        if (e?.drop) continue;
        const f = { ...state.raw[i] };
        // Severity is intentionally NOT read from the model.
        if (e?.remediation) f.remediation = e.remediation;
        if (e?.owasp_ref) f.owasp_ref = e.owasp_ref;
        if (e?.cwe_ref) f.cwe_ref = e.cwe_ref;
        if (e?.confidence) f.confidence = e.confidence;
        enriched.push(f);
      }
      ctx.log(`llm_triage: ${state.raw.length} → ${enriched.length} after dedup`);
      return {
        enriched,
        promptTokens: usage?.input_tokens ?? 0,
        completionTokens: usage?.output_tokens ?? 0,
      };
    } catch (e) {
      ctx.log(`llm_triage failed, keeping raw: ${(e as Error).message}`);
      return { enriched: state.raw };
    }
  }

  // ── write_findings ──────────────────────────────────────────────────────────
  async function writeFindings(state: State): Promise<Partial<State>> {
    const summary = await persist(state.enriched);
    return { summary };
  }

  return new StateGraph(S)
    .addNode("plan_targets", planTargets)
    .addNode("run_probes", runProbes)
    .addNode("llm_triage", llmTriage)
    .addNode("write_findings", writeFindings)
    .addEdge(START, "plan_targets")
    .addEdge("plan_targets", "run_probes")
    .addEdge("run_probes", "llm_triage")
    .addEdge("llm_triage", "write_findings")
    .addEdge("write_findings", END)
    .compile();
}

export async function runSecurityGraph(deps: GraphDeps): Promise<GraphResult> {
  const graph = buildGraph(deps);
  const final = (await graph.invoke({})) as State;
  return {
    summary: final.summary ?? emptySummary(),
    promptTokens: final.promptTokens ?? 0,
    completionTokens: final.completionTokens ?? 0,
    extraTargets: final.extraTargets ?? [],
  };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

async function seedCatalogue(probes: Probe[]): Promise<void> {
  for (const p of probes) {
    await db
      .insert(securityChecks)
      .values({
        slug: p.slug,
        category: p.category,
        title: p.title,
        description: p.description,
        default_severity: p.default_severity,
        mutating: p.mutating,
        owasp_ref: p.owasp_ref ?? null,
        cwe_ref: p.cwe_ref ?? null,
      })
      .onConflictDoUpdate({
        target: securityChecks.slug,
        set: {
          category: p.category,
          title: p.title,
          description: p.description,
          default_severity: p.default_severity,
          mutating: p.mutating,
          owasp_ref: p.owasp_ref ?? null,
          cwe_ref: p.cwe_ref ?? null,
        },
      });
  }
}

function parsePathArray(text: string): string[] {
  try {
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return [];
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string" && x.startsWith("/api/")) : [];
  } catch {
    return [];
  }
}

interface TriageEdit {
  drop?: boolean;
  remediation?: string;
  owasp_ref?: string;
  cwe_ref?: string;
  confidence?: RawFinding["confidence"];
}
function parseTriage(text: string): Map<number, TriageEdit> {
  const out = new Map<number, TriageEdit>();
  try {
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return out;
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return out;
    for (const item of arr) {
      if (typeof item?.i !== "number") continue;
      const conf = ["confirmed", "likely", "possible"].includes(item.confidence) ? item.confidence : undefined;
      out.set(item.i, {
        drop: item.drop === true,
        remediation: typeof item.remediation === "string" ? item.remediation : undefined,
        owasp_ref: typeof item.owasp_ref === "string" ? item.owasp_ref : undefined,
        cwe_ref: typeof item.cwe_ref === "string" ? item.cwe_ref : undefined,
        confidence: conf,
      });
    }
  } catch {
    /* keep raw */
  }
  return out;
}

function emptySummary(): ScanSummary {
  return {
    surfaces_walked: 0,
    findings_total: 0,
    findings_critical: 0,
    findings_high: 0,
    findings_medium: 0,
    findings_low: 0,
    findings_info: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
  };
}

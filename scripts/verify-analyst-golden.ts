// AI Analyst golden suite — run before every release (item 2).
//
//   npm run analyst:golden                         all 20 questions
//   npm run analyst:golden -- --only G01,G15       some of them
//   npm run analyst:golden -- --reference-only     just run the reference SQL (no agent budget)
//
// (= node --import tsx --env-file=.env.local scripts/verify-analyst-golden.ts)
//
// For each question in src/lib/analyst/goldenQuestions.ts: runs the reference SQL on the
// analyst's own read-only login (ANALYST_CRM_READONLY_DSN — so it reads exactly what the agent
// can), asks the agent the question on the iTarang database source (same metric rules the CRM
// sends, src/lib/analyst/metricRules.ts), and passes when every reference figure appears in the
// agent's result or answer (src/lib/analyst/golden.ts). Prints a table, writes
// reports/analyst-golden-<date>.json, exits 1 on any failure.
//
// Read-only on the database. Spends agent budget (one run per question). Its conversations use
// thread ids crm.golden.<uuid>, which no CRM user's list ever shows.

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

import postgres from "postgres";

import { checkGolden } from "../src/lib/analyst/golden";
import { GOLDEN_CASES, type GoldenCase } from "../src/lib/analyst/goldenQuestions";
import { metricInstructions } from "../src/lib/analyst/metricRules";
import type { Connection } from "../src/lib/analyst/types";

import { agentAsk, agentGet, analystEnvMissing } from "./_analyst-agent";

const CRM_SOURCE_NAME = "iTarang CRM";
const CONCURRENCY = 2;

type Result = {
  id: string;
  question: string;
  expected: { label: string; n: number }[];
  pass: boolean;
  /** Not asked: the agent's daily budget ran out first. */
  skipped: boolean;
  weak: boolean;
  missing: number[];
  agentSql: string | null;
  agentRows: number;
  answer: string;
  error: string | null;
  ms: number;
};

function args() {
  const argv = process.argv.slice(2);
  const onlyAt = argv.indexOf("--only");
  const only = onlyAt >= 0 ? new Set(argv[onlyAt + 1]?.split(",").map((s) => s.trim().toUpperCase())) : null;
  return { only, referenceOnly: argv.includes("--reference-only") };
}

async function pool<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await work(items[i]);
      }
    }),
  );
  return out;
}

async function main() {
  const { only, referenceOnly } = args();
  const dsn = process.env.ANALYST_CRM_READONLY_DSN?.trim();
  if (!dsn) throw new Error("ANALYST_CRM_READONLY_DSN is not set");
  if (!referenceOnly && analystEnvMissing().length) throw new Error(`missing ${analystEnvMissing().join(", ")}`);

  const cases = GOLDEN_CASES.filter((c) => !only || only.has(c.id));
  const db = postgres(dsn, { max: 2, prepare: false, ssl: { rejectUnauthorized: false } });

  try {
    const [who] = await db`SELECT current_user AS u`;
    if (who.u !== "analyst_ro") throw new Error(`reference login is ${who.u}, not analyst_ro — refusing`);

    // 1. Reference figures.
    const expected = new Map<string, { label: string; n: number }[]>();
    let refFailed = 0;
    for (const c of cases) {
      try {
        const rows = await db.unsafe<{ label: string; n: number | string }[]>(c.sql);
        expected.set(c.id, rows.map((r) => ({ label: String(r.label), n: Number(r.n) })));
      } catch (error) {
        refFailed++;
        console.log(`${c.id} REFERENCE SQL FAILED: ${error instanceof Error ? error.message : error}`);
      }
    }
    if (referenceOnly) {
      for (const c of cases) {
        const e = expected.get(c.id);
        if (e) console.log(`${c.id}  ${c.question}\n      ${e.map((x) => `${x.label}=${x.n}`).join(", ") || "(no rows)"}`);
      }
      console.log(`\n${cases.length - refFailed}/${cases.length} reference queries ran`);
      process.exit(refFailed ? 1 : 0);
    }

    // 2. The agent, on the iTarang database source.
    const sources = await agentGet<Connection[]>("/connections");
    const crm = sources.find((s) => s.name === CRM_SOURCE_NAME);
    if (!crm) throw new Error(`no "${CRM_SOURCE_NAME}" source on this agent tenant`);

    // Once the agent says its daily budget is spent, the rest are not asked (they would all
    // "fail" on a 429 and say nothing about the answers).
    let budgetGone = false;
    const results = await pool(cases, CONCURRENCY, async (c: GoldenCase): Promise<Result> => {
      const exp = expected.get(c.id);
      const base = { id: c.id, question: c.question, expected: exp ?? [] };
      const empty = { missing: [], agentSql: null, agentRows: 0, answer: "", ms: 0 };
      if (!exp) return { ...base, ...empty, pass: false, skipped: false, weak: false, error: "reference SQL failed" };
      if (budgetGone) return { ...base, ...empty, pass: false, skipped: true, weak: false, error: "not asked: agent budget spent" };
      const asked = await agentAsk({
        connectionId: crm.id,
        threadId: `crm.golden.${randomUUID()}`,
        question: c.question,
        instructions: metricInstructions(c.question),
      });
      if (asked.error?.startsWith("HTTP 429")) {
        budgetGone = true;
        console.log(`SKIP ${c.id} the agent refused: ${asked.error}`);
        return { ...base, ...empty, pass: false, skipped: true, weak: false, error: asked.error };
      }
      const verdict = checkGolden(exp.map((e) => e.n), asked.rows, asked.answer, c.tolerance ?? 0);
      const r: Result = {
        ...base,
        pass: !asked.error && verdict.pass,
        skipped: false,
        weak: verdict.weak,
        missing: verdict.missing,
        agentSql: asked.sql,
        agentRows: asked.rows.length,
        answer: asked.answer,
        error: asked.error,
        ms: asked.ms,
      };
      console.log(
        `${r.pass ? "PASS" : "FAIL"} ${c.id} ${(r.ms / 1000).toFixed(0).padStart(3)}s  ${c.question}` +
          (r.pass ? "" : `\n         expected ${exp.map((e) => `${e.label}=${e.n}`).join(", ")}; missing ${r.missing.join(", ") || "-"}${r.error ? `; error: ${r.error}` : ""}`),
      );
      return r;
    });

    const passed = results.filter((r) => r.pass).length;
    const skipped = results.filter((r) => r.skipped).map((r) => r.id);
    const weak = results.filter((r) => r.weak).map((r) => r.id);
    console.log(`\n${passed}/${results.length} passed, ${results.length - passed - skipped.length} failed, ${skipped.length} not asked`);
    if (skipped.length) {
      console.log(`NOT ASKED (agent's daily budget spent; re-run later with --only ${skipped.join(",")})`);
    }
    if (weak.length) console.log(`weak (reference is 0 or empty, a pass proves little): ${weak.join(", ")}`);

    mkdirSync("reports", { recursive: true });
    const file = `reports/analyst-golden-${new Date().toISOString().slice(0, 10)}.json`;
    writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), passed, skipped, total: results.length, results }, null, 2));
    console.log(`report: ${file}`);
    process.exit(passed === results.length ? 0 : 1);
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

// Read-only: the distinct questions asked on this environment's AI Analyst tenant, most asked
// first, with how often — the pool the golden suite (src/lib/analyst/goldenQuestions.ts) is
// drawn from. Prints questions only (no answers, no user ids).
//
//   node --import tsx --env-file=.env.local scripts/_list-analyst-questions.ts
import { agentGet as agentJson, analystEnvMissing } from "./_analyst-agent";
import { stripMetricRules } from "../src/lib/analyst/metricRules";
import type { RunPage, Thread } from "../src/lib/analyst/types";

async function main() {
  if (analystEnvMissing().length) throw new Error(`missing ${analystEnvMissing().join(", ")}`);
  const threads = await agentJson<Thread[]>("/runs/threads?limit=200");
  const counts = new Map<string, { q: string; n: number }>();
  for (const t of threads.filter((t) => t.thread_id.startsWith("crm.") && !t.thread_id.startsWith("crm.golden."))) {
    const page = await agentJson<RunPage>(`/runs?limit=50&thread_id=${encodeURIComponent(t.thread_id)}`);
    for (const r of page.items) {
      if (r.status !== "done") continue;
      const q = stripMetricRules(r.question).replace(/\s+/g, " ").trim();
      const key = q.toLowerCase().replace(/[^a-z0-9 ]/g, "");
      const c = counts.get(key);
      if (c) c.n++;
      else counts.set(key, { q, n: 1 });
    }
  }
  const sorted = [...counts.values()].sort((a, b) => b.n - a.n);
  console.log(`${threads.length} threads, ${sorted.length} distinct answered questions`);
  for (const { q, n } of sorted) console.log(`${String(n).padStart(3)}  ${q}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

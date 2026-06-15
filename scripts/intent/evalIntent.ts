// Benchmark the intent scorer against the golden set (human corrections).
//
//   npm run eval:intent                 # rubric eval only (fast, no LLM)
//   RUN_GOLDEN=1 npm run eval:intent     # also re-run extraction (needs OPENAI_API_KEY)
//
// Rubric eval     — given each case's ground-truth signals, does the deterministic
//                   scorer map them to the human's label? Isolates RUBRIC error
//                   (Lever B). No LLM, so it's instant.
// Extraction eval — re-run the LLM on the transcript, compare predicted signal
//                   levels to the human's corrected signals (per-signal confusion)
//                   AND the resulting label. Isolates EXTRACTION error (Lever A) —
//                   this is where the "65" over-read shows up.
//
// Writes docs/ai intent/eval/report.{json,html} and prints a summary. Exits
// non-zero if rubric accuracy is below EVAL_MIN_ACCURACY (default 0.8) so it can
// gate a weights/prompt change in CI.

import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { computeBand, bandToStatus, type IntentSignals } from "@/lib/ai/scoring";
import { extractSignals } from "@/lib/ai/analysis/parser";
import {
  readGolden,
  truthSignals,
  signalLevel,
  confusionMatrix,
  accuracy,
  LEAD_STATUSES,
  LEVELED_KEYS,
  type GoldenCase,
} from "./_lib";

const MIN_ACCURACY = Number(process.env.EVAL_MIN_ACCURACY ?? "0.8");
const RUN_EXTRACTION = process.env.RUN_GOLDEN === "1" && !!process.env.OPENAI_API_KEY;

function predict(signals: IntentSignals): { score: number; label: string } {
  const r = computeBand(signals);
  // dropped_empty has no band — treat as disqualified for label-accuracy purposes.
  return { score: r.lead_score, label: bandToStatus(r.band) ?? "disqualified" };
}

interface Report {
  generatedAt: string;
  total: number;
  rubric: {
    evaluated: number;
    accuracy: number;
    scoreMae: number | null;
    confusion: string[];
    misses: Array<{ callId: string; truth: string; pred: string; score: number }>;
    bySource: Array<{ source: string; evaluated: number; accuracy: number; scoreMae: number | null }>;
  };
  extraction: null | {
    evaluated: number;
    labelAccuracy: number;
    perSignal: Array<{ signal: string; accuracy: number; confusion: string[] }>;
    failures: string[];
  };
}

async function main() {
  const cases = await readGolden();
  if (cases.length === 0) {
    console.log("Golden set is empty — submit corrections, then run intent:export-golden.");
    process.exit(0);
  }

  // ── Rubric eval ────────────────────────────────────────────────────────────
  const rubricPairs: Array<{ truth: string; pred: string }> = [];
  const rubricMisses: Report["rubric"]["misses"] = [];
  const maeParts: number[] = [];
  // Per-source tallies (sandbox vs prod) — prod quality is what ships.
  const srcPairs: Record<string, Array<{ truth: string; pred: string }>> = {};
  const srcMae: Record<string, number[]> = {};
  for (const c of cases) {
    const sig = truthSignals(c);
    if (!sig) continue;
    const { score, label } = predict(sig);
    rubricPairs.push({ truth: c.label, pred: label });
    if (label !== c.label) rubricMisses.push({ callId: c.callId, truth: c.label, pred: label, score });
    if (c.correctedScore != null) maeParts.push(Math.abs(score - c.correctedScore));
    const src = c.source ?? "unknown";
    (srcPairs[src] ??= []).push({ truth: c.label, pred: label });
    if (c.correctedScore != null) (srcMae[src] ??= []).push(Math.abs(score - c.correctedScore));
  }
  const rubricAcc = accuracy(rubricPairs);
  const scoreMae =
    maeParts.length > 0 ? maeParts.reduce((a, b) => a + b, 0) / maeParts.length : null;
  const bySource = Object.keys(srcPairs)
    .sort()
    .map((source) => ({
      source,
      evaluated: srcPairs[source].length,
      accuracy: accuracy(srcPairs[source]),
      scoreMae:
        (srcMae[source]?.length ?? 0) > 0
          ? srcMae[source].reduce((a, b) => a + b, 0) / srcMae[source].length
          : null,
    }));

  // ── Extraction eval (optional) ─────────────────────────────────────────────
  let extraction: Report["extraction"] = null;
  if (RUN_EXTRACTION) {
    const labelPairs: Array<{ truth: string; pred: string }> = [];
    const perSignalPairs: Record<string, Array<{ truth: string; pred: string }>> = {};
    for (const k of LEVELED_KEYS) perSignalPairs[k] = [];
    const failures: string[] = [];

    const withTranscript = cases.filter((c) => c.transcript && c.transcript.trim());
    for (const c of withTranscript) {
      const res = await extractSignals(c.transcript as string);
      if (res.status !== "ok") {
        failures.push(`${c.callId}: extraction ${res.reason}`);
        continue;
      }
      const pred = res.signals;
      labelPairs.push({ truth: c.label, pred: predict(pred).label });
      const truth = truthSignals(c);
      for (const k of LEVELED_KEYS) {
        perSignalPairs[k].push({ truth: signalLevel(truth, k), pred: signalLevel(pred, k) });
      }
    }

    extraction = {
      evaluated: labelPairs.length,
      labelAccuracy: accuracy(labelPairs),
      perSignal: LEVELED_KEYS.map((k) => ({
        signal: k,
        accuracy: accuracy(perSignalPairs[k]),
        confusion: confusionMatrix(
          perSignalPairs[k],
          Array.from(new Set(perSignalPairs[k].flatMap((p) => [p.truth, p.pred]))).sort(),
        ),
      })),
      failures,
    };
  }

  const report: Report = {
    generatedAt: new Date().toISOString(),
    total: cases.length,
    rubric: {
      evaluated: rubricPairs.length,
      accuracy: rubricAcc,
      scoreMae,
      confusion: confusionMatrix(rubricPairs, LEAD_STATUSES),
      misses: rubricMisses,
      bySource,
    },
    extraction,
  };

  // ── Print ──────────────────────────────────────────────────────────────────
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  console.log(`\nIntent eval — ${cases.length} golden case(s)\n`);
  console.log(`RUBRIC (given correct signals → correct label?)`);
  console.log(`  cases:    ${report.rubric.evaluated}`);
  console.log(`  accuracy: ${pct(rubricAcc)}`);
  console.log(`  score MAE: ${scoreMae == null ? "n/a" : scoreMae.toFixed(1)}`);
  if (bySource.length > 1) {
    console.log(`  by source:`);
    for (const s of bySource)
      console.log(
        `    ${s.source.padEnd(8)} ${pct(s.accuracy)}  (${s.evaluated} cases, MAE ${s.scoreMae == null ? "n/a" : s.scoreMae.toFixed(1)})`,
      );
  }
  console.log(report.rubric.confusion.map((l) => "  " + l).join("\n"));
  if (rubricMisses.length) {
    console.log(`  misses:`);
    for (const m of rubricMisses)
      console.log(`    ${m.callId}  truth=${m.truth} pred=${m.pred} (score ${m.score})`);
  }
  if (extraction) {
    console.log(`\nEXTRACTION (re-run LLM on transcript)`);
    console.log(`  cases:          ${extraction.evaluated}`);
    console.log(`  label accuracy: ${pct(extraction.labelAccuracy)}`);
    console.log(`  per-signal accuracy (where the LLM over/under-reads):`);
    for (const s of extraction.perSignal)
      console.log(`    ${s.signal.padEnd(18)} ${pct(s.accuracy)}`);
    if (extraction.failures.length)
      console.log(`  failures:\n${extraction.failures.map((f) => "    " + f).join("\n")}`);
  } else {
    console.log(`\nEXTRACTION eval skipped (set RUN_GOLDEN=1 + OPENAI_API_KEY to enable).`);
  }

  // ── Write report ─────────────────────────────────────────────────────────────
  const outDir = path.resolve(process.cwd(), "docs/ai intent/eval");
  if (!existsSync(outDir)) await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  await writeFile(path.join(outDir, "report.html"), renderHtml(report), "utf8");
  console.log(`\nReport → ${path.join(outDir, "report.html")}`);

  if (rubricAcc < MIN_ACCURACY) {
    console.error(
      `\n✗ Rubric accuracy ${pct(rubricAcc)} < gate ${pct(MIN_ACCURACY)} — regression.`,
    );
    process.exit(1);
  }
  console.log(`\n✓ Rubric accuracy ${pct(rubricAcc)} ≥ gate ${pct(MIN_ACCURACY)}.`);
  process.exit(0);
}

function renderHtml(r: Report): string {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const pre = (lines: string[]) => `<pre>${esc(lines.join("\n"))}</pre>`;
  const extractionBlock = r.extraction
    ? `<h2>Extraction (LLM re-run)</h2>
       <p>Cases: ${r.extraction.evaluated} · Label accuracy: <b>${pct(r.extraction.labelAccuracy)}</b></p>
       <table><tr><th>Signal</th><th>Accuracy</th></tr>
       ${r.extraction.perSignal.map((s) => `<tr><td>${s.signal}</td><td>${pct(s.accuracy)}</td></tr>`).join("")}
       </table>`
    : `<p><i>Extraction eval skipped (RUN_GOLDEN=1 + OPENAI_API_KEY to enable).</i></p>`;
  const bySourceBlock =
    r.rubric.bySource.length > 1
      ? `<h3>By source (sandbox vs prod)</h3>
         <table><tr><th>Source</th><th>Cases</th><th>Accuracy</th><th>Score MAE</th></tr>
         ${r.rubric.bySource
           .map(
             (s) =>
               `<tr><td>${esc(s.source)}</td><td>${s.evaluated}</td><td>${pct(s.accuracy)}</td><td>${s.scoreMae == null ? "n/a" : s.scoreMae.toFixed(1)}</td></tr>`,
           )
           .join("")}
         </table>`
      : "";
  return `<!doctype html><meta charset="utf-8"><title>Intent eval</title>
<style>body{font:14px/1.5 system-ui;margin:40px;max-width:900px}pre{background:#f6f8fa;padding:12px;border-radius:8px;overflow:auto}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:4px 10px;text-align:left}h1,h2{font-weight:700}</style>
<h1>Intent scoring eval</h1>
<p>Generated ${esc(r.generatedAt)} · ${r.total} golden case(s)</p>
<h2>Rubric (correct signals → correct label?)</h2>
<p>Cases: ${r.rubric.evaluated} · Accuracy: <b>${pct(r.rubric.accuracy)}</b> · Score MAE: ${r.rubric.scoreMae == null ? "n/a" : r.rubric.scoreMae.toFixed(1)}</p>
${bySourceBlock}
${pre(r.rubric.confusion)}
${r.rubric.misses.length ? `<h3>Misses</h3>${pre(r.rubric.misses.map((m) => `${m.callId}  truth=${m.truth} pred=${m.pred} (score ${m.score})`))}` : ""}
${extractionBlock}`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

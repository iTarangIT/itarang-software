
import { readFileSync } from "node:fs";
import { analyzeTranscript } from "@/lib/ai/analysis";

const DEFAULT_TRANSCRIPT = [
  "agent: नमस्ते sir! Priya बोल रही हूँ iTarang Technologies से। हम Trontek lithium-ion batteries supply करते हैं और driver के लिए financing भी setup करते हैं। क्या अभी दो minute बात हो सकती है?",
  "user: अभी bike चला रहा हूँ।",
  "agent: कोई बात नहीं sir, आप आराम से drive कीजिये। बाद में connect कर लूँगी। आपका दिन शुभ हो।",
].join("\n");

function divider(title: string) {
  console.log(`\n${"─".repeat(64)}\n${title}\n${"─".repeat(64)}`);
}

async function main() {
  const file = process.argv[2];
  const transcript = file ? readFileSync(file, "utf8") : DEFAULT_TRANSCRIPT;

  if (!process.env.OPENAI_API_KEY) {
    console.error("✗ OPENAI_API_KEY not set. Run with: --env-file=.env.local");
    process.exit(1);
  }

  divider(file ? `TRANSCRIPT (${file})` : "TRANSCRIPT (built-in Mishra brush-off)");
  console.log(transcript);

  const result = await analyzeTranscript(transcript);

  if (result.status === "failed") {
    divider("RESULT: needs_review");
    console.log(`The call could not be scored — reason: ${result.reason}`);
    console.log("In production the lead is flagged needs_review and the prior");
    console.log("final_intent_score is kept intact (never zeroed).");
    return;
  }

  divider("EXTRACTED SIGNALS (LLM — evidence only, no score)");
  const s = result.signals;
  const row = (k: string, level: string, evidence: string) =>
    console.log(`  ${k.padEnd(20)} ${level.padEnd(16)} ${evidence}`);
  row("budget", s.budget.level, s.budget.evidence);
  row("authority", s.authority.level, s.authority.evidence);
  row("need", s.need.level, s.need.evidence);
  row("timeline", s.timeline.level, s.timeline.evidence);
  row("engagement", s.engagement.level, s.engagement.evidence);
  row("curiosity", s.curiosity.level, s.curiosity.evidence);
  row("objection_quality", s.objection_quality.level, s.objection_quality.evidence);
  console.log(`  facts:     ${JSON.stringify(s.facts)}`);
  console.log(`  negatives: ${JSON.stringify(s.negatives)}`);
  console.log(`  language:  ${s.language}`);
  console.log(`  summary:   ${s.call_summary}`);

  divider("SCORE BREAKDOWN (deterministic — must SUM to the score)");
  let running = 0;
  for (const c of result.score_breakdown) {
    running += c.contribution;
    const pts = `${c.contribution >= 0 ? "+" : ""}${c.contribution}`.padStart(5);
    console.log(`  ${pts}  ${c.label.padEnd(28)} ${c.evidence}`);
  }
  const sum = result.score_breakdown.reduce((a, c) => a + c.contribution, 0);
  console.log(`  ${"".padStart(5)}  ${"—".repeat(28)}`);
  console.log(`  ${`${sum}`.padStart(5)}  TOTAL (Σ breakdown)`);

  divider("VERDICT");
  console.log(`  intent_score   : ${result.intent_score}`);
  console.log(`  Σ breakdown    : ${sum}   ${sum === result.intent_score ? "✓ matches" : "✗ MISMATCH"}`);
  console.log(`  qualified_gate : ${result.qualified_gate}`);
  console.log(`  status         : ${result.route.status}`);
  console.log(`  next action    : ${result.route.action}`);
  console.log(`  outcome        : ${result.outcome}`);
  console.log(`  scoring_version: ${result.scoring_version}`);
  console.log(`  callback_time  : ${result.callback_time ?? "none"}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


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

  divider("EXTRACTED SIGNALS (LLM — yes/no facts only, no band)");
  const s = result.signals;
  const row = (k: string, val: string, evidence: string) =>
    console.log(`  ${k.padEnd(28)} ${val.padEnd(6)} ${evidence}`);
  const ev = s.evidence;
  row("relevant_dealer", s.relevant_dealer, ev.relevant_dealer);
  row("battery_spec_shared", s.battery_spec_shared, ev.battery_spec_shared);
  row("volume_shared", s.volume_shared, ev.volume_shared);
  row("existing_financier_shared", s.existing_financier_shared, ev.existing_financier_shared);
  row("financing_need_expressed", s.financing_need_expressed, ev.financing_need_expressed);
  row("financing_value_acknowledged", s.financing_value_acknowledged, ev.financing_value_acknowledged);
  row("pitch_heard", s.pitch_heard, "");
  row("callback_agreed", s.callback_agreed, ev.callback_agreed);
  console.log(`  dealer_segment : ${s.dealer_segment} · dealer_role : ${s.dealer_role}`);
  console.log(`  disqualifier   : ${s.disqualifier}`);
  console.log(`  language       : ${s.language}`);
  console.log(`  summary        : ${s.call_summary}`);

  divider("QUALIFICATION SIGNALS (yes/no checklist)");
  for (const c of result.score_breakdown) {
    const mark = c.present ? "✓" : "✗";
    const info = c.info ? "[info]" : "      ";
    console.log(`  ${mark} ${info} ${c.label.padEnd(28)} ${c.evidence}`);
  }

  divider("VERDICT");
  console.log(`  band               : ${result.band ?? "— (dropped_empty)"}`);
  console.log(`  call_status        : ${result.call_status}`);
  console.log(`  info_signals_count : ${result.info_signals_count}/5`);
  console.log(`  lead_score         : ${result.intent_score}`);
  console.log(`  interest_level     : ${result.interest_level ?? "—"}`);
  console.log(`  next action        : ${result.action}`);
  console.log(`  outcome            : ${result.outcome}`);
  console.log(`  scoring_version    : ${result.scoring_version}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

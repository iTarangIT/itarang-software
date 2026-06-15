// (A) EXTRACTION — the LLM's ONLY job. It reads the transcript and returns
// FACTUAL yes/no SIGNALS WITH EVIDENCE (signals.ts). It must NOT score and must
// NOT band — the band lives in the deterministic engine (computeBand.ts). This
// keeps the band reproducible and auditable: change the prompt and the *signals*
// may shift, but the band → signal mapping stays fixed and inspectable.
// (Spec: docs/intent_docs/intent_score.pdf §2.)

import {
  QualificationSignalsSchema,
  type QualificationSignals,
  DEALER_SEGMENTS,
  DEALER_ROLES,
  DISQUALIFIERS,
} from "@/lib/ai/scoring";
import { renderCalibrationExamples } from "./calibrationExamples";

export type ExtractionResult =
  | { status: "ok"; signals: QualificationSignals }
  | { status: "failed"; reason: string };

function cleanJSON(text: string) {
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : "";
}

function buildPrompt(transcript: string, now: string): string {
  return `You are analysing a transcript of an outbound sales call between iTarang's
AI agent ("Priya") and a battery dealer. The agent pitched EV / lithium-ion
batteries and an EMI financing scheme to e-rickshaw / EV battery dealers across
India.

CURRENT TIME (Asia/Kolkata): ${now}

CONVERSATION (agent + dealer; Hindi / English / Hinglish, may contain
speech-to-text errors):
"""
${transcript}
"""

Extract ONLY what the dealer actually said or did. Do NOT infer intent, do NOT
score, do NOT band, do NOT be generous. If a signal is not clearly present, mark
it "no". Each signal must be a FACT the dealer stated, not an impression — mark
"yes" only on explicit disclosure, never infer from tone.

Output STRICT JSON ONLY — no preamble, no markdown, no code fences.

RULES for each field:
- relevant_dealer = "yes" if he manufactures, assembles, sells, OR trades
  batteries, e-rickshaws, OR electric two-wheelers (any one qualifies); capture
  which in dealer_segment.
- dealer_segment = ${DEALER_SEGMENTS.join(" | ")} (which market he is in; context
  only — no band impact).
- dealer_role = ${DEALER_ROLES.join(" | ")} (oem if he makes/assembles the
  product, dealer if he resells it, both if applicable, else unknown; context
  only — no band impact).
- battery_spec_shared = "yes" if he states the battery capacity he works on
  (voltage / Ah, e.g. 48V/60V/72V, 100Ah, lithium / lead-acid).
- volume_shared = "yes" if he gives a number: units per month, or business
  volume / turnover.
- existing_financier_shared = "yes" if he names/confirms a financier or NBFC he
  works with (or explicitly states he uses none).
- financing_need_expressed = "yes" if he says he needs financing, or that rising
  battery prices make financing necessary.
- financing_value_acknowledged = "yes" if he agrees financing would grow /
  improve his business.
- pitch_heard = "yes" if he stayed on the line through the battery + finance
  pitch without cutting it off.
- callback_agreed = "yes" if he agreed to a follow-up call. IMPORTANT: a PASSIVE
  "ok / theek hai / haan" to an AGENT-OFFERED callback COUNTS as "yes". You do
  NOT need the dealer to actively request the callback — agreement, even passive,
  is enough.
- disqualifier = "dont_call" (asked not to be called again), "hostile" (abusive),
  "not_interested" (firm no after the pitch), "call_dropped" (the call ended
  before its natural close), else "none". Allowed: ${DISQUALIFIERS.join(" | ")}.

EVIDENCE: for each listed field, give a short verbatim or paraphrased quote from
the dealer (or "" if absent).

ALSO:
- language = hindi | english | hinglish | unknown.
- call_summary = one neutral sentence describing what happened.

OUTPUT EXACTLY THIS JSON SHAPE (fill every field):
{
  "relevant_dealer": "yes" | "no",
  "dealer_segment": "battery" | "e_rickshaw" | "e_2w" | "multiple" | "none",
  "dealer_role": "oem" | "dealer" | "both" | "unknown",
  "battery_spec_shared": "yes" | "no",
  "volume_shared": "yes" | "no",
  "existing_financier_shared": "yes" | "no",
  "financing_need_expressed": "yes" | "no",
  "financing_value_acknowledged": "yes" | "no",
  "pitch_heard": "yes" | "no",
  "callback_agreed": "yes" | "no",
  "disqualifier": "none" | "dont_call" | "hostile" | "not_interested" | "call_dropped",
  "evidence": {
    "relevant_dealer": "<short quote/paraphrase>",
    "battery_spec_shared": "<capacity / voltage / Ah / chemistry stated>",
    "volume_shared": "<units per month or business volume stated>",
    "existing_financier_shared": "<financier/NBFC named, or 'none'>",
    "financing_need_expressed": "<what he said about needing financing>",
    "financing_value_acknowledged": "<what he said about financing helping business>",
    "callback_agreed": "<the line where they agreed>"
  },
  "language": "hindi" | "english" | "hinglish" | "unknown",
  "call_summary": "..."
}
${renderCalibrationExamples()}
Return ONLY the JSON object.`;
}

export async function extractSignals(transcript: string): Promise<ExtractionResult> {
  const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const prompt = buildPrompt(transcript, now);

  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [
            {
              role: "system",
              content:
                "You are a factual call-signal extraction engine. You report ONLY what the dealer explicitly said as yes/no facts. You NEVER score and NEVER band. Return ONLY valid JSON — no markdown, no explanation, no code fences.",
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.1,
          response_format: { type: "json_object" },
        }),
      });

      // Rate limited — wait and retry (preserve the 10/20/30s behaviour).
      if (res.status === 429) {
        const waitMs = attempt * 10_000;
        console.warn(
          `[OPENAI] Rate limited (attempt ${attempt}/${MAX_RETRIES}), waiting ${waitMs / 1000}s...`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      if (!res.ok) {
        console.error(`[OPENAI] HTTP ${res.status} on attempt ${attempt}`);
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, attempt * 5000));
          continue;
        }
        return { status: "failed", reason: `openai_http_${res.status}` };
      }

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;

      if (!text) {
        console.error("[OPENAI] Empty response on attempt", attempt);
        if (attempt < MAX_RETRIES) continue;
        return { status: "failed", reason: "empty_response" };
      }

      const cleaned = cleanJSON(text);
      if (!cleaned) {
        console.error("[OPENAI] No JSON found in response:", text.slice(0, 300));
        return { status: "failed", reason: "no_json" };
      }

      let raw: unknown;
      try {
        raw = JSON.parse(cleaned);
      } catch {
        console.error("[OPENAI] JSON parse failed:", text.slice(0, 300));
        return { status: "failed", reason: "json_parse_error" };
      }

      const parsed = QualificationSignalsSchema.safeParse(raw);
      if (!parsed.success) {
        console.error("[OPENAI] Signal schema validation failed:", parsed.error.message);
        return { status: "failed", reason: "schema_validation_error" };
      }

      return { status: "ok", signals: parsed.data };
    } catch (err) {
      console.error(`[OPENAI] API error (attempt ${attempt}/${MAX_RETRIES}):`, err);
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, attempt * 5000));
        continue;
      }
      return { status: "failed", reason: "network_error" };
    }
  }

  return { status: "failed", reason: "exhausted_retries" };
}

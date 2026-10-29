// (A) EXTRACTION — the LLM's ONLY job. It reads the transcript and returns
// FACTUAL yes/no SIGNALS WITH EVIDENCE (signals.ts). It must NOT score and must
// NOT band — the band lives in the deterministic engine (computeBand.ts). This
// keeps the band reproducible and auditable: change the prompt and the *signals*
// may shift, but the band → signal mapping stays fixed and inspectable.
// (Spec: docs/intent_docs/intent_score.pdf §2.)

import {
  QualificationSignalsSchema,
  type QualificationSignals,
  PRODUCT_LINES,
  DEALER_ROLES,
  DISQUALIFIERS,
  CALLBACK_TOPICS,
} from "@/lib/ai/scoring";
import { renderCalibrationExamples } from "./calibrationExamples";
import { loadActiveCalibrationExamples } from "./calibrationStore";
import { EXTRACTION_VERSION } from "@/lib/ai/scoring/version";

export type ExtractionResult =
  | {
      status: "ok";
      signals: QualificationSignals;
      // WHICH prompt produced these signals. EXTRACTION_VERSION alone no longer
      // identifies it: since E-250 the calibration examples live in the DB and
      // can change without a deploy, so two calls can share a version and have
      // been read by different examples. The hash closes that gap and is
      // persisted on ai_call_logs so a past score stays reproducible.
      extractionVersion: string;
      calibrationSetHash: string;
    }
  | { status: "failed"; reason: string };

function cleanJSON(text: string) {
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : "";
}

function buildPrompt(
  transcript: string,
  now: string,
  calibrationBlock: string,
): string {
  return `You are analysing a transcript of an outbound sales call between iTarang's
AI agent ("Priya") and a dealer. iTarang sells lithium batteries for
e-rickshaws / e-autos, electric two-wheelers and inverters, plus inverters,
solar and ESS / BESS, with an EMI financing scheme, to dealers across India.

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
- lithium_dealer = "yes" if he confirms he sells / deals in / works with
  lithium or lithium-ion batteries. A short "haan / ji / जी / yes / हाँ" in
  direct reply to the agent asking whether he is a lithium battery dealer
  COUNTS as "yes". "no" if he says he does not (only lead-acid, or does not
  deal in batteries at all). "unknown" if the question never came up or he
  never clearly answered it. This is the most important field.
- relevant_dealer = "yes" if he makes, assembles, sells OR trades anything in
  one of OUR product lines below — lithium OR lead-acid both count. A shop
  that deals ONLY in car, truck or petrol-bike batteries (or no batteries,
  inverters or solar at all) is "no". A lead-acid e-rickshaw or inverter
  battery dealer is "yes".
- product_lines = every one of OUR lines he deals in, as a list (several
  allowed, [] if none was stated):
  "three_wheeler" (e-rickshaw / e-auto batteries), "two_wheeler" (electric
  scooter / bike batteries), "inverter_battery", "inverter", "solar",
  "ess_bess" (energy storage / BESS). Allowed: ${PRODUCT_LINES.join(" | ")}.
- dealer_role = ${DEALER_ROLES.join(" | ")} (oem if he makes/assembles the
  product, dealer if he resells it, both if applicable, else unknown; context
  only — no band impact).
- battery_spec_shared = "yes" if he states the battery capacity he works on
  (voltage / Ah, e.g. 48V/60V/72V, 100Ah, lithium / lead-acid).
- volume_shared = "yes" if he states a number for his monthly volume (units /
  sets / batteries per month, or monthly business volume).
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
- callback_when = the dealer's own words for WHEN to call back, verbatim (e.g.
  "kal shaam 5 baje", "2 ghante baad", "Monday"), or "" if he named no time.
- callback_at = callback_when read against CURRENT TIME as an ISO 8601
  timestamp in IST with offset (e.g. "2026-10-24T17:00:00+05:30"), or "" if he
  named no time or callback_agreed is "no". Never invent a time he did not say.
- callback_topic = what the follow-up is for:
  "pricing" (rate / price / margin / EMI amount), "negotiation" (discount,
  terms, a better deal), "dealership" (becoming a dealer / distributor /
  partnership), "purchase" (placing an order, stock, delivery, buying now),
  "general_info" (just wants details / a brochure / is busy now), else "none".
  Pick the most commercial one that applies.
- wants_human = "yes" only if HE HIMSELF asks to speak to a person — a manager,
  a senior, "someone from the company", a salesperson, a real human — else
  "no". The agent's script itself offers "our sales manager will call you";
  agreeing to that offer (giving a time, "ok", "theek hai") is callback_agreed,
  NOT wants_human.
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
  "lithium_dealer": "yes" | "no" | "unknown",
  "relevant_dealer": "yes" | "no",
  "product_lines": [${PRODUCT_LINES.map((l) => `"${l}"`).join(", ")}] (only those he deals in),
  "dealer_role": "oem" | "dealer" | "both" | "unknown",
  "battery_spec_shared": "yes" | "no",
  "volume_shared": "yes" | "no",
  "existing_financier_shared": "yes" | "no",
  "financing_need_expressed": "yes" | "no",
  "financing_value_acknowledged": "yes" | "no",
  "pitch_heard": "yes" | "no",
  "callback_agreed": "yes" | "no",
  "callback_when": "<his words for when, or empty>",
  "callback_at": "<ISO 8601 IST timestamp, or empty>",
  "callback_topic": ${CALLBACK_TOPICS.map((t) => `"${t}"`).join(" | ")},
  "wants_human": "yes" | "no",
  "disqualifier": "none" | "dont_call" | "hostile" | "not_interested" | "call_dropped",
  "evidence": {
    "lithium_dealer": "<his answer to the lithium-dealer question>",
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
${calibrationBlock}
Return ONLY the JSON object.`;
}

export async function extractSignals(
  transcript: string,
  // When the call happened — re-reading an old call must resolve "kal" against
  // the call's day, not today's (scripts/reprocess-campaign-outcomes.ts).
  opts: { now?: Date } = {},
): Promise<ExtractionResult> {
  const now = (opts.now ?? new Date()).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

  // The active few-shot set: the built-in seed plus any admin-promoted
  // examples. Never throws — a DB problem degrades to the seed set rather than
  // failing the extraction.
  const calibration = await loadActiveCalibrationExamples();
  const prompt = buildPrompt(
    transcript,
    now,
    renderCalibrationExamples(calibration.examples),
  );

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

      // Out of credits is also a 429, but no wait fixes it — fail at once with a
      // reason that says so (it was hiding as "exhausted_retries" after 60s, on
      // every call, 21–22 Oct 2026).
      if (res.status === 429) {
        const body = await res.clone().text().catch(() => "");
        if (/insufficient_quota|credit_balance_exhausted|no credits/i.test(body)) {
          console.error("[OPENAI] Out of credits — add credits to the OpenAI organization");
          return { status: "failed", reason: "openai_no_credits" };
        }
      }

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

      return {
        status: "ok",
        signals: parsed.data,
        extractionVersion: EXTRACTION_VERSION,
        calibrationSetHash: calibration.hash,
      };
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

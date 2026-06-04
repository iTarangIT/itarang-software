// (A) EXTRACTION — the LLM's ONLY job. It reads the transcript and returns
// STRUCTURED SIGNALS WITH EVIDENCE (signals.ts). It must NOT return a final
// score — the arithmetic lives in the deterministic scoring engine. This keeps
// the score reproducible and auditable: change the prompt and the *signals* may
// shift, but the score → signal mapping stays fixed and inspectable.

import {
  IntentSignalsSchema,
  type IntentSignals,
  SIGNAL_LEVELS,
  AUTHORITY_LEVELS,
  TIMELINE_LEVELS,
  OBJECTION_LEVELS,
} from "@/lib/ai/scoring";

export type ExtractionResult =
  | { status: "ok"; signals: IntentSignals }
  | { status: "failed"; reason: string };

function cleanJSON(text: string) {
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : "";
}

function buildPrompt(transcript: string, now: string): string {
  return `You are a deterministic sales-intelligence extraction engine for an
outbound EV / lithium-ion battery dealer-calling agent (the agent "Priya" calls
e-rickshaw / EV battery dealers across India, offering batteries with EMI
financing and booking dealer visits).

CURRENT TIME (Asia/Kolkata): ${now}

CONVERSATION (agent + dealer; Hindi / English / Hinglish, may contain
speech-to-text errors):
"""
${transcript}
"""

YOUR JOB: read the conversation and emit STRUCTURED SIGNALS WITH EVIDENCE.
You DO NOT score the lead. You only report what the DEALER said.

RULES (read carefully):
- Output STRICT JSON ONLY — no prose, no markdown, no code fences.
- Judge the DEALER, never the agent. Do NOT penalise the dealer for the agent's
  mistakes, repetitions, or awkward phrasing.
- Be CONSERVATIVE. Do NOT infer enthusiasm, need, or budget that isn't actually
  present. When the transcript doesn't support a signal, use "unknown" and set
  evidence to "unknown". "unknown" is a real value — it is NOT the same as "none"
  (none = the dealer actively showed no need / no interest).
- A callback being OFFERED BY THE AGENT ("I'll call you later") is NOT a callback
  request. Only set facts.callback_requested=true when the DEALER asks to be
  called back or to talk later.
- Interpret Hinglish charitably, but if a passage is garbled/unintelligible, mark
  the affected signal "unknown".
- Each signal needs a short evidence string: a brief verbatim or paraphrased
  quote from the dealer (or "unknown").

SIGNAL DEFINITIONS:
- budget        — dealer's interest in / ability for EMI financing or funding the
                  purchase. level: ${SIGNAL_LEVELS.join(" | ")}
- authority     — is the speaker the owner / decision-maker? Single-prop dealers
                  usually ARE the owner, so prefer "decision_maker" unless they
                  clearly defer to someone else. level: ${AUTHORITY_LEVELS.join(" | ")}
- need          — real demand: fleet/volume, current battery pain, replacement
                  cycle. level: ${SIGNAL_LEVELS.join(" | ")}
- timeline      — when the dealer will act. level: ${TIMELINE_LEVELS.join(" | ")}
- engagement    — depth of the dealer's participation in the conversation.
                  level: ${SIGNAL_LEVELS.join(" | ")}
- curiosity     — dealer asking product questions (price, range, warranty, specs).
                  level: ${SIGNAL_LEVELS.join(" | ")}
- objection_quality — quality of objections raised. "substantive" = engaged buyer
                  pushing back on real concerns; "low" = vague brush-off; "none" =
                  no objections. level: ${OBJECTION_LEVELS.join(" | ")}

FACTS:
- facts.quantity            — any quantity the dealer mentioned (e.g. "15 units"),
                              else null.
- facts.callback_requested  — true ONLY if the DEALER asked to talk later.
- facts.competitor_named    — competitor brand the dealer named, else null.

NEGATIVE SIGNALS (booleans — only true when clearly present):
- negatives.explicit_not_interested   — dealer clearly declined.
- negatives.already_bought_competitor — dealer already bought from a competitor.
- negatives.do_not_call               — dealer asked not to be called again.
- negatives.hostile                   — dealer was abusive / hostile.
- negatives.call_too_short            — call was near-empty / cut short (< ~20s,
                                        essentially no real exchange).

ALSO:
- language      — ${["hindi", "english", "hinglish", "unknown"].join(" | ")}
- call_summary  — one neutral sentence describing what happened.
- callback_time — if the dealer named a callback time ("2 minute baad", "kal",
                  "shaam ko"), echo that phrase here, else null.

OUTPUT EXACTLY THIS JSON SHAPE (fill every field):
{
  "budget": { "level": "...", "evidence": "..." },
  "authority": { "level": "...", "evidence": "..." },
  "need": { "level": "...", "evidence": "..." },
  "timeline": { "level": "...", "evidence": "..." },
  "engagement": { "level": "...", "evidence": "..." },
  "curiosity": { "level": "...", "evidence": "..." },
  "objection_quality": { "level": "...", "evidence": "..." },
  "facts": { "quantity": null, "callback_requested": false, "competitor_named": null },
  "negatives": {
    "explicit_not_interested": false,
    "already_bought_competitor": false,
    "do_not_call": false,
    "hostile": false,
    "call_too_short": false
  },
  "language": "...",
  "call_summary": "...",
  "callback_time": null
}

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
                "You are a deterministic sales-intelligence extraction engine. You extract structured signals with evidence. You NEVER output a score. Return ONLY valid JSON — no markdown, no explanation, no code fences.",
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

      const parsed = IntentSignalsSchema.safeParse(raw);
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

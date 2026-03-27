import { ParsedData } from "./types";

function cleanJSON(text: string) {
  return text
    .replace(/```json|```/g, "")
    .replace(/^[^{]*/, "")
    .trim();
}

function extractMemoryFromText(transcript: string) {
  const lower = transcript.toLowerCase();
  const quantityMatch = transcript.match(/\d+/);

  return {
    requirement: lower.includes("battery") ? "battery" : null,
    product_interest: "EV batteries",
    quantity: quantityMatch ? quantityMatch[0] : null,
    intent_summary: transcript,
    followup_reason: lower.includes("call") ? "callback requested" : null,
  };
}

function fallback(transcript: string): ParsedData {
  return {
    outcome: "unknown",
    callback_time: null,
    language: "unknown",
    analysis: {
      next_step_commitment: 0,
      urgency_signals: 0,
      product_curiosity: 0,
      need_acknowledgment: 0,
      objection_quality: 0,
      engagement_depth: 0,
      intent_score: 0,
    },
    memory: extractMemoryFromText(transcript),
  };
}

export async function parseTranscript(transcript: string): Promise<ParsedData> {
  const now = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
  });

  const prompt = `
You are a highly accurate AI sales intelligence engine.

Your job is to deeply analyze a conversation between a sales agent and a dealer and produce structured output.

You MUST behave like a deterministic system, not a casual chatbot.

---

CURRENT TIME (Asia/Kolkata IST):
${now}

Timezone: Asia/Kolkata

All time calculations MUST follow this timezone.

---

CONVERSATION:
"""
${transcript}
"""

---

CORE OBJECTIVE:

Understand the dealer’s REAL intent, even if:
- language is Hindi, Hinglish, or mixed
- sentences are incomplete or messy
- user corrects themselves
- conversation is long or noisy

Focus on MEANING, not wording.

---

CRITICAL INTERPRETATION RULES (VERY STRICT):

1. If dealer expresses need (e.g., "mujhe 15 battery chahiye")
   → product_interest = present
   → product_curiosity ≥ 7

2. If dealer asks to call later (examples):
   - "baad me call karo"
   - "2 minute baad call karo"
   - "later call karo"
   - "dobara call karo"
   → outcome MUST be "callback_requested"

3. If dealer shows BOTH:
   - requirement (quantity / product)
   - callback request
   → intent_score MUST be ≥ 70

4. If dealer is talking meaningfully
   → intent_score MUST NOT be 0

5. "unknown" outcome is ONLY allowed if:
   - no meaningful user intent exists
   - or conversation is empty / irrelevant

---

CALLBACK TIME EXTRACTION:

- "2 minute baad" → current time + 2 minutes
- "kal" → next day
- vague → "unspecified"
- none → null

Return ISO datetime.

---

SIGNALS (0–10):

- next_step_commitment
- urgency_signals
- product_curiosity
- need_acknowledgment
- objection_quality
- engagement_depth

---

INTENT SCORE CALCULATION:

Use reasoning, not guessing.

- 80–100 → strong buying intent
- 60–79 → clear interest + follow-up
- 40–59 → moderate interest
- 20–39 → weak interest
- 0–19 → no intent

---

MEMORY EXTRACTION (MANDATORY):

Extract ONLY if clearly present:

"memory": {
  "requirement": string | null,
  "product_interest": string | null,
  "quantity": string | null,
  "intent_summary": string,
  "followup_reason": string | null
}

Rules:
- Do not guess
- Keep intent_summary natural and short

---

SELF-CONSISTENCY CHECK (VERY IMPORTANT):

Before returning output, VERIFY:

- If memory.quantity exists → product_curiosity ≥ 5
- If callback detected → outcome = callback_requested
- If callback exists → intent_score ≥ 50
- If quantity + callback → intent_score ≥ 70

If any rule is violated → FIX the output.

---

FINAL OUTPUT (STRICT JSON ONLY):

{
  "outcome": "interested | callback_requested | not_interested | unknown",
  "callback_time": "string | null",
  "language": "hindi | english | hinglish | unknown",

  "analysis": {
    "next_step_commitment": number,
    "urgency_signals": number,
    "product_curiosity": number,
    "need_acknowledgment": number,
    "objection_quality": number,
    "engagement_depth": number,
    "intent_score": number
  },

  "memory": {
    "requirement": string | null,
    "product_interest": string | null,
    "quantity": string | null,
    "intent_summary": string,
    "followup_reason": string | null
  }
}

---

DO NOT:
- return partial JSON
- ignore rules
- output explanation
- return invalid or inconsistent data

Return ONLY valid JSON.
`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2 },
        }),
      },
    );

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) return fallback(transcript);

    const parsed = JSON.parse(cleanJSON(text));

    const hasQuantity = !!parsed.memory?.quantity;
    const hasCallback =
      parsed.outcome === "callback_requested" ||
      parsed.memory?.followup_reason?.includes("callback");

    let final: ParsedData = {
      outcome: parsed.outcome || "unknown",
      callback_time: parsed.callback_time || null,
      language: parsed.language || "unknown",
      analysis: parsed.analysis || {
        next_step_commitment: 0,
        urgency_signals: 0,
        product_curiosity: 0,
        need_acknowledgment: 0,
        objection_quality: 0,
        engagement_depth: 0,
        intent_score: 0,
      },
      memory:
        parsed.memory &&
        (parsed.memory.quantity ||
          parsed.memory.requirement ||
          parsed.memory.intent_summary)
          ? parsed.memory
          : extractMemoryFromText(transcript),
    };

    if (hasCallback && final.outcome !== "callback_requested") {
      final.outcome = "callback_requested";
    }

    if (hasQuantity && final.analysis.product_curiosity < 5) {
      final.analysis.product_curiosity = 7;
    }

    if (hasQuantity && hasCallback && final.analysis.intent_score < 60) {
      final.analysis.intent_score = 70;
    }

    return final;
  } catch {
    return fallback(transcript);
  }
}

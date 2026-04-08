import { ParsedData } from "./types";

function cleanJSON(text: string) {
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : "";
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
    memory: {
      requirement: null,
      product_interest: null,
      quantity: null,
      intent_summary: transcript,
      followup_reason: null,
    },
  };
}

export async function parseTranscript(transcript: string): Promise<ParsedData> {
  const now = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
  });

  const prompt = `
You are a deterministic AI sales intelligence engine used in production.

You MUST behave like a reliable system, not a chatbot.

---

CURRENT TIME (Asia/Kolkata):
${now}

Timezone: Asia/Kolkata

All time calculations MUST use this timezone.

---

CONVERSATION:
"""
${transcript}
"""

---

OBJECTIVE:

Analyze the dealer conversation and return:

1. Intent (accurate)
2. Intent score (0–100)
3. Callback time (if any)
4. Structured memory

You must handle:
- Hindi, Hinglish, English
- broken sentences
- corrections (e.g., "15 minute nahi 15 unit")
- interruptions
- real spoken language

---

STEP 1 — UNDERSTAND FACTS

Extract clearly:

- Product mentioned? (what)
- Quantity mentioned? (number)
- Callback requested? (yes/no)
- Urgency? (urgent / later / normal)

---

STEP 2 — DETERMINE OUTCOME

STRICT RULES:

- If dealer asks to call later (any form):
  → outcome = "callback_requested"

- If dealer clearly wants product:
  → outcome = "interested"

- If dealer refuses:
  → outcome = "not_interested"

- Only use "unknown" if NOTHING meaningful is present

---

STEP 3 — CALLBACK TIME PARSING

Convert natural language into ISO datetime.

Examples:
- "2 minute baad" → now + 2 min
- "5 min baad" → +5 min
- "1 ghante baad" → +1 hour
- "kal" → next day (10 AM default)
- vague → "unspecified"
- none → null

Return ISO format.

---

STEP 4 — SIGNAL SCORING (0–10)

- next_step_commitment
- urgency_signals
- product_curiosity
- need_acknowledgment
- objection_quality
- engagement_depth

Rules:
- Quantity → product_curiosity ≥ 7
- Callback → urgency_signals ≥ 5

---

STEP 5 — INTENT SCORE

Rules:

- Quantity + callback → 70–90
- Only quantity → 60–80
- Only callback → 40–65
- Strong buying → 85–100

CRITICAL:

- If meaningful conversation exists → NOT 0
- If quantity exists → ≥ 50
- If callback exists → ≥ 40

---

STEP 6 — MEMORY

Extract:

"memory": {
  "requirement": string | null,
  "product_interest": string | null,
  "quantity": string | null,
  "intent_summary": string,
  "followup_reason": string | null
}

---

STEP 7 — VALIDATION

Before returning:

- quantity exists → must not be null
- callback → outcome must be callback_requested
- meaningful conversation → intent_score > 0

Fix before output.

---

FINAL OUTPUT (STRICT JSON):

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

Return ONLY JSON.
`;

  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
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
                  "You are a deterministic AI sales intelligence engine used in production. Return ONLY valid JSON — no markdown, no explanation, no code fences.",
              },
              { role: "user", content: prompt },
            ],
            temperature: 0.1,
            response_format: { type: "json_object" },
          }),
        },
      );

      // Handle rate limiting — wait and retry
      if (res.status === 429) {
        const waitMs = attempt * 10_000; // 10s, 20s, 30s
        console.warn(
          `[OPENAI] Rate limited (attempt ${attempt}/${MAX_RETRIES}), waiting ${waitMs / 1000}s...`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;

      console.log("RAW OPENAI RESPONSE:", JSON.stringify(data, null, 2));
      console.log("RAW TEXT:", text);

      if (!text) {
        console.error("[OPENAI] Empty response on attempt", attempt);
        if (attempt < MAX_RETRIES) continue;
        return fallback(transcript);
      }

      try {
        const cleaned = cleanJSON(text);

        if (!cleaned) {
          console.error("NO JSON FOUND:", text);
          return fallback(transcript);
        }

        return JSON.parse(cleaned);
      } catch (err) {
        console.error("JSON PARSE FAILED:", text);
        return fallback(transcript);
      }
    } catch (err) {
      console.error(`[OPENAI] API error (attempt ${attempt}/${MAX_RETRIES}):`, err);
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, attempt * 5000));
        continue;
      }
      return fallback(transcript);
    }
  }

  return fallback(transcript);
}

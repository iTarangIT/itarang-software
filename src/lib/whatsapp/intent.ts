// Entry-router intent classifier — the Hindi WhatsApp front door.
//
// Text-only sibling of general-info.ts / extraction.ts: same REST endpoint,
// key fallback and retry policy. Given ONE free-text message (usually Hindi),
// it returns which of the three flows the sender wants, or "too_hard" so the
// caller can reply "our team will get back to you". Strict-JSON output like
// extraction.ts (temperature 0, responseMimeType application/json). Model is
// configurable via GEMINI_INTENT_MODEL (default gemini-flash-lite-latest).

import { buildIntentPrompt, INTENT_IDS, type IntentId } from "./prompts";

const MODEL = process.env.GEMINI_INTENT_MODEL || "gemini-flash-lite-latest";

function apiKey(): string {
  return (
    process.env.GEMINI_WHATSAPP_API_KEY || process.env.GEMINI_API_KEY || ""
  );
}

const GENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const MAX_GEMINI_ATTEMPTS = 3;

// Below this the classification is too shaky to auto-route — treated as
// "too_hard" so the sender is handed to the team rather than sent down the
// wrong flow.
const MIN_INTENT_CONFIDENCE = 0.5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface IntentResult {
  /** false only when the model/API was unreachable — caller falls back to keyword routing. */
  ok: boolean;
  intent?: IntentId;
  confidence?: number;
  error?: string;
}

function safeParse(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text);
  } catch {
    // Strip ```json fences if the model added them despite responseMimeType.
    const cleaned = text
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/, "")
      .trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }
}

/**
 * Classify one free-text WhatsApp message into an entry-flow intent.
 * Returns ok=false on any API failure so the caller can fall back to the
 * existing deterministic keyword routing. A valid-but-uncertain result
 * (confidence < MIN_INTENT_CONFIDENCE) is downgraded to "too_hard".
 */
export async function classifyIntent(text: string): Promise<IntentResult> {
  const key = apiKey();
  if (!key) return { ok: false, error: "gemini_key_missing" };

  const requestBody = JSON.stringify({
    system_instruction: { parts: [{ text: buildIntentPrompt() }] },
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      maxOutputTokens: 64,
    },
  });

  let lastError = "network_error";
  for (let attempt = 1; attempt <= MAX_GEMINI_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(
        `${GENAI_BASE}/${MODEL}:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
        },
      );

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        lastError = data?.error?.message ?? `gemini_http_${res.status}`;
        // 429 / 5xx are transient — retry; other 4xx won't change on retry.
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < MAX_GEMINI_ATTEMPTS) {
          await sleep(300 * attempt);
          continue;
        }
        console.error("[WhatsApp/intent] Gemini error:", lastError);
        return { ok: false, error: lastError };
      }

      const raw: string | undefined =
        data?.candidates?.[0]?.content?.parts?.[0]?.text;
      const parsed = raw ? safeParse(raw) : null;
      if (!parsed) return { ok: false, error: "gemini_unparseable_json" };

      const intent = parsed.intent as IntentId;
      if (!INTENT_IDS.includes(intent)) {
        // A shape we don't recognise is worse than a human handoff, but the
        // API itself worked — surface it as a confident "too_hard".
        return { ok: true, intent: "too_hard", confidence: 0 };
      }

      const confidence =
        typeof parsed.confidence === "number" ? parsed.confidence : 0;
      // Downgrade shaky classifications so we don't strand the sender in the
      // wrong flow.
      if (intent !== "too_hard" && confidence < MIN_INTENT_CONFIDENCE) {
        return { ok: true, intent: "too_hard", confidence };
      }
      return { ok: true, intent, confidence };
    } catch (err) {
      // Connection-level failure ("fetch failed") — always transient, retry.
      lastError = err instanceof Error ? err.message : "network_error";
      if (attempt < MAX_GEMINI_ATTEMPTS) {
        await sleep(300 * attempt);
        continue;
      }
    }
  }

  console.error(
    `[WhatsApp/intent] failed after ${MAX_GEMINI_ATTEMPTS} attempts:`,
    lastError,
  );
  return { ok: false, error: lastError };
}

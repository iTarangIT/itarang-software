// "General Information" Q&A via Gemini — the third entry-menu option.
//
// Text-only sibling of extraction.ts: same REST endpoint, key fallback and
// retry policy, but plain-text output grounded on ITARANG_INFO_SYSTEM_PROMPT
// (answers come ONLY from that facts block). Model is configurable via
// GEMINI_INFO_MODEL (default gemini-flash-lite-latest).

import { ITARANG_INFO_SYSTEM_PROMPT } from "./prompts";

const MODEL = process.env.GEMINI_INFO_MODEL || "gemini-flash-lite-latest";

function apiKey(): string {
  return (
    process.env.GEMINI_WHATSAPP_API_KEY || process.env.GEMINI_API_KEY || ""
  );
}

const GENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const MAX_GEMINI_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface InfoTurn {
  q: string;
  a: string;
}

export interface InfoAnswer {
  ok: boolean;
  answer?: string;
  error?: string;
}

/**
 * Answer one free-form question about iTarang, grounded on the facts prompt.
 * `history` (oldest first) is replayed as prior turns so follow-up questions
 * ("and for customers?") keep their context. Returns ok=false on any API
 * failure — the caller apologises and falls back to the entry menu.
 */
export async function answerGeneralQuestion(
  question: string,
  history: InfoTurn[] = [],
): Promise<InfoAnswer> {
  const key = apiKey();
  if (!key) return { ok: false, error: "gemini_key_missing" };

  const contents = [
    ...history.flatMap((turn) => [
      { role: "user", parts: [{ text: turn.q }] },
      { role: "model", parts: [{ text: turn.a }] },
    ]),
    { role: "user", parts: [{ text: question }] },
  ];

  const requestBody = JSON.stringify({
    system_instruction: { parts: [{ text: ITARANG_INFO_SYSTEM_PROMPT }] },
    contents,
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 512,
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
        console.error("[WhatsApp/general-info] Gemini error:", lastError);
        return { ok: false, error: lastError };
      }

      const raw: string | undefined =
        data?.candidates?.[0]?.content?.parts?.[0]?.text;
      const answer = (raw ?? "").trim();
      if (!answer) return { ok: false, error: "gemini_empty_response" };
      return { ok: true, answer };
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
    `[WhatsApp/general-info] failed after ${MAX_GEMINI_ATTEMPTS} attempts:`,
    lastError,
  );
  return { ok: false, error: lastError };
}

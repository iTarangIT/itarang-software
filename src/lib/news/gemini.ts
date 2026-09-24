/**
 * Green Energy News — one thin Gemini JSON call (E-306).
 *
 * Same REST shape as src/lib/whatsapp/translate.ts: v1beta generateContent,
 * JSON response mime type, hard timeout, fail-open (null). The key falls back
 * from the summary-specific key to the shared one so a box with only
 * GEMINI_API_KEY still works.
 */

export const NEWS_MODEL = process.env.GEMINI_NEWS_MODEL || "gemini-flash-lite-latest";

const GENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const TIMEOUT_MS = Number(process.env.GREEN_NEWS_GEMINI_TIMEOUT_MS || 90_000);

export function newsGeminiKey(): string {
  return process.env.GEMINI_API_KEY_FOR_SUMMARY || process.env.GEMINI_API_KEY || "";
}

/** Strip a ```json fence and recover the outermost object if the model chatted. */
export function safeParseJson<T = unknown>(raw: string): T | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Ask for a JSON object. Returns null on a missing key, timeout, HTTP error or
 * unparseable body — callers treat null as "leave it for next run".
 */
export async function generateJson<T = unknown>(
  prompt: string,
  opts: { maxOutputTokens?: number; temperature?: number } = {},
): Promise<T | null> {
  const key = newsGeminiKey();
  if (!key) {
    console.warn("[green-news] no Gemini key (GEMINI_API_KEY_FOR_SUMMARY / GEMINI_API_KEY) — skipping");
    return null;
  }

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.2,
      responseMimeType: "application/json",
      maxOutputTokens: opts.maxOutputTokens ?? 8192,
    },
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${GENAI_BASE}/${NEWS_MODEL}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("[green-news] Gemini error:", data?.error?.message ?? `gemini_http_${res.status}`);
      return null;
    }
    const raw: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return null;
    return safeParseJson<T>(raw);
  } catch (err) {
    console.error("[green-news] Gemini call failed:", err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Document READ via Gemini 3.1 Flash-Lite (design §5 step 2, §6).
//
// Sends the original media (image or PDF) inline to Gemini and asks for strict
// JSON. Uses a dedicated key (GEMINI_WHATSAPP_API_KEY) so document-extraction
// quota/billing is isolated from the scraper/summary GEMINI_API_KEY. Model is
// configurable via GEMINI_WHATSAPP_MODEL (default gemini-flash-lite-latest).

import { buildExtractionPrompt } from "./prompts";

const MODEL = process.env.GEMINI_WHATSAPP_MODEL || "gemini-flash-lite-latest";

function apiKey(): string {
  return (
    process.env.GEMINI_WHATSAPP_API_KEY || process.env.GEMINI_API_KEY || ""
  );
}

export interface ExtractionResult {
  /** Did Gemini think this is the document type we asked for? */
  isExpectedType: boolean;
  /** Is the document clear enough to read? */
  legible: boolean;
  /** 0..1 confidence in the extracted fields. */
  confidence: number;
  /** Extracted fields (values may be null). */
  fields: Record<string, unknown>;
  /** True only if the call itself succeeded; on error the bot asks to resend. */
  ok: boolean;
  error?: string;
}

const GENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** Gemini accepts these media types inline. */
function isSupportedMime(mime: string): boolean {
  return (
    mime.startsWith("image/") ||
    mime === "application/pdf"
  );
}

export async function readDocument(
  buffer: Buffer,
  mimeType: string,
  expectedType: string,
): Promise<ExtractionResult> {
  const key = apiKey();
  if (!key) {
    return blank({ ok: false, error: "gemini_key_missing" });
  }
  if (!isSupportedMime(mimeType)) {
    return blank({ ok: false, error: `unsupported_mime:${mimeType}` });
  }

  const prompt = buildExtractionPrompt(expectedType);

  try {
    const res = await fetch(
      `${GENAI_BASE}/${MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  inline_data: {
                    mime_type: mimeType,
                    data: buffer.toString("base64"),
                  },
                },
                { text: prompt },
              ],
            },
          ],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
            maxOutputTokens: 1024,
          },
        }),
      },
    );

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error =
        data?.error?.message ?? `gemini_http_${res.status}`;
      console.error("[WhatsApp/extraction] Gemini error:", error);
      return blank({ ok: false, error });
    }

    const raw: string | undefined =
      data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return blank({ ok: false, error: "gemini_empty_response" });

    const parsed = safeParse(raw);
    if (!parsed) return blank({ ok: false, error: "gemini_unparseable_json" });

    return {
      ok: true,
      isExpectedType: Boolean(parsed.is_expected_type),
      legible: parsed.legible !== false, // default to legible unless explicitly false
      confidence: clamp01(Number(parsed.confidence ?? 0)),
      fields:
        parsed.fields && typeof parsed.fields === "object"
          ? (parsed.fields as Record<string, unknown>)
          : {},
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : "network_error";
    console.error("[WhatsApp/extraction] failed:", error);
    return blank({ ok: false, error });
  }
}

function safeParse(text: string): any | null {
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

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function blank(over: Partial<ExtractionResult>): ExtractionResult {
  return {
    isExpectedType: false,
    legible: false,
    confidence: 0,
    fields: {},
    ok: false,
    ...over,
  };
}

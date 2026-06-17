// Document READ via Gemini 3.1 Flash-Lite (design §5 step 2, §6).
//
// Sends the original media (image or PDF) inline to Gemini and asks for strict
// JSON. Uses a dedicated key (GEMINI_WHATSAPP_API_KEY) so document-extraction
// quota/billing is isolated from the scraper/summary GEMINI_API_KEY. Model is
// configurable via GEMINI_WHATSAPP_MODEL (default gemini-flash-lite-latest).

import { buildClassifyPrompt, buildExtractionPrompt } from "./prompts";

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

// Single inline-media generateContent call. Returns the parsed JSON object the
// model produced, or an {error} discriminant the callers turn into a blank
// result. Shared by readDocument (known type) and classifyDocument (batch/ZIP).
async function generate(
  buffer: Buffer,
  mimeType: string,
  prompt: string,
): Promise<{ parsed: any } | { error: string }> {
  const key = apiKey();
  if (!key) return { error: "gemini_key_missing" };
  if (!isSupportedMime(mimeType)) return { error: `unsupported_mime:${mimeType}` };

  try {
    const res = await fetch(`${GENAI_BASE}/${MODEL}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inline_data: { mime_type: mimeType, data: buffer.toString("base64") } },
              { text: prompt },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          // 2048 (not 1024) so GST certs with several Additional Places of
          // Business — each a full address object — aren't truncated.
          maxOutputTokens: 2048,
        },
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = data?.error?.message ?? `gemini_http_${res.status}`;
      console.error("[WhatsApp/extraction] Gemini error:", error);
      return { error };
    }

    const raw: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return { error: "gemini_empty_response" };

    const parsed = safeParse(raw);
    if (!parsed) return { error: "gemini_unparseable_json" };
    return { parsed };
  } catch (err) {
    const error = err instanceof Error ? err.message : "network_error";
    console.error("[WhatsApp/extraction] failed:", error);
    return { error };
  }
}

export async function readDocument(
  buffer: Buffer,
  mimeType: string,
  expectedType: string,
): Promise<ExtractionResult> {
  const out = await generate(buffer, mimeType, buildExtractionPrompt(expectedType));
  if ("error" in out) return blank({ ok: false, error: out.error });
  const parsed = out.parsed;
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
}

export interface ClassificationResult {
  /** Detected document type (a key of DOC_FIELDS) or "unknown". */
  documentType: string;
  legible: boolean;
  confidence: number;
  fields: Record<string, unknown>;
  ok: boolean;
  error?: string;
}

// Detect-then-extract for an UNLABELLED file (ZIP/batch upload). Lets a dealer
// dump every document at once; the orchestrator routes each result by
// documentType into the same save/fill path the one-at-a-time flow uses.
export async function classifyDocument(
  buffer: Buffer,
  mimeType: string,
): Promise<ClassificationResult> {
  const out = await generate(buffer, mimeType, buildClassifyPrompt());
  if ("error" in out) {
    return {
      documentType: "unknown",
      legible: false,
      confidence: 0,
      fields: {},
      ok: false,
      error: out.error,
    };
  }
  const parsed = out.parsed;
  const documentType =
    typeof parsed.document_type === "string" && parsed.document_type
      ? parsed.document_type
      : "unknown";
  return {
    ok: true,
    documentType,
    legible: parsed.legible !== false,
    confidence: clamp01(Number(parsed.confidence ?? 0)),
    fields:
      parsed.fields && typeof parsed.fields === "object"
        ? (parsed.fields as Record<string, unknown>)
        : {},
  };
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

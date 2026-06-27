import OpenAI from "openai";

/**
 * Lazy OpenAI client for invoice extraction. Reads OPENAI_API_KEY from the
 * environment (already present in .env.local). Kept lazy so importing this
 * module never throws at build time when the key is absent.
 */
let _client: OpenAI | null = null;

export function getOpenAI(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not configured");
    }
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

// Vision-capable model used for invoice extraction. Overridable via env.
export const INVOICE_MODEL = process.env.INVOICE_OPENAI_MODEL || "gpt-4o";

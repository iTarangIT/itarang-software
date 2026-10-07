/**
 * Read the LINE ITEMS of a sales invoice (tracker ID 72, E-326).
 *
 * A separate call from extractSalesInvoice on purpose: that one decides
 * whether the file becomes revenue at all, and its prompt is tuned line by
 * line against real misreads. The lines are needed only for gross margin, so
 * a failure here must never cost an invoice — the caller stores the header
 * first and treats this as best-effort.
 *
 * Nothing read here is trusted on its own: saveInvoiceLines / the margin query
 * use the lines only when they add up to the invoice's taxable value.
 *
 * Read with GEMINI (not OpenAI like the header reader): Gemini takes the PDF
 * inline, so no page rendering is needed. Key: GEMINI_INVOICE_API_KEY, else
 * GEMINI_API_KEY. Model: INVOICE_GEMINI_MODEL (default gemini-2.5-flash).
 * 429 / 5xx / network blips are retried; a bad key or request fails at once.
 */

import type { InvoiceLineCandidate } from "@/lib/sales/salesInvoiceLines";

const GENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const MODEL = process.env.INVOICE_GEMINI_MODEL || "gemini-2.5-flash";
const MAX_ATTEMPTS = 3;

function apiKey(): string {
  return process.env.GEMINI_INVOICE_API_KEY || process.env.GEMINI_API_KEY || "";
}

// Gemini's response schema (OpenAPI subset): nullable instead of type unions.
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    lines: {
      type: "ARRAY",
      description: "One entry per row of the items table, in the order printed",
      items: {
        type: "OBJECT",
        properties: {
          description: {
            type: "STRING",
            nullable: true,
            description: "The item name exactly as printed, including voltage / Ah / model",
          },
          hsn_code: { type: "STRING", nullable: true, description: "HSN / SAC code of the row, digits only" },
          quantity: { type: "NUMBER", nullable: true, description: "Quantity of the row" },
          rate: { type: "NUMBER", nullable: true, description: "Price per unit BEFORE GST" },
          amount: {
            type: "NUMBER",
            nullable: true,
            description:
              "Taxable value of the row BEFORE GST, after any discount — the 'Taxable amount' column. Never the row total including GST.",
          },
        },
        required: ["description", "hsn_code", "quantity", "rate", "amount"],
      },
    },
  },
  required: ["lines"],
} as const;

const SYSTEM_PROMPT = [
  "You read the items table of a GST sales invoice issued by an Indian company and return one entry per row.",
  "Return every row of the items table and nothing else: no totals row, no tax rows, no 'Round off', no bank or terms text.",
  "amount is the row's taxable value BEFORE GST and after any discount. When the table prints both a pre-tax amount and a total including GST for the row, return the pre-tax one.",
  "The amounts of all rows must add up to the invoice's taxable amount (the figure before GST), not to the grand total.",
  "When the table prints only a tax-inclusive row amount, compute the pre-tax value from the printed GST rate of that row; if no rate is printed, return null for amount.",
  "rate is the price of one unit before GST. quantity is the number of units.",
  "Copy description and hsn_code exactly as printed. Amounts are printed in the Indian grouping style (29,500.00); return plain numbers.",
  "If a value is not printed, return null. Never guess a quantity, a price or an HSN code.",
].join(" ");

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v.replace(/[,\s₹]/g, ""));
    return v.trim() && Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function supportedMime(mimeType: string): boolean {
  return mimeType === "application/pdf" || mimeType.startsWith("image/");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callGemini(buffer: Buffer, mimeType: string): Promise<string> {
  const key = apiKey();
  if (!key) throw new Error("GEMINI_API_KEY is not configured");
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [
      {
        role: "user",
        parts: [
          { inline_data: { mime_type: mimeType, data: buffer.toString("base64") } },
          { text: "Extract the rows of the items table from this invoice." },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  });

  let lastError = "network_error";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${GENAI_BASE}/${MODEL}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        lastError = `Gemini ${res.status}: ${data?.error?.message ?? "request failed"}`;
        if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
          await sleep(1000 * attempt);
          continue;
        }
        throw new Error(lastError);
      }
      const parts: Array<{ text?: string }> = data?.candidates?.[0]?.content?.parts ?? [];
      const raw = parts.map((p) => p.text ?? "").join("").trim();
      if (!raw) throw new Error(`Empty line-item response from Gemini (${data?.candidates?.[0]?.finishReason ?? "no candidate"})`);
      return raw;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Our own non-retryable throws above carry "Gemini "/"Empty"; a bare
      // network failure ("fetch failed") is retried.
      if (msg.startsWith("Gemini ") || msg.startsWith("Empty ")) throw err;
      lastError = msg;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(1000 * attempt);
        continue;
      }
    }
  }
  throw new Error(lastError);
}

export async function extractSalesInvoiceLines(
  buffer: Buffer,
  mimeType: string,
  fileName: string,
): Promise<InvoiceLineCandidate[]> {
  if (!supportedMime(mimeType)) {
    throw new Error(`Cannot read line items of ${fileName || "this file"}: unsupported type ${mimeType}`);
  }
  const raw = await callGemini(buffer, mimeType);
  let parsed: { lines?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Model returned non-JSON line-item output");
  }
  const rows = Array.isArray(parsed.lines) ? (parsed.lines as Record<string, unknown>[]) : [];
  return rows.map((r) => ({
    description: str(r.description),
    hsn_code: str(r.hsn_code),
    quantity: num(r.quantity),
    rate: num(r.rate),
    amount: num(r.amount),
  }));
}

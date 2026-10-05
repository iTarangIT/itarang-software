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
 */

import type { InvoiceLineCandidate } from "@/lib/sales/salesInvoiceLines";
import { getOpenAI, INVOICE_MODEL } from "./client";
import { salesInvoiceMediaParts } from "./extractSalesInvoice";

const JSON_SCHEMA = {
  name: "sales_invoice_lines",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      lines: {
        type: "array",
        description: "One entry per row of the items table, in the order printed",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            description: {
              type: ["string", "null"],
              description: "The item name exactly as printed, including voltage / Ah / model",
            },
            hsn_code: { type: ["string", "null"], description: "HSN / SAC code of the row, digits only" },
            quantity: { type: ["number", "null"], description: "Quantity of the row" },
            rate: {
              type: ["number", "null"],
              description: "Price per unit BEFORE GST",
            },
            amount: {
              type: ["number", "null"],
              description:
                "Taxable value of the row BEFORE GST, after any discount — the 'Taxable amount' column. Never the row total including GST.",
            },
          },
          required: ["description", "hsn_code", "quantity", "rate", "amount"],
        },
      },
    },
    required: ["lines"],
  },
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

export async function extractSalesInvoiceLines(
  buffer: Buffer,
  mimeType: string,
  fileName: string,
): Promise<InvoiceLineCandidate[]> {
  const mediaParts = await salesInvoiceMediaParts(buffer, mimeType, fileName);

  const completion = await getOpenAI().chat.completions.create({
    model: INVOICE_MODEL,
    temperature: 0,
    response_format: { type: "json_schema", json_schema: JSON_SCHEMA },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [{ type: "text", text: "Extract the rows of the items table from this invoice." }, ...mediaParts],
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("Empty line-item response from model");
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

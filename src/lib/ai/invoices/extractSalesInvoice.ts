/**
 * E-280 — structured extraction from a SALES invoice (one we issued).
 *
 * Sibling of extractInvoice.ts, which reads purchase bills. They are separate
 * because the two documents mean opposite things and the mistake is silent: on
 * a purchase bill the counterparty is the VENDOR and the amount is spend; on a
 * sales invoice the counterparty is the CUSTOMER and the amount is revenue. The
 * expense extractor pointed at a sales PDF during the Step-0 probe dutifully
 * returned `vendor: "Itarang Technologies LLP"` — us — and classified our own
 * revenue as a tech-department expense. Nothing about that output looks wrong
 * until it lands on the wrong side of the P&L.
 *
 * So the schema here names the parties explicitly (`customer_*` vs `seller_*`)
 * and the prompt says which part of the page each one is read from.
 *
 * WHY PDFs GO STRAIGHT TO THE MODEL
 *   The Vyapar invoices have no usable text layer — extraction returns four
 *   lines of boilerplate and garbles even those ("ITARANO TECHNOLOGIES LLP"),
 *   which is a broken ToUnicode map. OpenAI rasterises PDF input server-side
 *   and reads the rendered page, so the broken text layer never matters. This
 *   was verified against three live Vyapar invoices before the module was
 *   written; a local rasterize step (src/lib/ocr/pdfToImage.ts) is available
 *   but proved unnecessary.
 *
 * No classification fields. Unlike the expense side there is no department or
 * bucket to assign: revenue is revenue.
 */
import type { ChatCompletionContentPart } from "openai/resources/chat/completions";
import { getOpenAI, INVOICE_MODEL } from "./client";

export interface ExtractedSalesInvoice {
  invoice_number: string | null;
  invoice_date: string | null; // ISO yyyy-mm-dd
  due_date: string | null; // ISO yyyy-mm-dd
  customer_name: string | null;
  customer_gstin: string | null;
  seller_gstin: string | null;
  place_of_supply: string | null;
  sub_total: number | null;
  tax_total: number | null;
  total: number | null;
  currency: string | null;
}

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

const JSON_SCHEMA = {
  name: "sales_invoice_extraction",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      invoice_number: {
        type: ["string", "null"],
        description:
          "The invoice number exactly as printed, keeping its separators (e.g. ITD/202627/013)",
      },
      invoice_date: {
        type: ["string", "null"],
        description:
          "Invoice date in ISO format yyyy-mm-dd. Indian invoices print dd-mm-yyyy — convert, do not reorder blindly.",
      },
      due_date: { type: ["string", "null"], description: "Due date as yyyy-mm-dd" },
      customer_name: {
        type: ["string", "null"],
        description: "The BILL TO party — the customer being invoiced, never the issuer",
      },
      customer_gstin: {
        type: ["string", "null"],
        description: "GSTIN of the Bill To party",
      },
      seller_gstin: {
        type: ["string", "null"],
        description:
          "GSTIN of the ISSUER, printed in the letterhead at the top of the invoice",
      },
      place_of_supply: {
        type: ["string", "null"],
        description: "Place of supply exactly as printed, e.g. 'Haryana (06)'",
      },
      sub_total: {
        type: ["number", "null"],
        description: "Taxable value before GST, number only",
      },
      tax_total: {
        type: ["number", "null"],
        description:
          "Total GST — IGST, or CGST + SGST added together when the invoice splits them",
      },
      total: {
        type: ["number", "null"],
        description:
          "Grand total payable including GST, number only. NOT 'Balance Due' and NOT 'Amount in words'.",
      },
      currency: { type: ["string", "null"], description: "ISO currency code, e.g. INR" },
    },
    // strict:true — every property must appear here. "required" means "always
    // present in the output", not "must be non-null" (same note as
    // extractInvoice.ts:94).
    required: [
      "invoice_number",
      "invoice_date",
      "due_date",
      "customer_name",
      "customer_gstin",
      "seller_gstin",
      "place_of_supply",
      "sub_total",
      "tax_total",
      "total",
      "currency",
    ],
  },
} as const;

const SYSTEM_PROMPT = [
  "You read a GST sales invoice issued by an Indian company and return its fields.",
  "The ISSUER is the company whose name and GSTIN appear in the letterhead at the top, and near a 'For <company>' signature block at the bottom. Its GSTIN is seller_gstin.",
  "The CUSTOMER is the party under 'Bill To'. Its name is customer_name and its GSTIN is customer_gstin.",
  "Never put the issuer's name in customer_name. Both parties may share a similar name; go by position on the page, not by which name you recognise.",
  "Dates are printed dd-mm-yyyy on these invoices. '02-07-2026' is 2 July 2026, so invoice_date is 2026-07-02. Read the year digits carefully and copy them exactly.",
  "total is the grand total payable including GST — the figure labelled 'Total'. Do not return 'Balance Due', which may differ, and do not compute anything from the amount in words.",
  "tax_total is the whole GST charged: use IGST when present, otherwise add CGST and SGST together.",
  "Amounts are printed in the Indian grouping style (29,500.00). Return them as plain numbers with no symbols or separators.",
  "If a field is genuinely not present on the document, return null. Never guess an amount, a date or a GSTIN.",
].join(" ");

export async function extractSalesInvoice(
  buffer: Buffer,
  mimeType: string,
  fileName: string,
): Promise<ExtractedSalesInvoice> {
  const base64 = buffer.toString("base64");

  let mediaPart: ChatCompletionContentPart;
  if (mimeType === "application/pdf") {
    mediaPart = {
      type: "file",
      file: {
        filename: fileName || "invoice.pdf",
        file_data: `data:application/pdf;base64,${base64}`,
      },
    } as ChatCompletionContentPart;
  } else if (SUPPORTED_IMAGE_TYPES.has(mimeType)) {
    mediaPart = {
      type: "image_url",
      image_url: { url: `data:${mimeType};base64,${base64}`, detail: "high" },
    };
  } else {
    throw new Error(`Unsupported file type for extraction: ${mimeType}`);
  }

  const openai = getOpenAI();
  const completion = await openai.chat.completions.create({
    model: INVOICE_MODEL,
    temperature: 0,
    response_format: { type: "json_schema", json_schema: JSON_SCHEMA },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "Extract the sales invoice details from this document." },
          mediaPart,
        ],
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("Empty extraction response from model");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Model returned non-JSON extraction output");
  }

  return {
    invoice_number: str(parsed.invoice_number),
    invoice_date: str(parsed.invoice_date),
    due_date: str(parsed.due_date),
    customer_name: str(parsed.customer_name),
    customer_gstin: gstin(parsed.customer_gstin),
    seller_gstin: gstin(parsed.seller_gstin),
    place_of_supply: str(parsed.place_of_supply),
    sub_total: num(parsed.sub_total),
    tax_total: num(parsed.tax_total),
    total: num(parsed.total),
    currency: str(parsed.currency),
  };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * A GSTIN is 15 characters. Anything else is a misread, and a half-read GSTIN
 * is worse than none: resolveSalesOrg keys the entity off its first two digits,
 * so a truncated value would vote confidently for the wrong company.
 */
function gstin(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const cleaned = s.replace(/\s+/g, "").toUpperCase();
  return /^[0-9A-Z]{15}$/.test(cleaned) ? cleaned : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    // Tolerate the Indian grouping style surviving into the response.
    const n = Number(v.replace(/[,\s₹]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

import type { ChatCompletionContentPart } from "openai/resources/chat/completions";
import { getOpenAI, INVOICE_MODEL } from "./client";
import {
  EXPENSE_DEPARTMENTS,
  EXPENSE_DEPARTMENT_VALUES,
  type ExpenseDepartment,
} from "@/lib/expenses";

export interface ExtractedInvoice {
  vendor: string | null;
  amount: number | null;
  currency: string | null;
  date: string | null; // ISO yyyy-mm-dd
  description: string | null;
  department: ExpenseDepartment | null;
  project_tag: string | null;
  department_confidence: number | null; // 0..1
  invoice_number: string | null; // the document's own bill/invoice reference
}

export interface ExtractInvoiceOptions {
  /** Existing project tags (any department) to encourage tag reuse. */
  existingTags?: string[];
}

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

const JSON_SCHEMA = {
  name: "invoice_extraction",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      vendor: { type: ["string", "null"], description: "Vendor / supplier name" },
      amount: {
        type: ["number", "null"],
        description: "Total payable amount as a number, no currency symbol",
      },
      currency: { type: ["string", "null"], description: "ISO currency code, e.g. INR, USD" },
      date: {
        type: ["string", "null"],
        description: "Invoice date in ISO format yyyy-mm-dd",
      },
      description: {
        type: ["string", "null"],
        description: "Short description of what was purchased",
      },
      department: {
        type: ["string", "null"],
        enum: [...EXPENSE_DEPARTMENT_VALUES, null],
        description: "Best-fit department for this expense",
      },
      project_tag: {
        type: ["string", "null"],
        description:
          "Short project tag for monitoring. Reuse an existing tag if one clearly matches.",
      },
      department_confidence: {
        type: ["number", "null"],
        description: "Confidence in the department classification, 0 to 1",
      },
      invoice_number: {
        type: ["string", "null"],
        description:
          "The invoice/bill number exactly as printed on the document (its own reference, NOT a PO/order number)",
      },
    },
    required: [
      "vendor",
      "amount",
      "currency",
      "date",
      "description",
      "department",
      "project_tag",
      "department_confidence",
      "invoice_number",
    ],
  },
} as const;

function buildSystemPrompt(existingTags: string[]): string {
  const deptList = EXPENSE_DEPARTMENTS.map((d) => `${d.value} (${d.label})`).join(", ");
  const tagHint =
    existingTags.length > 0
      ? `Existing project tags you should reuse when they match: ${existingTags.join(", ")}.`
      : "There are no existing project tags yet; propose a short, reusable tag.";
  return [
    "You extract structured data from a company expense invoice or receipt.",
    "Return vendor, total amount (number only), currency, invoice date (yyyy-mm-dd), and a short description.",
    "Capture the invoice/bill number exactly as printed — the document's own reference number, not a purchase-order (PO) number.",
    `Classify the expense into exactly one department from: ${deptList}.`,
    "Also assign a concise project tag (2-4 words, Title Case) for project-level monitoring.",
    tagHint,
    "If a field is genuinely not present, return null for it. Do not guess amounts.",
  ].join(" ");
}

/**
 * Extract structured invoice fields from an uploaded bill using OpenAI vision.
 * Accepts images directly and PDFs via OpenAI's file input support.
 */
export async function extractInvoice(
  buffer: Buffer,
  mimeType: string,
  fileName: string,
  options: ExtractInvoiceOptions = {},
): Promise<ExtractedInvoice> {
  const existingTags = options.existingTags ?? [];
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
      { role: "system", content: buildSystemPrompt(existingTags) },
      {
        role: "user",
        content: [
          { type: "text", text: "Extract the expense details from this invoice." },
          mediaPart,
        ],
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) {
    throw new Error("Empty extraction response from model");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Model returned non-JSON extraction output");
  }

  const dept = parsed.department;
  const department =
    typeof dept === "string" && EXPENSE_DEPARTMENT_VALUES.includes(dept as ExpenseDepartment)
      ? (dept as ExpenseDepartment)
      : null;

  const amountNum =
    typeof parsed.amount === "number"
      ? parsed.amount
      : parsed.amount != null && !Number.isNaN(Number(parsed.amount))
        ? Number(parsed.amount)
        : null;

  return {
    vendor: typeof parsed.vendor === "string" ? parsed.vendor : null,
    amount: amountNum,
    currency: typeof parsed.currency === "string" ? parsed.currency : null,
    date: typeof parsed.date === "string" ? parsed.date : null,
    description: typeof parsed.description === "string" ? parsed.description : null,
    department,
    project_tag: typeof parsed.project_tag === "string" ? parsed.project_tag : null,
    department_confidence:
      typeof parsed.department_confidence === "number"
        ? parsed.department_confidence
        : null,
    invoice_number:
      typeof parsed.invoice_number === "string" && parsed.invoice_number.trim()
        ? parsed.invoice_number.trim()
        : null,
  };
}

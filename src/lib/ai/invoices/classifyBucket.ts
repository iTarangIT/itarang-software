/**
 * E-218 — bucket classification for rows that were already extracted.
 *
 * New invoices get their bucket for free: extractInvoice() asks for it in the
 * same call that reads the document. This module exists for the OTHER case —
 * the ~200 invoices already sitting in `expense_submissions` from before E-218,
 * whose PDFs would have to be re-downloaded and re-read to use that path.
 *
 * Those rows already carry vendor, description, project tag and department as
 * text. That is enough to bucket them, so this is a text-only call: no vision,
 * a cheaper model, and MANY ROWS PER CALL. Classifying 200 rows one at a time
 * would be 200 requests to answer a question whose whole context is two short
 * strings; batched, it is a handful.
 *
 * The rule engine runs first (see resolveBucket.ts), so in practice only the
 * unrecognised vendors reach here at all.
 */
import { getOpenAI } from "./client";
import {
  EXPENSE_BUCKETS,
  EXPENSE_BUCKET_DESCRIPTIONS,
  EXPENSE_BUCKET_VALUES,
  isExpenseBucket,
  type ExpenseBucket,
} from "@/lib/expenses";

/**
 * Text-only classification, so the vision-grade model is unnecessary.
 * Overridable for the same reason INVOICE_MODEL is.
 */
export const BUCKET_MODEL = process.env.BUCKET_OPENAI_MODEL || "gpt-4o-mini";

/**
 * Rows per request. Large enough that the taxonomy in the system prompt is
 * amortised over many rows, small enough that one malformed response cannot
 * cost the whole run.
 */
export const BUCKET_BATCH_SIZE = 40;

export interface BucketCandidate {
  /** Caller's own identifier — echoed back so results can be matched up. */
  id: string;
  vendor?: string | null;
  description?: string | null;
  project_tag?: string | null;
  department?: string | null;
  amount?: number | null;
}

export interface BucketVerdict {
  bucket: ExpenseBucket;
  confidence: number | null;
}

const JSON_SCHEMA = {
  name: "expense_bucket_classification",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      results: {
        type: "array",
        description: "One entry per input row, in any order, using the same id.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", description: "The id exactly as given" },
            bucket: {
              type: ["string", "null"],
              enum: [...EXPENSE_BUCKET_VALUES, null],
              description: "Best-fit bucket, or null if genuinely undecidable",
            },
            confidence: {
              type: ["number", "null"],
              description: "Confidence in the classification, 0 to 1",
            },
          },
          required: ["id", "bucket", "confidence"],
        },
      },
    },
    required: ["results"],
  },
} as const;

function buildSystemPrompt(): string {
  const bucketList = EXPENSE_BUCKETS.map(
    (b) => `- ${b.value} (${b.label}): ${EXPENSE_BUCKET_DESCRIPTIONS[b.value]}`,
  ).join("\n");
  return [
    "You classify company expenses into coarse spend buckets for a CEO dashboard.",
    "The company builds and sells electric vehicles and runs a dealer CRM.",
    "",
    "The buckets are:",
    bucketList,
    "",
    "You are given rows that have ALREADY been read off their invoices — vendor, description, project tag, department and amount. Classify each one.",
    'Department is whose budget the spend belongs to, and is NOT the answer: a battery order raised by the tech team is department "tech" but bucket "rm".',
    "Return one result per input row, echoing its id exactly.",
    'Use null for bucket only when a row genuinely gives you nothing to go on — do not spread guesses across buckets to look balanced.',
  ].join("\n");
}

function renderRow(row: BucketCandidate): string {
  const parts = [
    `id=${row.id}`,
    row.vendor ? `vendor=${row.vendor}` : null,
    row.description ? `description=${row.description}` : null,
    row.project_tag ? `project=${row.project_tag}` : null,
    row.department ? `department=${row.department}` : null,
    row.amount != null ? `amount=${row.amount}` : null,
  ].filter(Boolean);
  return parts.join(" | ");
}

/**
 * Classify one batch. Exported for tests; callers should use
 * `classifyBuckets`, which handles chunking.
 */
export async function classifyBucketBatch(
  rows: BucketCandidate[],
): Promise<Map<string, BucketVerdict>> {
  const out = new Map<string, BucketVerdict>();
  if (rows.length === 0) return out;

  const openai = getOpenAI();
  const completion = await openai.chat.completions.create({
    model: BUCKET_MODEL,
    temperature: 0,
    response_format: { type: "json_schema", json_schema: JSON_SCHEMA },
    messages: [
      { role: "system", content: buildSystemPrompt() },
      {
        role: "user",
        content: `Classify these ${rows.length} expenses:\n\n${rows
          .map(renderRow)
          .join("\n")}`,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("Empty classification response from model");

  let parsed: { results?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Model returned non-JSON bucket classification");
  }

  if (!Array.isArray(parsed.results)) return out;

  // Re-validate rather than trusting strict mode, and only keep ids we asked
  // about — a hallucinated id would otherwise silently join the result set.
  const asked = new Set(rows.map((r) => r.id));
  for (const entry of parsed.results) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, bucket, confidence } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !asked.has(id)) continue;
    if (!isExpenseBucket(bucket)) continue;
    out.set(id, {
      bucket,
      confidence: typeof confidence === "number" ? confidence : null,
    });
  }

  return out;
}

/**
 * Classify any number of rows, chunked into batches.
 *
 * A batch that fails does not take the run down with it — those rows simply
 * come back unclassified, and `resolveBucket` files them under "others". For a
 * backfill that is the right trade: 39 correct buckets and one default beats
 * aborting and leaving 200 rows unclassified.
 */
export async function classifyBuckets(
  rows: BucketCandidate[],
  opts: {
    batchSize?: number;
    onBatch?: (info: { index: number; total: number; size: number; failed?: string }) => void;
  } = {},
): Promise<Map<string, BucketVerdict>> {
  const batchSize = opts.batchSize ?? BUCKET_BATCH_SIZE;
  const batches: BucketCandidate[][] = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    batches.push(rows.slice(i, i + batchSize));
  }

  const merged = new Map<string, BucketVerdict>();
  for (const [index, batch] of batches.entries()) {
    try {
      const result = await classifyBucketBatch(batch);
      for (const [id, verdict] of result) merged.set(id, verdict);
      opts.onBatch?.({ index, total: batches.length, size: batch.length });
    } catch (e) {
      opts.onBatch?.({
        index,
        total: batches.length,
        size: batch.length,
        failed: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return merged;
}

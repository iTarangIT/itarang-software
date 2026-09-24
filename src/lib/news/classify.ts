/**
 * Green Energy News — Gemini tagging (E-306).
 *
 * For each new item: region (india / world), category (see ./categories), a
 * 0-100 relevance for iTarang's CEO, and a one-sentence summary. Prompt and
 * response parsing are pure and unit tested; `classifyPending` does the DB
 * round-trip in batches and leaves anything Gemini could not answer for the
 * next run (classified_at stays NULL).
 */

import { and, asc, eq, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import { greenNewsItems } from "@/lib/db/schema";

import { DEFAULT_MIN_RELEVANCE, type NewsRegion } from "./categories";
import {
  CLASSIFY_BATCH_SIZE,
  buildClassifyPrompt,
  parseClassifyResponse,
  type ClassifyInput,
  type ClassifyResult,
} from "./classify-core";
import { generateJson } from "./gemini";

export {
  CLASSIFY_BATCH_SIZE,
  buildClassifyPrompt,
  parseClassifyResponse,
  type ClassifyInput,
  type ClassifyResult,
} from "./classify-core";

export async function classifyBatch(items: ClassifyInput[]): Promise<Map<string, ClassifyResult>> {
  if (items.length === 0) return new Map();
  const parsed = await generateJson(buildClassifyPrompt(items));
  const hints = new Map(items.map((i) => [i.id, i.regionHint]));
  return parseClassifyResponse(parsed, items.map((i) => i.id), hints);
}

/**
 * Classify every row with classified_at IS NULL (oldest first, capped per run).
 * Returns how many rows were written.
 */
export async function classifyPending(opts: {
  minRelevance?: number;
  regionHintOf?: (sourceKey: string) => NewsRegion | undefined;
  maxRows?: number;
} = {}): Promise<number> {
  const minRelevance = opts.minRelevance ?? DEFAULT_MIN_RELEVANCE;
  const maxRows = opts.maxRows ?? 200;

  const pending = await db
    .select({
      id: greenNewsItems.id,
      title: greenNewsItems.title,
      snippet: greenNewsItems.snippet,
      source_key: greenNewsItems.source_key,
      source_name: greenNewsItems.source_name,
    })
    .from(greenNewsItems)
    .where(and(isNull(greenNewsItems.classified_at), eq(greenNewsItems.hidden, false)))
    .orderBy(asc(greenNewsItems.fetched_at))
    .limit(maxRows);

  let written = 0;
  for (let i = 0; i < pending.length; i += CLASSIFY_BATCH_SIZE) {
    const batch = pending.slice(i, i + CLASSIFY_BATCH_SIZE).map((p) => ({
      id: p.id,
      title: p.title,
      snippet: p.snippet,
      sourceName: p.source_name,
      regionHint: opts.regionHintOf?.(p.source_key) ?? null,
    }));
    const results = await classifyBatch(batch);
    const now = new Date();
    for (const [id, r] of results) {
      await db
        .update(greenNewsItems)
        .set({
          region: r.region,
          category: r.category,
          relevance: r.relevance,
          summary: r.summary || null,
          // classifyPending only selects hidden=false rows, so this never un-hides a manual hide.
          hidden: r.relevance < minRelevance,
          classified_at: now,
        })
        .where(eq(greenNewsItems.id, id));
      written += 1;
    }
  }
  return written;
}

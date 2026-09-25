/**
 * Green Energy News — the 5-bullet morning brief (E-306).
 *
 * One row per IST day. Written by the first run after 06:00 IST (so the
 * overnight world news is in), never rewritten unless forced. Each bullet
 * cites the item ids it was drawn from so the card can link the bullet to a
 * headline.
 */

import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { greenNewsBriefs, greenNewsItems } from "@/lib/db/schema";

import {
  BRIEF_EARLIEST_IST_HOUR,
  BRIEF_ITEM_LIMIT,
  buildBriefPrompt,
  parseBriefResponse,
} from "./brief-core";
import { NEWS_MODEL, generateJson } from "./gemini";
import { istDateString, istHour } from "./time";

export {
  BRIEF_EARLIEST_IST_HOUR,
  BRIEF_ITEM_LIMIT,
  buildBriefPrompt,
  parseBriefResponse,
  type BriefBullet,
} from "./brief-core";

/** Is a brief for today's IST date due right now? */
export function briefIsDue(now: Date = new Date()): boolean {
  return istHour(now) >= BRIEF_EARLIEST_IST_HOUR;
}

/**
 * Write today's brief if it is due and missing (or `force`). Returns true when
 * a row was written.
 */
export async function writeDailyBrief(opts: { force?: boolean; now?: Date } = {}): Promise<boolean> {
  const now = opts.now ?? new Date();
  if (!opts.force && !briefIsDue(now)) return false;
  const istDate = istDateString(now);

  if (!opts.force) {
    const [existing] = await db
      .select({ id: greenNewsBriefs.id })
      .from(greenNewsBriefs)
      .where(eq(greenNewsBriefs.brief_date, istDate))
      .limit(1);
    if (existing) return false;
  }

  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const items = await db
    .select({
      id: greenNewsItems.id,
      title: greenNewsItems.title,
      summary: greenNewsItems.summary,
      region: greenNewsItems.region,
      category: greenNewsItems.category,
      sourceName: greenNewsItems.source_name,
    })
    .from(greenNewsItems)
    .where(
      and(
        eq(greenNewsItems.hidden, false),
        isNotNull(greenNewsItems.classified_at),
        gte(greenNewsItems.published_at, since),
      ),
    )
    .orderBy(desc(greenNewsItems.relevance), desc(greenNewsItems.published_at))
    .limit(BRIEF_ITEM_LIMIT);

  if (items.length < 3) return false; // nothing worth summarising yet

  const parsed = await generateJson(buildBriefPrompt(items, istDate), { temperature: 0.3, maxOutputTokens: 2048 });
  const bullets = parseBriefResponse(parsed, items.map((i) => i.id));
  if (bullets.length === 0) return false;

  await db
    .insert(greenNewsBriefs)
    .values({
      brief_date: istDate,
      bullets,
      model: NEWS_MODEL,
      item_count: items.length,
      generated_at: now,
    })
    .onConflictDoUpdate({
      target: greenNewsBriefs.brief_date,
      set: {
        bullets,
        model: NEWS_MODEL,
        item_count: items.length,
        generated_at: sql`now()`,
      },
    });
  return true;
}

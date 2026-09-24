/**
 * Green Energy News — read side for the card and the page (E-306).
 */

import { and, desc, eq, gte, isNotNull, lt, or, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { greenNewsBriefs, greenNewsItems, greenNewsRuns } from "@/lib/db/schema";

import type { NewsCategory, NewsRegion } from "./categories";
import type { BriefBullet } from "./brief-core";

export type NewsItemRow = {
  id: string;
  url: string;
  source_key: string;
  source_name: string | null;
  title: string;
  summary: string | null;
  snippet: string | null;
  image_url: string | null;
  published_at: string;
  region: string | null;
  category: string | null;
  relevance: number | null;
};

export type NewsBriefRow = {
  brief_date: string;
  bullets: BriefBullet[];
  item_count: number;
  generated_at: string;
};

export type NewsRunRow = {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  triggered_by: string;
  fetched: number;
  inserted: number;
  classified: number;
  brief_written: boolean;
  error: string | null;
};

export type ListItemsParams = {
  region?: NewsRegion | null;
  category?: NewsCategory | null;
  days?: number;
  limit?: number;
  cursor?: string | null;
  /** Only classified rows (default true) — an unclassified row has no summary yet. */
  classifiedOnly?: boolean;
};

export function encodeCursor(publishedAt: Date, id: string): string {
  return Buffer.from(`${publishedAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | null | undefined): { publishedAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    const d = new Date(iso);
    if (!id || Number.isNaN(d.getTime())) return null;
    return { publishedAt: d, id };
  } catch {
    return null;
  }
}

export async function listItems(params: ListItemsParams): Promise<{ items: NewsItemRow[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(100, params.limit ?? 30));
  const days = Math.max(1, Math.min(90, params.days ?? 7));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const cur = decodeCursor(params.cursor);

  const conds = [eq(greenNewsItems.hidden, false), gte(greenNewsItems.published_at, since)];
  if (params.classifiedOnly !== false) conds.push(isNotNull(greenNewsItems.classified_at));
  if (params.region) conds.push(eq(greenNewsItems.region, params.region));
  if (params.category) conds.push(eq(greenNewsItems.category, params.category));
  if (cur) {
    conds.push(
      or(
        lt(greenNewsItems.published_at, cur.publishedAt),
        and(eq(greenNewsItems.published_at, cur.publishedAt), lt(greenNewsItems.id, cur.id)),
      )!,
    );
  }

  const rows = await db
    .select({
      id: greenNewsItems.id,
      url: greenNewsItems.url,
      source_key: greenNewsItems.source_key,
      source_name: greenNewsItems.source_name,
      title: greenNewsItems.title,
      summary: greenNewsItems.summary,
      snippet: greenNewsItems.snippet,
      image_url: greenNewsItems.image_url,
      published_at: greenNewsItems.published_at,
      region: greenNewsItems.region,
      category: greenNewsItems.category,
      relevance: greenNewsItems.relevance,
    })
    .from(greenNewsItems)
    .where(and(...conds))
    .orderBy(desc(greenNewsItems.published_at), desc(greenNewsItems.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? encodeCursor(last.published_at, last.id) : null;

  return {
    items: page.map((r) => ({ ...r, published_at: r.published_at.toISOString() })),
    nextCursor,
  };
}

/** Top items of the last 24 h by relevance — what the overview card shows. */
export async function topItems(limit = 6): Promise<NewsItemRow[]> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      id: greenNewsItems.id,
      url: greenNewsItems.url,
      source_key: greenNewsItems.source_key,
      source_name: greenNewsItems.source_name,
      title: greenNewsItems.title,
      summary: greenNewsItems.summary,
      snippet: greenNewsItems.snippet,
      image_url: greenNewsItems.image_url,
      published_at: greenNewsItems.published_at,
      region: greenNewsItems.region,
      category: greenNewsItems.category,
      relevance: greenNewsItems.relevance,
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
    .limit(limit);
  // Fall back to the newest classified items when the last day is thin (first
  // fetch, a quiet Sunday) so the card is never empty while the DB has rows.
  if (rows.length < Math.min(3, limit)) {
    const more = await db
      .select({
        id: greenNewsItems.id,
        url: greenNewsItems.url,
        source_key: greenNewsItems.source_key,
        source_name: greenNewsItems.source_name,
        title: greenNewsItems.title,
        summary: greenNewsItems.summary,
        snippet: greenNewsItems.snippet,
        image_url: greenNewsItems.image_url,
        published_at: greenNewsItems.published_at,
        region: greenNewsItems.region,
        category: greenNewsItems.category,
        relevance: greenNewsItems.relevance,
      })
      .from(greenNewsItems)
      .where(and(eq(greenNewsItems.hidden, false), isNotNull(greenNewsItems.classified_at)))
      .orderBy(desc(greenNewsItems.published_at))
      .limit(limit);
    const seen = new Set(rows.map((r) => r.id));
    for (const m of more) if (!seen.has(m.id) && rows.length < limit) rows.push(m);
  }
  return rows.map((r) => ({ ...r, published_at: r.published_at.toISOString() }));
}

export async function getBrief(istDate: string): Promise<NewsBriefRow | null> {
  const [row] = await db
    .select()
    .from(greenNewsBriefs)
    .where(eq(greenNewsBriefs.brief_date, istDate))
    .limit(1);
  return row ? toBrief(row) : null;
}

export async function getLatestBrief(): Promise<NewsBriefRow | null> {
  const [row] = await db.select().from(greenNewsBriefs).orderBy(desc(greenNewsBriefs.brief_date)).limit(1);
  return row ? toBrief(row) : null;
}

function toBrief(row: typeof greenNewsBriefs.$inferSelect): NewsBriefRow {
  return {
    brief_date: row.brief_date,
    bullets: (Array.isArray(row.bullets) ? row.bullets : []) as BriefBullet[],
    item_count: row.item_count,
    generated_at: row.generated_at.toISOString(),
  };
}

export async function getLastRun(): Promise<NewsRunRow | null> {
  const [row] = await db.select().from(greenNewsRuns).orderBy(desc(greenNewsRuns.started_at)).limit(1);
  if (!row) return null;
  return {
    ...row,
    started_at: row.started_at.toISOString(),
    finished_at: row.finished_at ? row.finished_at.toISOString() : null,
  };
}

/** Last run that finished ok, for the spacing guard. */
export async function lastOkRunAt(): Promise<Date | null> {
  const [row] = await db
    .select({ finished_at: greenNewsRuns.finished_at })
    .from(greenNewsRuns)
    .where(eq(greenNewsRuns.status, "ok"))
    .orderBy(desc(greenNewsRuns.finished_at))
    .limit(1);
  return row?.finished_at ?? null;
}

/** Items the brief cites, so the card can link a bullet to its headline. */
export async function itemsByIds(ids: string[]): Promise<Map<string, { id: string; url: string; title: string }>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: greenNewsItems.id, url: greenNewsItems.url, title: greenNewsItems.title })
    .from(greenNewsItems)
    .where(sql`${greenNewsItems.id} IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`);
  return new Map(rows.map((r) => [r.id, r]));
}

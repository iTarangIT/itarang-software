/**
 * Green Energy News — one refresh (E-306).
 *
 *   1. Skip if the feature is off, or a run finished ok < MIN_GAP ago (unless
 *      forced). The ticker asks every 30 min; this is what makes it 2-hourly.
 *   2. Fetch every source concurrently; a failing feed is logged, not fatal.
 *   3. Dedupe (canonical-URL hash, then normalised-title hash against the last
 *      3 days) and insert with ON CONFLICT DO NOTHING.
 *   4. Classify whatever is unclassified (Gemini, batched, fail-open).
 *   5. Write today's brief if it is due and missing.
 *
 * Every step's counts land on a green_news_runs row for the "Updated …" label
 * and for debugging from the DB alone.
 */

import { and, eq, gte, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { greenNewsItems, greenNewsRuns } from "@/lib/db/schema";

import { writeDailyBrief } from "./brief";
import { classifyPending } from "./classify";
import { fetchFeed, type FeedEntry } from "./fetch";
import { titleHash, urlHash } from "./normalize";
import { lastOkRunAt } from "./queries";
import { getGreenNewsSettings } from "./settings";
import { resolveSources, type NewsSource } from "./sources";

export type RunTrigger = "ticker" | "cron" | "manual";

export type RunResult = {
  ran: boolean;
  reason?: "disabled" | "too_soon" | "failed";
  runId?: number;
  fetched: number;
  inserted: number;
  classified: number;
  briefWritten: boolean;
  failedSources: { key: string; error: string }[];
  error?: string;
};

export const MIN_GAP_MS = Number(process.env.GREEN_NEWS_MIN_GAP_MS || 2 * 60 * 60 * 1000);
/** Ignore entries older than this on fetch — a publisher feed's back-catalogue is not "today". */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const TITLE_DEDUPE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

type Candidate = {
  url_hash: string;
  url: string;
  source_key: string;
  source_name: string | null;
  title: string;
  title_hash: string;
  snippet: string | null;
  image_url: string | null;
  published_at: Date;
};

function toCandidate(e: FeedEntry, source: NewsSource, now: Date): Candidate | null {
  const published = e.publishedAt ?? now;
  if (now.getTime() - published.getTime() > MAX_AGE_MS) return null;
  if (published.getTime() - now.getTime() > 6 * 60 * 60 * 1000) return null; // clock-skewed feed
  return {
    url_hash: urlHash(e.link),
    url: e.link.trim(),
    source_key: source.key,
    source_name: e.publisher || source.name,
    title: e.title,
    title_hash: titleHash(e.title),
    snippet: e.description || null,
    image_url: e.imageUrl,
    published_at: published,
  };
}

export async function runGreenNewsRefresh(opts: { triggeredBy: RunTrigger; force?: boolean }): Promise<RunResult> {
  const base: RunResult = { ran: false, fetched: 0, inserted: 0, classified: 0, briefWritten: false, failedSources: [] };

  const settings = await getGreenNewsSettings();
  if (!settings.enabled) return { ...base, reason: "disabled" };

  if (!opts.force) {
    const last = await lastOkRunAt();
    if (last && Date.now() - last.getTime() < MIN_GAP_MS) return { ...base, reason: "too_soon" };
  }

  const [run] = await db
    .insert(greenNewsRuns)
    .values({ triggered_by: opts.triggeredBy, status: "running" })
    .returning({ id: greenNewsRuns.id });
  const runId = run.id;
  const result: RunResult = { ...base, ran: true, runId };

  try {
    const sources = resolveSources(settings);
    const now = new Date();

    // 2. fetch
    const settled = await Promise.allSettled(sources.map((s) => fetchFeed(s)));
    const candidates: Candidate[] = [];
    settled.forEach((r, i) => {
      const s = sources[i];
      if (r.status === "rejected") {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        result.failedSources.push({ key: s.key, error: msg });
        console.warn(`[green-news] ${s.key} failed: ${msg}`);
        return;
      }
      result.fetched += r.value.length;
      for (const e of r.value) {
        const c = toCandidate(e, s, now);
        if (c) candidates.push(c);
      }
    });

    // 3. dedupe — within the batch first, then against recent rows by title.
    const byUrl = new Map<string, Candidate>();
    const seenTitles = new Set<string>();
    for (const c of candidates) {
      if (byUrl.has(c.url_hash) || seenTitles.has(c.title_hash)) continue;
      byUrl.set(c.url_hash, c);
      seenTitles.add(c.title_hash);
    }
    let fresh = [...byUrl.values()];
    if (fresh.length) {
      const since = new Date(now.getTime() - TITLE_DEDUPE_WINDOW_MS);
      const existing = await db
        .select({ title_hash: greenNewsItems.title_hash })
        .from(greenNewsItems)
        .where(
          and(
            gte(greenNewsItems.fetched_at, since),
            inArray(greenNewsItems.title_hash, fresh.map((f) => f.title_hash)),
          ),
        );
      const known = new Set(existing.map((r) => r.title_hash));
      fresh = fresh.filter((f) => !known.has(f.title_hash));
    }

    if (fresh.length) {
      const inserted = await db
        .insert(greenNewsItems)
        .values(fresh.map((f) => ({ ...f, fetched_at: now })))
        .onConflictDoNothing({ target: greenNewsItems.url_hash })
        .returning({ id: greenNewsItems.id });
      result.inserted = inserted.length;
    }

    // 4. classify
    const hintOf = new Map(sources.map((s) => [s.key, s.regionHint]));
    result.classified = await classifyPending({
      minRelevance: settings.minRelevance,
      regionHintOf: (key) => hintOf.get(key),
    });

    // 5. brief
    result.briefWritten = await writeDailyBrief({ force: false, now: new Date() });

    await db
      .update(greenNewsRuns)
      .set({
        status: "ok",
        finished_at: new Date(),
        fetched: result.fetched,
        inserted: result.inserted,
        classified: result.classified,
        brief_written: result.briefWritten,
        error: result.failedSources.length
          ? result.failedSources.map((f) => `${f.key}: ${f.error}`).join("; ").slice(0, 2000)
          : null,
      })
      .where(eq(greenNewsRuns.id, runId));
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[green-news] run failed:", msg);
    await db
      .update(greenNewsRuns)
      .set({ status: "failed", finished_at: new Date(), error: msg.slice(0, 2000) })
      .where(eq(greenNewsRuns.id, runId))
      .catch(() => {});
    return { ...result, reason: "failed", error: msg };
  }
}

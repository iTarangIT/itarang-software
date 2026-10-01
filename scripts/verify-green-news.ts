/**
 * verify-green-news.ts — read-only check of the Green Energy News feed (E-306).
 *
 *   node --import tsx --env-file=.env.local scripts/verify-green-news.ts
 *   node --import tsx --env-file=.env.local scripts/verify-green-news.ts --feeds-only
 *
 * 1. Fetches EVERY configured source live and prints how many entries each
 *    returned (a 0 or an error = fix or drop that URL in src/lib/news/sources.ts).
 * 2. Unless --feeds-only: checks the three E-306 tables exist and prints the
 *    latest run, item counts by region/category, and today's brief.
 *
 * Writes nothing.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { fetchFeed } from "@/lib/news/fetch";
import { getGreenNewsSettings } from "@/lib/news/settings";
import { resolveSources } from "@/lib/news/sources";
import { istDateString } from "@/lib/news/time";

async function checkFeeds() {
  const settings = await getGreenNewsSettings().catch(() => ({ enabled: true, extraFeeds: [], extraQueries: [], minRelevance: 40 }));
  const sources = resolveSources(settings);
  console.log(`\n== Feeds (${sources.length}) ==`);
  const results = await Promise.allSettled(sources.map((s) => fetchFeed(s)));
  let ok = 0;
  results.forEach((r, i) => {
    const s = sources[i];
    if (r.status === "fulfilled") {
      ok += r.value.length > 0 ? 1 : 0;
      const newest = r.value.map((e) => e.publishedAt?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
      console.log(
        `${r.value.length > 0 ? "✓" : "✗"} ${s.key.padEnd(30)} ${String(r.value.length).padStart(3)} entries` +
          (newest ? `  newest ${new Date(newest).toISOString().slice(0, 16)}` : "") +
          `  e.g. "${r.value[0]?.title?.slice(0, 60) ?? ""}"`,
      );
    } else {
      console.log(`✗ ${s.key.padEnd(30)} ERROR ${r.reason instanceof Error ? r.reason.message : r.reason}`);
    }
  });
  console.log(`${ok}/${sources.length} sources returned entries.`);
}

async function checkDb() {
  console.log("\n== Database ==");
  const tables = ["green_news_items", "green_news_briefs", "green_news_runs"];
  for (const t of tables) {
    const r = await db.execute(sql`SELECT to_regclass(${t}) AS reg`);
    const reg = (r as unknown as { rows?: { reg: string | null }[] }).rows?.[0]?.reg ?? (r as unknown as { reg: string | null }[])[0]?.reg;
    console.log(`${reg ? "✓" : "✗"} ${t}${reg ? "" : "  — E-306 not applied on this DB"}`);
    if (!reg) return;
  }

  const run = await db.execute(sql`SELECT * FROM green_news_runs ORDER BY started_at DESC LIMIT 1`);
  const runRow = (run as unknown as { rows?: unknown[] }).rows?.[0] ?? (run as unknown as unknown[])[0];
  console.log("latest run:", runRow ?? "(none yet)");

  const counts = await db.execute(sql`
    SELECT coalesce(region,'(unclassified)') AS region, coalesce(category,'-') AS category,
           count(*) FILTER (WHERE NOT hidden) AS visible, count(*) FILTER (WHERE hidden) AS hidden
    FROM green_news_items
    WHERE published_at > now() - interval '7 days'
    GROUP BY 1,2 ORDER BY 1,2`);
  console.log("items last 7 days by region/category:");
  console.table((counts as unknown as { rows?: unknown[] }).rows ?? counts);

  const today = istDateString();
  const brief = await db.execute(sql`SELECT brief_date, item_count, generated_at, jsonb_array_length(bullets) AS bullets FROM green_news_briefs ORDER BY brief_date DESC LIMIT 3`);
  console.log(`briefs (today IST = ${today}):`);
  console.table((brief as unknown as { rows?: unknown[] }).rows ?? brief);
}

async function main() {
  const feedsOnly = process.argv.includes("--feeds-only");
  await checkFeeds();
  if (!feedsOnly) await checkDb();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

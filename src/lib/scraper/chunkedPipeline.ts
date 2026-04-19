import { db } from "@/lib/db";
import { scrapeRuns, scraperRunChunks } from "@/lib/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { generateQueries, generateCitiesForQuery } from "./query/generateQueries";
import { getCachedQueries, setCachedQueries } from "./query/queryCache";
import { fetchFromGooglePlaces } from "./query/sources/googlePlaces";
import { processLeads } from "./processing";
import { saveRawLeads } from "./storage/rawStore";
import { saveCleanLeads, promoteLeadsToDealerLeads } from "./storage/leadStore";
import { saveDuplicateLeads } from "./storage/duplicateStore";
import { markRunCompleted, markRunFailed } from "./storage/runStore";
import { scraperRaw } from "@/lib/db/schema";
import { connection as redis } from "@/lib/queue/connection";
import { publishToPath } from "@/lib/queue/scheduler";

const MAX_PAGES_PER_QUERY = 3;
const MAX_QUERY_VARIATIONS = 15;

function normalizeQuery(q: string) {
  return q
    .replace(/\b3w\b/gi, "e rickshaw")
    .replace(/\b3 wheeler\b/gi, "e rickshaw")
    .trim();
}

// Phase 1: generate query×city combinations, persist chunks, fan out to QStash.
// This runs inside the initial POST /api/scraper/run invocation and must stay
// comfortably under the Vercel Hobby 60s budget. AI query/city generation is
// the only slow step (~5-10s); chunk inserts and QStash publishes are batched.
export async function startChunkedRun(runId: string, baseQuery: string) {
  try {
    let queryVariations = getCachedQueries(baseQuery);
    if (!queryVariations) {
      queryVariations = await generateQueries(baseQuery);
      setCachedQueries(baseQuery, queryVariations);
    }
    queryVariations = [...new Set(queryVariations.map(normalizeQuery))].slice(
      0,
      MAX_QUERY_VARIATIONS,
    );

    const cities = await generateCitiesForQuery(baseQuery);

    const combinations: string[] = [];
    for (const variation of queryVariations) {
      for (const city of cities) {
        combinations.push(`${variation} in ${city}`);
      }
    }

    if (!combinations.length) {
      await markRunCompleted(runId, {
        total: 0,
        cleaned: 0,
        saved: 0,
        duplicates: 0,
        duration_ms: 0,
      });
      return { totalChunks: 0 };
    }

    const chunkRows = combinations.map((combo, idx) => ({
      id: `CHUNK-${runId}-${String(idx).padStart(4, "0")}`,
      runId,
      combinationQuery: combo,
      status: "pending",
      leadsCount: 0,
    }));

    await db.insert(scraperRunChunks).values(chunkRows);

    await db
      .update(scrapeRuns)
      .set({ totalChunks: combinations.length, completedChunks: 0 })
      .where(eq(scrapeRuns.id, runId));

    console.log(
      `[SCRAPER][${runId}] fanning out ${combinations.length} chunks`,
    );

    for (const chunk of chunkRows) {
      await publishToPath({
        path: "/api/scraper/chunk",
        body: { chunkId: chunk.id },
      });
    }

    return { totalChunks: combinations.length };
  } catch (err: any) {
    console.error(`[SCRAPER][${runId}] startChunkedRun failed`, err);
    await markRunFailed(runId, err.message ?? "startChunkedRun failed");
    throw err;
  }
}

// Phase 2: fetch leads for a single combination. Runs inside a QStash-dispatched
// invocation. Small scope → well under 60s. After marking the chunk done, we
// atomically increment the run's completedChunks counter and — if this was the
// last chunk — fire a single finalize job (guarded by a Redis NX lock so two
// chunks racing to completion can't double-fire).
export async function executeChunk(chunkId: string) {
  const [chunk] = await db
    .select()
    .from(scraperRunChunks)
    .where(eq(scraperRunChunks.id, chunkId))
    .limit(1);

  if (!chunk) {
    console.error(`[SCRAPER][chunk] not found: ${chunkId}`);
    return;
  }

  if (chunk.status === "done") {
    console.log(`[SCRAPER][chunk] already done, skipping: ${chunkId}`);
    return;
  }

  await db
    .update(scraperRunChunks)
    .set({ status: "running" })
    .where(eq(scraperRunChunks.id, chunkId));

  let leadsCount = 0;
  let errorMessage: string | null = null;

  try {
    const leads = await fetchFromGooglePlaces(chunk.combinationQuery, {
      maxPages: MAX_PAGES_PER_QUERY,
    });

    if (leads.length) {
      const tagged = leads.map((lead) => ({
        ...lead,
        source_query: chunk.combinationQuery,
      }));
      await saveRawLeads(chunk.runId, tagged);
      leadsCount = leads.length;
    }

    await db
      .update(scraperRunChunks)
      .set({
        status: "done",
        leadsCount,
        completedAt: new Date(),
      })
      .where(eq(scraperRunChunks.id, chunkId));

    console.log(
      `[SCRAPER][chunk] ${chunkId} done — ${leadsCount} leads for "${chunk.combinationQuery}"`,
    );
  } catch (err: any) {
    errorMessage = err.message ?? "chunk failed";
    await db
      .update(scraperRunChunks)
      .set({
        status: "failed",
        errorMessage,
        completedAt: new Date(),
      })
      .where(eq(scraperRunChunks.id, chunkId));

    console.error(`[SCRAPER][chunk] ${chunkId} failed`, err);
  }

  // Atomically bump completedChunks and check if we're last.
  const [updated] = await db
    .update(scrapeRuns)
    .set({ completedChunks: sql`${scrapeRuns.completedChunks} + 1` })
    .where(eq(scrapeRuns.id, chunk.runId))
    .returning({
      completed: scrapeRuns.completedChunks,
      total: scrapeRuns.totalChunks,
    });

  if (
    updated &&
    updated.completed !== null &&
    updated.total !== null &&
    updated.completed >= updated.total
  ) {
    // Belt-and-suspenders: Redis NX lock so two concurrent completers
    // can't both enqueue finalize.
    const claimed = await redis.set(
      `scraper:finalize-lock:${chunk.runId}`,
      "1",
      "EX",
      60 * 60,
      "NX",
    );
    if (claimed === "OK") {
      console.log(
        `[SCRAPER][${chunk.runId}] all chunks done, queueing finalize`,
      );
      await publishToPath({
        path: "/api/scraper/finalize",
        body: { runId: chunk.runId },
      });
    }
  }
}

// Phase 3: read all raw leads for this run, dedupe + normalize + save clean.
// Runs in its own QStash invocation. Even on Hobby (60s) this is fine because
// it's all DB I/O — no network fetching.
export async function finalizeChunkedRun(runId: string) {
  const startTime = Date.now();

  try {
    const rawRows = await db
      .select({ rawData: scraperRaw.rawData })
      .from(scraperRaw)
      .where(eq(scraperRaw.runId, runId));

    const allLeads = rawRows
      .map((r) => {
        try {
          return JSON.parse(r.rawData ?? "null");
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    if (!allLeads.length) {
      await markRunCompleted(runId, {
        total: 0,
        cleaned: 0,
        saved: 0,
        duplicates: 0,
        duration_ms: Date.now() - startTime,
      });
      return;
    }

    const result = await processLeads(allLeads);
    const uniqueLeads = result.cleaned.filter((l: any) => !l.duplicate_of);
    const duplicateLeads = result.cleaned.filter((l: any) => l.duplicate_of);

    const savedCount = await saveCleanLeads(uniqueLeads, runId);
    await saveDuplicateLeads(duplicateLeads);

    // Promote every unique lead with a valid phone into dealer_leads so it
    // shows up on the Leads page and becomes eligible for the AI dialer.
    // The dealer_leads.phone UNIQUE constraint de-dupes across past runs.
    const promotedCount = await promoteLeadsToDealerLeads(uniqueLeads);

    await markRunCompleted(runId, {
      total: allLeads.length,
      cleaned: result.cleaned.length,
      saved: savedCount,
      duplicates: result.duplicates,
      duration_ms: Date.now() - startTime,
    });

    console.log(
      `[SCRAPER][${runId}] finalized — ${allLeads.length} raw → ${savedCount} saved → ${promotedCount} promoted to dealer_leads in ${
        Date.now() - startTime
      }ms`,
    );
  } catch (err: any) {
    console.error(`[SCRAPER][${runId}] finalize failed`, err);
    await markRunFailed(runId, err.message ?? "finalize failed");
  }
}

// Fallback reconciliation: if some chunks were orphaned (QStash delivery
// failure, handler crash before counter bump), the run could stall short of
// total. This can be called from a cron/cleanup to sweep stalled runs.
export async function reconcileRun(runId: string) {
  const pendingCount = await db
    .select({ count: sql<number>`count(*)` })
    .from(scraperRunChunks)
    .where(
      and(
        eq(scraperRunChunks.runId, runId),
        sql`${scraperRunChunks.status} IN ('pending','running')`,
      ),
    )
    .then((res) => Number(res[0]?.count ?? 0));

  if (pendingCount > 0) {
    console.log(
      `[SCRAPER][${runId}] reconcile: ${pendingCount} chunks still pending/running`,
    );
    return { finalized: false, pendingCount };
  }

  const claimed = await redis.set(
    `scraper:finalize-lock:${runId}`,
    "1",
    "EX",
    60 * 60,
    "NX",
  );
  if (claimed !== "OK") {
    return { finalized: false, alreadyClaimed: true };
  }

  await publishToPath({
    path: "/api/scraper/finalize",
    body: { runId },
  });

  return { finalized: true };
}

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
import {
  markRunCompleted,
  markRunFailed,
  markRunCancelled,
} from "./storage/runStore";
import { sanitizeDbError } from "@/lib/error-utils";
import { scraperRaw } from "@/lib/db/schema";
import { safeRedisLock } from "@/lib/queue/safeRedis";
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

    // Publish in parallel; record per-chunk publish results so we can mark
    // failed chunks immediately. Without this, a failed publish leaves the
    // chunk row stuck at "pending" and the run never finalizes.
    const publishResults = await Promise.allSettled(
      chunkRows.map((chunk) =>
        publishToPath({
          path: "/api/scraper/chunk",
          body: { chunkId: chunk.id },
        }),
      ),
    );

    const failedChunkIds: string[] = [];
    publishResults.forEach((res, idx) => {
      if (res.status === "rejected") {
        failedChunkIds.push(chunkRows[idx].id);
        console.error(
          `[SCRAPER][${runId}] publish failed for chunk ${chunkRows[idx].id}`,
          res.reason,
        );
      }
    });

    if (failedChunkIds.length === chunkRows.length) {
      // Every publish failed — the run cannot make progress. Fail it now
      // instead of waiting for the stuck-run reaper.
      await markRunFailed(
        runId,
        `QStash fan-out failed for all ${chunkRows.length} chunks. Check QSTASH_TOKEN, QSTASH_CURRENT_SIGNING_KEY, and the callback base URL (NEXT_PUBLIC_APP_URL or QSTASH_CALLBACK_BASE_URL).`,
      );
      return { totalChunks: combinations.length, failedPublishes: failedChunkIds.length };
    }

    if (failedChunkIds.length > 0) {
      // Mark partial publish failures as failed chunks so completedChunks
      // can still reach totalChunks and the run can finalize.
      const failedAt = new Date();
      for (const chunkId of failedChunkIds) {
        await db
          .update(scraperRunChunks)
          .set({
            status: "failed",
            errorMessage: "QStash publish failed",
            completedAt: failedAt,
          })
          .where(eq(scraperRunChunks.id, chunkId));
      }
      await db
        .update(scrapeRuns)
        .set({
          completedChunks: sql`${scrapeRuns.completedChunks} + ${failedChunkIds.length}`,
        })
        .where(eq(scrapeRuns.id, runId));
    }

    return {
      totalChunks: combinations.length,
      failedPublishes: failedChunkIds.length,
    };
  } catch (err: any) {
    console.error(`[SCRAPER][${runId}] startChunkedRun failed`, err);
    await markRunFailed(runId, sanitizeDbError(err) || "startChunkedRun failed");
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

  if (chunk.status === "done" || chunk.status === "cancelled") {
    console.log(
      `[SCRAPER][chunk] already terminal (${chunk.status}), skipping: ${chunkId}`,
    );
    return;
  }

  // If the parent run was cancelled while this chunk was queued in QStash,
  // skip the expensive Google Places fetch and mark the chunk cancelled.
  // The cancel handler will have already finalized; we just no-op.
  const [parentRun] = await db
    .select({ status: scrapeRuns.status })
    .from(scrapeRuns)
    .where(eq(scrapeRuns.id, chunk.runId))
    .limit(1);

  if (
    parentRun &&
    (parentRun.status === "cancelled" ||
      parentRun.status === "cancelling" ||
      parentRun.status === "failed")
  ) {
    await db
      .update(scraperRunChunks)
      .set({
        status: "cancelled",
        completedAt: new Date(),
        errorMessage: `run ${parentRun.status}`,
      })
      .where(eq(scraperRunChunks.id, chunkId));
    console.log(
      `[SCRAPER][chunk] parent run ${parentRun.status}, skipping chunk ${chunkId}`,
    );
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
    errorMessage = sanitizeDbError(err) || "chunk failed";
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
    // can't both enqueue finalize. If Redis is unavailable (quota
    // exhausted, network blip), fall through to enqueue anyway —
    // finalize is idempotent at the DB level, so a duplicate enqueue
    // is far better than silently dropping the finalize.
    // safeRedisLock encodes the "proceed without lock on Redis failure"
    // intent explicitly: when Redis is degraded (quota exhausted), it
    // returns claimed=true so the scraper still enqueues finalize. The
    // finalize step is idempotent at the DB level, so a duplicate is
    // strictly better than a dropped finalize.
    const { claimed } = await safeRedisLock(
      `scraper:finalize-lock:${chunk.runId}`,
      60 * 60,
      "scraper:finalize-lock",
    );

    if (claimed) {
      console.log(
        `[SCRAPER][${chunk.runId}] all chunks done, queueing finalize`,
      );
      // Try QStash first; if the publish fails (quota, callback URL not
      // reachable, network blip), run finalize inline as a fallback. It's
      // pure DB work and fits well inside the 60s budget. Without this
      // fallback, a publish failure leaves the run stuck at status='running'
      // with all chunks done — exactly the symptom we keep hitting.
      try {
        await publishToPath({
          path: "/api/scraper/finalize",
          body: { runId: chunk.runId },
        });
      } catch (publishErr) {
        console.warn(
          `[SCRAPER][${chunk.runId}] QStash finalize publish failed, running inline:`,
          publishErr,
        );
        await finalizeChunkedRun(chunk.runId);
      }
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
    await markRunFailed(runId, sanitizeDbError(err) || "finalize failed");
  }
}

// User-initiated cancel. Mark the run as 'cancelling' (so in-flight chunks
// short-circuit), abandon any pending chunks, then process whatever raw
// leads were already fetched and persist them. Mirrors finalize but ends
// in status='cancelled' instead of 'completed'.
export async function cancelChunkedRun(runId: string) {
  const startTime = Date.now();

  // Idempotency guard — refuse to cancel terminal runs.
  const [run] = await db
    .select({ status: scrapeRuns.status, startedAt: scrapeRuns.startedAt })
    .from(scrapeRuns)
    .where(eq(scrapeRuns.id, runId))
    .limit(1);

  if (!run) {
    throw new Error("Run not found");
  }
  if (
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "cancelled"
  ) {
    return { alreadyTerminal: true, status: run.status };
  }

  // 1) Flip the run flag first so any chunk that QStash delivers from now on
  //    will see 'cancelling' and short-circuit before fetching.
  await db
    .update(scrapeRuns)
    .set({ status: "cancelling" })
    .where(eq(scrapeRuns.id, runId));

  // 2) Mark any pending/running chunks as cancelled so the run's chunk
  //    accounting reaches its total.
  await db
    .update(scraperRunChunks)
    .set({
      status: "cancelled",
      completedAt: new Date(),
      errorMessage: "cancelled by user",
    })
    .where(
      and(
        eq(scraperRunChunks.runId, runId),
        sql`${scraperRunChunks.status} IN ('pending','running')`,
      ),
    );

  // 3) Process & save whatever raw leads we already collected. Same logic
  //    as finalize, but final status is 'cancelled'.
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

    let savedCount = 0;
    let cleanedCount = 0;
    let duplicates = 0;
    let promotedCount = 0;

    if (allLeads.length) {
      const result = await processLeads(allLeads);
      const uniqueLeads = result.cleaned.filter((l: any) => !l.duplicate_of);
      const duplicateLeads = result.cleaned.filter((l: any) => l.duplicate_of);

      savedCount = await saveCleanLeads(uniqueLeads, runId);
      await saveDuplicateLeads(duplicateLeads);
      promotedCount = await promoteLeadsToDealerLeads(uniqueLeads);

      cleanedCount = result.cleaned.length;
      duplicates = result.duplicates;
    }

    await markRunCancelled(runId, {
      total: allLeads.length,
      cleaned: cleanedCount,
      saved: savedCount,
      duplicates,
      duration_ms: Date.now() - startTime,
    });

    console.log(
      `[SCRAPER][${runId}] cancelled — saved ${savedCount} leads (${promotedCount} promoted) from ${allLeads.length} raw in ${Date.now() - startTime}ms`,
    );

    return {
      cancelled: true,
      saved: savedCount,
      total: allLeads.length,
    };
  } catch (err: any) {
    console.error(`[SCRAPER][${runId}] cancel finalize failed`, err);
    // Still mark as cancelled so the run doesn't stay stuck — but record the error.
    await markRunFailed(
      runId,
      `Cancelled, but failed to save partial leads: ${sanitizeDbError(err)}`,
    );
    throw err;
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

  const { claimed } = await safeRedisLock(
    `scraper:finalize-lock:${runId}`,
    60 * 60,
    "scraper:finalize-lock",
  );

  if (!claimed) {
    return { finalized: false, alreadyClaimed: true };
  }

  try {
    await publishToPath({
      path: "/api/scraper/finalize",
      body: { runId },
    });
  } catch (publishErr) {
    console.warn(
      `[SCRAPER][${runId}] reconcile: QStash finalize publish failed, running inline:`,
      publishErr,
    );
    await finalizeChunkedRun(runId);
  }

  return { finalized: true };
}

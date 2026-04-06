import { generateQueries, generateCitiesForQuery } from "./query/generateQueries";
import { getCachedQueries, setCachedQueries } from "./query/queryCache";
import { fetchFromGooglePlaces } from "./query/sources/googlePlaces";
import { processLeads } from "./processing";
import { saveRawLeads } from "./storage/rawStore";
import { saveCleanLeads } from "./storage/leadStore";
import { saveDuplicateLeads } from "./storage/duplicateStore";
import { markRunCompleted, markRunFailed } from "./storage/runStore";

const CONCURRENT_QUERIES = 3;
const MAX_PAGES_PER_QUERY = 3;

function normalizeQuery(q: string) {
  return q
    .replace(/\b3w\b/gi, "e rickshaw")
    .replace(/\b3 wheeler\b/gi, "e rickshaw")
    .trim();
}

async function runInBatches<T>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<any[]>,
): Promise<any[]> {
  const results: any[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);

    const batchResults = await Promise.allSettled(batch.map(fn));

    for (const r of batchResults) {
      if (r.status === "fulfilled" && Array.isArray(r.value)) {
        results.push(...r.value);
      }
    }

    if (i + batchSize < items.length) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return results;
}

export async function runDealerScraper(runId: string, baseQuery: string) {
  const startTime = Date.now();

  try {
    console.log(`[SCRAPER][${runId}] started for: "${baseQuery}"`);

    // ── Step 1: Generate query variations (AI, cached) ─────────────────────
    let queryVariations = getCachedQueries(baseQuery);

    if (!queryVariations) {
      queryVariations = await generateQueries(baseQuery);
      setCachedQueries(baseQuery, queryVariations);
    }

    queryVariations = [...new Set(queryVariations.map(normalizeQuery))].slice(0, 15);
    console.log(`[SCRAPER][${runId}] query variations: ${queryVariations.length}`);

    // ── Step 2: Generate relevant cities dynamically (AI) ──────────────────
    const cities = await generateCitiesForQuery(baseQuery);
    console.log(`[SCRAPER][${runId}] cities: ${cities.length}`, cities);

    // ── Step 3: Build all query + city combinations ────────────────────────
    const allCombinations: string[] = [];

    for (const variation of queryVariations) {
      for (const city of cities) {
        allCombinations.push(`${variation} in ${city}`);
      }
    }

    console.log(`[SCRAPER][${runId}] total combinations: ${allCombinations.length}`);

    // ── Step 4: Fetch leads for all combinations in batches ────────────────
    const allLeads: any[] = [];

    await runInBatches(
      allCombinations,
      CONCURRENT_QUERIES,
      async (query): Promise<any[]> => {
        try {
          const leads = await fetchFromGooglePlaces(query, {
            maxPages: MAX_PAGES_PER_QUERY,
          });

          const tagged = leads.map((lead) => ({
            ...lead,
            source_query: query,
          }));

          allLeads.push(...tagged);

          console.log(`[SCRAPER][${runId}] "${query}" → ${leads.length} leads`);

          return tagged;
        } catch (err) {
          console.error(`[SCRAPER][${runId}] failed: "${query}"`, err);
          return [];
        }
      },
    );

    console.log(`[SCRAPER][${runId}] total raw leads: ${allLeads.length}`);

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

    // ── Step 5: Save raw leads ─────────────────────────────────────────────
    await saveRawLeads(runId, allLeads);

    // ── Step 6: Process (normalize + filter + dedupe) ──────────────────────
    const result = await processLeads(allLeads);

    const uniqueLeads = result.cleaned.filter((l) => !l.duplicate_of);
    const duplicateLeads = result.cleaned.filter((l) => l.duplicate_of);

    console.log(
      `[SCRAPER][${runId}] unique: ${uniqueLeads.length}, dupes: ${duplicateLeads.length}`,
    );

    // ── Step 7: Save to DB ─────────────────────────────────────────────────
    const savedCount = await saveCleanLeads(uniqueLeads, runId); 
    await saveDuplicateLeads(duplicateLeads);

    console.log(`[SCRAPER][${runId}] saved: ${savedCount}`);

    // ── Step 8: Mark run completed ─────────────────────────────────────────
    await markRunCompleted(runId, {
      total: allLeads.length,
      cleaned: result.cleaned.length,
      saved: savedCount,
      duplicates: result.duplicates,
      duration_ms: Date.now() - startTime,
    });

    console.log(`[SCRAPER][${runId}] done in ${Date.now() - startTime}ms`);
  } catch (err: any) {
    console.error(`[SCRAPER][${runId}] failed`, err);
    await markRunFailed(runId, err.message);
  }
}
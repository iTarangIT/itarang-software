import { generateQueries } from "./query/generateQueries";
import { getCachedQueries, setCachedQueries } from "./query/queryCache";

import { fetchLeadsFromSources } from "./query/sources";
import { processLeads } from "./processing";

import { saveRawLeads } from "./storage/rawStore";
import { saveCleanLeads } from "./storage/leadStore";
import { saveDuplicateLeads } from "./storage/duplicateStore";
import { markRunCompleted, markRunFailed } from "./storage/runStore";

function normalizeQuery(q: string) {
  return q
    .replace(/\b3w\b/gi, "e rickshaw")
    .replace(/\b3 wheeler\b/gi, "e rickshaw")
    .trim();
}

export async function runDealerScraper(runId: string, baseQuery: string) {
  const startTime = Date.now();

  try {
    console.log(`[SCRAPER][${runId}] started`);

    let queries = getCachedQueries(baseQuery);

    if (!queries) {
      const aiQueries = await generateQueries(baseQuery);
      queries = aiQueries;
      setCachedQueries(baseQuery, queries);
    }

    queries = queries.map(normalizeQuery).filter(Boolean);

    const finalQueries = [...new Set(queries)].slice(0, 5);

    console.log(`[SCRAPER][${runId}] final queries:`, finalQueries);

    let allLeads: any[] = [];

    await Promise.all(
      finalQueries.map(async (query) => {
        try {
          const leads = await fetchLeadsFromSources([query]);

          const tagged = leads.map((lead: any) => ({
            ...lead,
            source_query: query,
          }));

          allLeads.push(...tagged);

          console.log(
            `[SCRAPER][${runId}] fetched ${leads.length} leads for: ${query}`,
          );
        } catch (err) {
          console.error(`[SCRAPER][${runId}] failed query: ${query}`, err);
        }
      }),
    );

    console.log(`[SCRAPER][${runId}] total leads fetched:`, allLeads.length);

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

    await saveRawLeads(runId, allLeads);

    const result = await processLeads(allLeads);

    console.log(`[SCRAPER][${runId}] cleaned:`, result.cleaned.length);
    console.log(`[SCRAPER][${runId}] duplicates:`, result.duplicates);

    const uniqueLeads = result.cleaned.filter((lead) => !lead.duplicate_of);

    const duplicateLeads = result.cleaned.filter((lead) => lead.duplicate_of);

    const savedCount = await saveCleanLeads(uniqueLeads);
    const duplicateSavedCount = await saveDuplicateLeads(duplicateLeads);

    console.log("Saving unique leads:", uniqueLeads.length);
    console.log("Saving duplicate leads:", duplicateLeads.length);

    console.log("Saved unique leads:", savedCount);
    console.log("Saved duplicate leads:", duplicateSavedCount);

    await markRunCompleted(runId, {
      total: allLeads.length,
      cleaned: result.cleaned.length,
      saved: savedCount,
      duplicates: result.duplicates,
      duration_ms: Date.now() - startTime,
    });

    console.log(`[SCRAPER][${runId}] completed in ${Date.now() - startTime}ms`);
  } catch (err: any) {
    console.error(`[SCRAPER][${runId}] failed`, err);

    await markRunFailed(runId, err.message);
  }
}

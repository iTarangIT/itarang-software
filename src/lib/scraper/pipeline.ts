import { generateQueries } from "./query/generateQueries";
import { getCachedQueries, setCachedQueries } from "./query/queryCache";

import { fetchLeadsFromSources } from "./query/sources";
import { processLeads } from "./processing";

import { saveRawLeads } from "./storage/rawStore";
import { saveCleanLeads } from "./storage/leadStore";
import { markRunCompleted, markRunFailed } from "./storage/runStore";

export async function runDealerScraper(runId: string, baseQuery: string) {
  try {
    console.log(`[SCRAPER][${runId}] started`);

    let queries = getCachedQueries(baseQuery);

    if (!queries) {
      const aiQueries = await generateQueries(baseQuery);
      queries = aiQueries;
      setCachedQueries(baseQuery, queries);
    }
    queries = queries.map((q) =>
      q
        .replace(/\b3w\b/gi, "e rickshaw")
        .replace(/\b3 wheeler\b/gi, "e rickshaw"),
    );

    const finalQueries = queries
      .map((q) => q.trim())
      .filter(Boolean)
      .slice(0, 5);

    console.log(`[SCRAPER][${runId}] final queries:`, finalQueries);

    const leads = await fetchLeadsFromSources(finalQueries);

    console.log(`[SCRAPER][${runId}] leads fetched:`, leads.length);

    await saveRawLeads(runId, leads);

    const result = await processLeads(leads);

    await saveCleanLeads(result.cleaned);

    await markRunCompleted(runId, {
      total: result.total,
      saved: result.saved,
      duplicates: result.duplicates,
    });

    console.log(`[SCRAPER][${runId}] completed`);
  } catch (err: any) {
    console.error(`[SCRAPER][${runId}] failed`, err);

    await markRunFailed(runId, err.message);
  }
}

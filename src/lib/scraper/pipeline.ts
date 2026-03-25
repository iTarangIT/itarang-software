// lib/scraper/pipeline.ts

import { db } from "@/lib/db";
import { scrapeRuns } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

import { generateQueries } from "./query/generateQueries";
import { expandQueries } from "./query/expandQueries";
import { getCachedQueries, setCachedQueries } from "./query/queryCache";

export async function runDealerScraper(runId: string) {
  try {
    console.log(`[SCRAPER][${runId}] started`);

    const baseQuery = "EV battery dealers";

    let queries = getCachedQueries(baseQuery);

    if (!queries) {
      const baseQueries = await generateQueries(baseQuery);
      queries = expandQueries(baseQueries);

      setCachedQueries(baseQuery, queries);
    }

    console.log(`[SCRAPER][${runId}] queries:`, queries);

    const leads = queries.map((q, i) => ({
      name: `Dealer ${i + 1}`,
      phone: `99999999${i}`,
      query: q,
    }));

    const totalFound = leads.length;

    await db
      .update(scrapeRuns)
      .set({
        status: "completed",
        completedAt: new Date(),
        totalFound,
        newLeadsSaved: totalFound,
        duplicatesSkipped: 0,
      })
      .where(eq(scrapeRuns.id, runId));

    console.log(`[SCRAPER][${runId}] completed`);
  } catch (err: any) {
    console.error(`[SCRAPER][${runId}] failed`, err);

    await db
      .update(scrapeRuns)
      .set({
        status: "failed",
        errorMessage: err.message,
        completedAt: new Date(),
      })
      .where(eq(scrapeRuns.id, runId));
  }
}

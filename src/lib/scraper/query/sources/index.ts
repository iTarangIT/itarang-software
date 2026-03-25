import { fetchFromApify } from "./apify";
import { enrichWithFirecrawl } from "./firecrawl";

export async function fetchLeadsFromSources(queries: string[]) {
  try {
    const limitedQueries = queries.slice(0, 3);

    const apifyLeads = await fetchFromApify(limitedQueries);

    console.log("[SOURCES] Apify leads:", apifyLeads.length);

    if (!apifyLeads.length) return [];

    const uniqueLeads = Array.from(
      new Map(apifyLeads.map((l) => [l.website, l])).values(),
    );

    const topLeads = uniqueLeads.slice(0, 10);

    console.log("[SOURCES] Enriching:", topLeads.length);

    const enriched = await enrichWithFirecrawl(topLeads);

    const finalLeads = [...enriched, ...uniqueLeads.slice(10)];

    return finalLeads;
  } catch (err) {
    console.error("[SOURCES] Failed:", err);
    return [];
  }
}

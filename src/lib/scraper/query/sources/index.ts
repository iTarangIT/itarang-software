import { fetchFromApify } from "./apify";
import { enrichWithFirecrawl } from "./firecrawl";
import { fetchFromGooglePlaces } from "./googlePlaces";

export async function fetchLeadsFromSources(queries: string[]) {
  try {
    const limitedQueries = queries.slice(0, 3);

    let apifyLeads: any[] = [];
    let googleLeads: any[] = [];

    await Promise.all([
      (async () => {
        try {
          apifyLeads = await fetchFromApify(limitedQueries);
        } catch {}
      })(),
      (async () => {
        try {
          for (const query of limitedQueries) {
            const res = await fetchFromGooglePlaces(query);
            googleLeads.push(...res);
          }
        } catch {}
      })(),
    ]);

    const leads = [...apifyLeads, ...googleLeads];

    if (!leads.length) return [];

    const uniqueLeads = Array.from(
      new Map(
        leads.map((l) => {
          const name = (l.name || "").trim().toLowerCase();
          const address = (l.address || "").trim().toLowerCase();
          const phone = (l.phone || "").replace(/\D/g, "");

          const key = phone || `${name}-${address}`;

          return [key, l];
        }),
      ).values(),
    );
    const topLeads = uniqueLeads.slice(0, 10);

    let enriched: any[] = [];

    try {
      enriched = await enrichWithFirecrawl(topLeads);
    } catch {}

    const finalLeads = [...enriched, ...uniqueLeads.slice(10)];

    return finalLeads;
  } catch {
    return [];
  }
}

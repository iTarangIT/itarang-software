// lib/scraper/sources/apify.ts

export async function fetchFromApify(queries: string[]) {
  const results: any[] = [];

  const APIFY_TOKEN = process.env.APIFY_API_TOKEN;

  for (const query of queries) {
    try {
      console.log("[APIFY] Running for:", query);

      const runRes = await fetch(
        `https://api.apify.com/v2/acts/compass~crawler-google-places/runs?token=${APIFY_TOKEN}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            searchStringsArray: [query],
            maxCrawledPlaces: 20,
          }),
        },
      );

      const runData = await runRes.json();

      if (!runData?.data?.defaultDatasetId) {
        console.error("[APIFY ERROR] Invalid response:", runData);
        continue;
      }

      const datasetId = runData.data.defaultDatasetId;

      await new Promise((res) => setTimeout(res, 5000));

      const dataRes = await fetch(
        `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}`,
      );

      const items = await dataRes.json();

      const formatted = items.map((item: any) => ({
        name: item.title,
        phone: item.phone,
        address: item.address,
        website: item.website,
        source: "scraper",
        query,
      }));

      results.push(...formatted);
    } catch (err) {
      console.error("[APIFY ERROR]", err);
    }
  }

  return results;
}

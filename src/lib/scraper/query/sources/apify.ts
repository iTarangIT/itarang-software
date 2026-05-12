// Apify "compass~crawler-google-places" actor wrapper. We use the
// synchronous run-sync-get-dataset-items endpoint so a single call kicks off
// the actor and returns the scraped items in one HTTP round-trip — much
// simpler than the old run + poll + fetch-dataset flow and a better fit for
// the per-chunk handler's 60s Vercel budget.

const ACTOR_ID = "compass~crawler-google-places";

// Cap the actor's wait so a slow scrape can't blow the chunk handler's
// 60s Vercel Hobby budget. 40s leaves ~20s for processing + DB writes.
const ACTOR_TIMEOUT_SECONDS = 40;

// Belt-and-suspenders client timeout — Apify should return by ACTOR_TIMEOUT_SECONDS,
// but a stalled TCP socket would still leak the chunk's budget without this.
const FETCH_TIMEOUT_MS = (ACTOR_TIMEOUT_SECONDS + 5) * 1000;

export interface ApifyPlaceResult {
  placeId: string | null;
  name: string;
  address: string;
  rating: number | null;
  phone: string | null;
  website: string | null;
  source: "apify";
}

export async function fetchFromApifySingle(
  query: string,
  { maxResults = 20 }: { maxResults?: number } = {},
): Promise<ApifyPlaceResult[]> {
  const start = Date.now();
  console.log(`[APIFY] start "${query}" (maxResults=${maxResults})`);

  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    console.error("[APIFY] missing APIFY_API_TOKEN — skipping");
    throw new Error("Missing APIFY_API_TOKEN environment variable");
  }

  const url = `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${token}&timeout=${ACTOR_TIMEOUT_SECONDS}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        searchStringsArray: [query],
        maxCrawledPlacesPerSearch: maxResults,
        language: "en",
      }),
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      // The Apify actor may have already started — Apify charges per started
      // run regardless of whether we received the response. Log a breadcrumb
      // so spend anomalies are diagnosable from Vercel logs alone.
      console.error(
        `[APIFY] aborted "${query}" after ${Date.now() - start}ms — actor may have charged a run`,
      );
      throw new Error(`Apify request timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    console.error(`[APIFY] network error "${query}": ${err?.message ?? err}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(
      `[APIFY] HTTP ${res.status} for "${query}": ${body?.slice(0, 200) || res.statusText}`,
    );
    throw new Error(`Apify request failed: ${res.status} — ${body || res.statusText}`);
  }

  const items: any[] = await res.json();
  console.log(
    `[APIFY] done "${query}" → ${items.length} items in ${Date.now() - start}ms`,
  );

  return items.map((item) => ({
    placeId: item.placeId ?? item.cid ?? null,
    name: item.title ?? item.name ?? "",
    address: item.address ?? "",
    rating: typeof item.totalScore === "number" ? item.totalScore : null,
    phone: item.phone ?? item.phoneUnformatted ?? null,
    website: item.website ?? null,
    source: "apify" as const,
  }));
}

// Backwards-compatible multi-query wrapper kept for sources/index.ts. New
// callers should prefer fetchFromApifySingle.
export async function fetchFromApify(queries: string[]) {
  const results: ApifyPlaceResult[] = [];
  for (const query of queries) {
    try {
      const items = await fetchFromApifySingle(query);
      results.push(...items);
    } catch (err) {
      console.error("[APIFY ERROR]", err);
    }
  }
  return results;
}

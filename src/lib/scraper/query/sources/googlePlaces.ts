import { retryFetch, parseRetryAfter, type RetryableHttpError } from "./retry";

// Lazy: don't throw at module load. We let Apify run even when Google Places
// is unconfigured, and surface a per-source error from the chunk pipeline.
function getApiKey(): string {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) {
    throw new Error("Missing GOOGLE_PLACES_API_KEY environment variable");
  }
  return key;
}

// Hard cap per HTTP call. The chunk handler has a 60s Vercel budget covering
// both sources + dedupe + DB writes, so we keep each page request well below it.
const FETCH_TIMEOUT_MS = 20_000;

// Retry on transient errors only. 403/401/400 are config bugs (no enable, bad
// key, malformed request) — retrying just burns budget. AbortError is cheap to
// retry on Google's per-page calls.
function isGoogleRetryable(
  err: unknown,
): boolean | { retryAfterMs: number } {
  const e = err as RetryableHttpError;
  if (e?.name === "AbortError") return true;
  if (e?.status === 429) {
    const wait = e.retryAfterMs ?? 0;
    return wait > 0 ? { retryAfterMs: Math.min(wait, 5_000) } : true;
  }
  if (typeof e?.status === "number" && e.status >= 500 && e.status < 600) {
    return true;
  }
  return false;
}

export interface PlaceResult {
  placeId: string;
  name: string;
  address: string;
  rating: number | null;
  phone: string | null;
  website: string | null;
  source: "google_places";
}

async function fetchPage(
  query: string,
  pageToken?: string,
): Promise<{ places: PlaceResult[]; nextPageToken?: string }> {
  const body: any = { textQuery: query, maxResultCount: 20 };
  if (pageToken) body.pageToken = pageToken;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": getApiKey(),
        "X-Goog-FieldMask": [
          "places.id",
          "places.displayName",
          "places.formattedAddress",
          "places.rating",
          "places.nationalPhoneNumber",
          "places.websiteUri",
          "nextPageToken",
        ].join(","),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      const abortErr: RetryableHttpError = Object.assign(
        new Error(`Google Places request timed out after ${FETCH_TIMEOUT_MS}ms`),
        { name: "AbortError" },
      );
      throw abortErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const httpErr: RetryableHttpError = Object.assign(
      new Error(
        `Google Places request failed: ${res.status} — ${body?.error?.message ?? res.statusText}`,
      ),
      {
        status: res.status,
        retryAfterMs: parseRetryAfter(res.headers.get("Retry-After")),
      },
    );
    throw httpErr;
  }

  const data = await res.json();

  const places = (data.places ?? []).map((place: any) => ({
    placeId: place.id,
    name: place.displayName?.text ?? place.displayName ?? "",
    address: place.formattedAddress ?? "",
    rating: place.rating ?? null,
    phone: place.nationalPhoneNumber ?? null,
    website: place.websiteUri ?? null,
    source: "google_places" as const,
  }));

  return { places, nextPageToken: data.nextPageToken };
}

// Fetch all pages for a query (up to maxPages to avoid runaway costs)
export async function fetchFromGooglePlaces(
  query: string,
  { maxPages = 3 }: { maxPages?: number } = {},
): Promise<PlaceResult[]> {
  const start = Date.now();
  console.log(`[GOOGLE_PLACES] start "${query}" (maxPages=${maxPages})`);

  const allPlaces: PlaceResult[] = [];
  let pageToken: string | undefined;
  let page = 0;

  try {
    do {
      const { places, nextPageToken } = await retryFetch(
        () => fetchPage(query, pageToken),
        {
          attempts: 2,
          baseDelayMs: 1_000,
          label: `google_places p${page + 1}`,
          isRetryable: isGoogleRetryable,
        },
      );
      console.log(
        `[GOOGLE_PLACES] page ${page + 1} for "${query}" → ${places.length} places`,
      );
      allPlaces.push(...places);
      pageToken = nextPageToken;
      page++;

      // Small delay between paginated requests to respect rate limits
      if (nextPageToken) await new Promise((r) => setTimeout(r, 500));
    } while (pageToken && page < maxPages);

    console.log(
      `[GOOGLE_PLACES] done "${query}" → ${allPlaces.length} places in ${Date.now() - start}ms`,
    );
    return allPlaces;
  } catch (err: any) {
    console.error(
      `[GOOGLE_PLACES] failed "${query}" after ${Date.now() - start}ms: ${err?.message ?? err}`,
    );
    throw err;
  }
}

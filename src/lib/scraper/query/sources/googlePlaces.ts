const API_KEY = process.env.GOOGLE_PLACES_API_KEY;

if (!API_KEY) {
  throw new Error("Missing GOOGLE_PLACES_API_KEY environment variable");
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

  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": API_KEY!,
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
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      `Google Places request failed: ${res.status} — ${err?.error?.message ?? res.statusText}`,
    );
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
  const allPlaces: PlaceResult[] = [];
  let pageToken: string | undefined;
  let page = 0;

  do {
    const { places, nextPageToken } = await fetchPage(query, pageToken);
    allPlaces.push(...places);
    pageToken = nextPageToken;
    page++;

    // Small delay between paginated requests to respect rate limits
    if (nextPageToken) await new Promise((r) => setTimeout(r, 500));
  } while (pageToken && page < maxPages);

  return allPlaces;
}
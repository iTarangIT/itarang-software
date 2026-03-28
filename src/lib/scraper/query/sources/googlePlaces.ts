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

// Places API (New) — Text Search
// Docs: https://developers.google.com/maps/documentation/places/web-service/text-search
export async function fetchFromGooglePlaces(
  query: string,
  { fetchDetails = false }: { fetchDetails?: boolean } = {},
): Promise<PlaceResult[]> {
  const res = await fetch(
    "https://places.googleapis.com/v1/places:searchText",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": API_KEY!,
        // Request only the fields you need — billed by field mask
        "X-Goog-FieldMask": [
          "places.id",
          "places.displayName",
          "places.formattedAddress",
          "places.rating",
          ...(fetchDetails
            ? ["places.nationalPhoneNumber", "places.websiteUri"]
            : []),
        ].join(","),
      },
      body: JSON.stringify({ textQuery: query }),
    },
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      `Google Places request failed: ${res.status} — ${err?.error?.message ?? res.statusText}`,
    );
  }

  const data = await res.json();

  return (data.places ?? []).map((place: any) => ({
    placeId: place.id,
    name: place.displayName?.text ?? place.displayName ?? "",
    address: place.formattedAddress ?? "",
    rating: place.rating ?? null,
    phone: place.nationalPhoneNumber ?? null,
    website: place.websiteUri ?? null,
    source: "google_places" as const,
  }));
}

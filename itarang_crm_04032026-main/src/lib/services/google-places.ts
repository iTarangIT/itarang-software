/**
 * Google Places API (New) - Text Search service.
 * Server-side only. Uses GOOGLE_PLACES_API_KEY env var.
 */

export interface PlaceResult {
    id: string;
    displayName?: { text: string; languageCode?: string };
    formattedAddress?: string;
    nationalPhoneNumber?: string;
    internationalPhoneNumber?: string;
    websiteUri?: string;
    googleMapsUri?: string;
    rating?: number;
    userRatingCount?: number;
    businessStatus?: string;
    types?: string[];
    location?: { latitude: number; longitude: number };
}

interface PlacesSearchResponse {
    places?: PlaceResult[];
    nextPageToken?: string;
}

interface SearchPlacesParams {
    textQuery: string;
    maxResultCount?: number;
    languageCode?: string;
}

const FIELD_MASK = [
    'places.id',
    'places.displayName',
    'places.formattedAddress',
    'places.nationalPhoneNumber',
    'places.internationalPhoneNumber',
    'places.websiteUri',
    'places.googleMapsUri',
    'places.rating',
    'places.userRatingCount',
    'places.businessStatus',
    'places.types',
    'places.location',
].join(',');

export async function searchPlaces(params: SearchPlacesParams): Promise<PlaceResult[]> {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) throw new Error('GOOGLE_PLACES_API_KEY not configured');

    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': FIELD_MASK,
        },
        body: JSON.stringify({
            textQuery: params.textQuery,
            maxResultCount: Math.min(params.maxResultCount || 20, 20), // API max is 20 per request
            languageCode: params.languageCode || 'en',
        }),
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Google Places API error ${res.status}: ${errorText}`);
    }

    const data: PlacesSearchResponse = await res.json();
    return data.places || [];
}

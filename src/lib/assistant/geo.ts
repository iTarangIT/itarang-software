// "How far was the rep from the shop?" for a visit's location pin.
//
// The lead has no coordinates, only area / city / pincode / state, so the shop
// is geocoded: Google Geocoding when a key allows it, else OpenStreetMap's
// Nominatim (free, 1 request/second, needs a real User-Agent). Distance is
// SUPPORTING evidence — it is shown and recorded, never blocks a visit — so any
// failure is just "not mapped". Results are cached per address for the life of
// the process: a lead's address rarely changes and Nominatim asks for caching.

/** Beyond this, the card and the visit remarks say how far. */
export const FAR_FROM_SHOP_METERS = 1000;

/** Great-circle distance in metres (haversine). */
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6_371_000;
    const rad = (d: number) => (d * Math.PI) / 180;
    const dLat = rad(lat2 - lat1);
    const dLng = rad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

export type ShopAddress = { area?: string | null; city?: string | null; state?: string | null; pincode?: string | null };

/** "Hadapsar, Pune, 411013, Maharashtra, India" — or null when there is nothing to find. */
export function addressQuery(a: ShopAddress): string | null {
    const parts = [a.area, a.city, a.pincode, a.state].map((p) => p?.trim()).filter(Boolean) as string[];
    // A state alone would put the "shop" in the middle of a state.
    if (!a.city?.trim() && !a.pincode?.trim()) return null;
    return [...parts, "India"].join(", ");
}

type Point = { lat: number; lng: number; precision: "street" | "area" | "city" };
const cache = new Map<string, Point | null>();

async function google(q: string, key: string, fetchImpl: typeof fetch): Promise<Point | null> {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&region=in&key=${key}`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(6000) });
    const j = (await res.json().catch(() => null)) as {
        status?: string;
        results?: { geometry?: { location?: { lat: number; lng: number }; location_type?: string } }[];
    } | null;
    // REQUEST_DENIED = the Geocoding API is not enabled on this key → caller falls back.
    if (j?.status !== "OK") throw new Error(`google_geocode_${j?.status ?? res.status}`);
    const g = j.results?.[0]?.geometry;
    if (!g?.location) return null;
    return { lat: g.location.lat, lng: g.location.lng, precision: g.location_type === "ROOFTOP" ? "street" : "area" };
}

async function nominatim(q: string, fetchImpl: typeof fetch): Promise<Point | null> {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=in&q=${encodeURIComponent(q)}`;
    const res = await fetchImpl(url, {
        headers: { "User-Agent": "iTarang-CRM/1.0 (it@itarang.com)", "Accept-Language": "en" },
        signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`nominatim_http_${res.status}`);
    const rows = (await res.json().catch(() => [])) as { lat: string; lon: string; addresstype?: string }[];
    const r = rows[0];
    if (!r) return null;
    const cityLevel = ["city", "town", "state_district", "county", "state"].includes(r.addresstype ?? "");
    return { lat: Number(r.lat), lng: Number(r.lon), precision: cityLevel ? "city" : "area" };
}

/** The shop's approximate position, or null ("not mapped"). Never throws. */
export async function geocodeShop(
    a: ShopAddress,
    opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<Point | null> {
    const q = addressQuery(a);
    if (!q) return null;
    if (cache.has(q)) return cache.get(q)!;
    const env = opts.env ?? process.env;
    const fetchImpl = opts.fetchImpl ?? fetch;
    const key = env.GOOGLE_GEOCODING_API_KEY || env.GOOGLE_MAPS_API_KEY || env.GOOGLE_PLACES_API_KEY;
    let point: Point | null = null;
    try {
        if (key) {
            try {
                point = await google(q, key, fetchImpl);
            } catch {
                point = await nominatim(q, fetchImpl);
            }
        } else {
            point = await nominatim(q, fetchImpl);
        }
    } catch {
        return null; // a network failure is not cached: next time may work
    }
    cache.set(q, point);
    return point;
}

export type PinCheck =
    | { kind: "near" | "far"; meters: number; precision: Point["precision"] }
    | { kind: "unmapped" };

/**
 * Pin vs shop. City-level geocodes (only a city / pincode known) are too coarse
 * to call a pin "far" unless it is outside the city altogether (> 15 km).
 */
export async function checkPinAgainstShop(
    pin: { lat: number; lng: number },
    shop: ShopAddress,
    opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<PinCheck> {
    const p = await geocodeShop(shop, opts);
    if (!p) return { kind: "unmapped" };
    const meters = Math.round(haversineMeters(pin.lat, pin.lng, p.lat, p.lng));
    const limit = p.precision === "city" ? 15_000 : FAR_FROM_SHOP_METERS;
    return { kind: meters > limit ? "far" : "near", meters, precision: p.precision };
}

export function fmtDistance(m: number): string {
    return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`;
}

/** For tests. */
export function clearGeoCache(): void {
    cache.clear();
}

/**
 * One-off backfill: populate device_battery_map (AWS RDS) with a row per fleet
 * vehicle, tagged with State/City so the Intellicar Fleet Overview State/City
 * filters have data to work with.
 *
 * Why: the 295 batteries live only on the VPS telemetry DB (vehicle_state);
 * device_battery_map on the app DB is empty, so the location filter (which
 * bridges VPS→RDS via device_battery_map) has nothing to read. The only
 * per-battery location signal is the GPS on the VPS, so we reverse-geocode it.
 *
 * Reads : IOT_DATABASE_URL   (VPS vehicle_state: vehicleno, lat, lon)
 * Geocode: Google Geocoding API (GOOGLE_GEOCODING_API_KEY | GOOGLE_PLACES_API_KEY | GOOGLE_MAPS_API_KEY)
 * Writes: DATABASE_URL       (AWS RDS device_battery_map)
 *
 * Idempotent: each row's id is deterministic (`DBM-loc-<vehicleno>`), so re-runs
 * UPDATE the same rows. Undo with:  DELETE FROM device_battery_map WHERE id LIKE 'DBM-loc-%';
 *
 * Run:  npx tsx scripts/backfill-device-battery-map-location.ts
 *       (the SSH tunnel to the VPS must be up: ssh -N -L 5433:127.0.0.1:5433 root@72.61.246.37)
 */
import "dotenv/config";
import * as dotenv from "dotenv";
import postgres from "postgres";

dotenv.config({ path: ".env.local" });

const IOT_URL = process.env.IOT_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const GEO_KEY =
    process.env.GOOGLE_GEOCODING_API_KEY ||
    process.env.GOOGLE_PLACES_API_KEY ||
    process.env.GOOGLE_MAPS_API_KEY;

if (!IOT_URL) throw new Error("IOT_DATABASE_URL is not set (VPS telemetry source).");
if (!APP_URL) throw new Error("DATABASE_URL is not set (AWS RDS app DB).");
if (!GEO_KEY) throw new Error("No Google geocoding key (GOOGLE_PLACES_API_KEY / GOOGLE_GEOCODING_API_KEY / GOOGLE_MAPS_API_KEY).");

// sslmode from the IOT url drives ssl; sslmode=disable → false.
const iotSsl = /sslmode=disable/i.test(IOT_URL) ? false : "require";
const iot = postgres(IOT_URL, { ssl: iotSsl as false | "require", prepare: false, max: 2, connect_timeout: 10 });
const app = postgres(APP_URL, { ssl: { rejectUnauthorized: false }, prepare: false, max: 2, connect_timeout: 15, onnotice: () => {} });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Cache reverse-geocode results by ~1km cell (2 decimals) to cut API calls —
// state/city don't change within a cell.
const geoCache = new Map<string, { state: string | null; city: string | null }>();

// Google Geocoding must be explicitly enabled on the API project (separate from
// Places). If it returns REQUEST_DENIED we flip to the free OSM/Nominatim
// provider for the rest of the run so the backfill isn't blocked on a console
// change. `provider` also lets us pace correctly (Nominatim asks ≤1 req/sec).
let provider: "google" | "nominatim" = GEO_KEY ? "google" : "nominatim";

async function googleReverse(lat: number, lon: number) {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&region=in&key=${GEO_KEY}`;
    const data = (await (await fetch(url)).json()) as {
        status: string;
        error_message?: string;
        results?: Array<{ address_components: Array<{ long_name: string; types: string[] }> }>;
    };
    if (data.status === "REQUEST_DENIED") {
        console.warn(`  Google Geocoding denied (${data.error_message ?? ""}) — switching to OSM/Nominatim.`);
        provider = "nominatim";
        return null; // caller retries via nominatim
    }
    if (data.status === "OK" && data.results?.length) {
        const comps = data.results[0].address_components;
        const pick = (t: string) => comps.find((c) => c.types.includes(t))?.long_name ?? null;
        return {
            state: pick("administrative_area_level_1"),
            city: pick("locality") || pick("administrative_area_level_3") || pick("administrative_area_level_2"),
        };
    }
    return { state: null, city: null };
}

async function nominatimReverse(lat: number, lon: number) {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&addressdetails=1`;
    const data = (await (await fetch(url, { headers: { "User-Agent": "itarang-crm-backfill/1.0 (ops@itarang.com)" } })).json()) as {
        address?: Record<string, string>;
    };
    const a = data.address ?? {};
    return {
        state: a.state ?? a.region ?? null,
        city: a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? a.state_district ?? null,
    };
}

async function reverseGeocode(lat: number, lon: number): Promise<{ state: string | null; city: string | null }> {
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const cached = geoCache.get(key);
    if (cached) return cached;

    let result: { state: string | null; city: string | null } = { state: null, city: null };
    try {
        if (provider === "google") {
            const g = await googleReverse(lat, lon);
            result = g ?? (await nominatimReverse(lat, lon)); // null => Google denied, fall through
        } else {
            result = await nominatimReverse(lat, lon);
        }
    } catch (err) {
        console.warn(`  geocode failed for ${key}:`, err instanceof Error ? err.message : err);
    }
    geoCache.set(key, result);
    // Pace live calls only (cache hits above already returned). Nominatim's
    // usage policy is ≤1 req/sec; Google tolerates far more.
    await sleep(provider === "nominatim" ? 1100 : 60);
    return result;
}

async function main() {
    console.log("Reading fleet from VPS vehicle_state…");
    const vehicles = (await iot`
        SELECT vehicleno, lat, lon
        FROM vehicle_state
        WHERE lat IS NOT NULL AND lon IS NOT NULL
    `) as Array<{ vehicleno: string; lat: number; lon: number }>;
    console.log(`  ${vehicles.length} vehicles with GPS.`);

    let inserted = 0;
    let tagged = 0;
    let noGeo = 0;

    for (const v of vehicles) {
        const lat = Number(v.lat);
        const lon = Number(v.lon);
        const { state, city } = await reverseGeocode(lat, lon);
        if (!state && !city) noGeo++;
        else tagged++;

        const id = `DBM-loc-${v.vehicleno}`;
        await app`
            INSERT INTO device_battery_map (id, device_id, vehicle_number, state, city, status, created_at, updated_at)
            VALUES (${id}, ${v.vehicleno}, ${v.vehicleno}, ${state}, ${city}, 'active', now(), now())
            ON CONFLICT (id) DO UPDATE
            SET state = EXCLUDED.state, city = EXCLUDED.city, updated_at = now()
        `;
        inserted++;
        if (inserted % 25 === 0) console.log(`  …${inserted}/${vehicles.length}`);
    }

    console.log("\nDone.");
    console.log(`  rows upserted : ${inserted}`);
    console.log(`  with state/city: ${tagged}`);
    console.log(`  no geocode     : ${noGeo}`);
    console.log(`  unique cells   : ${geoCache.size}`);

    await iot.end({ timeout: 5 });
    await app.end({ timeout: 5 });
}

main().catch(async (err) => {
    console.error("Backfill failed:", err instanceof Error ? err.message : err);
    await iot.end({ timeout: 1 }).catch(() => {});
    await app.end({ timeout: 1 }).catch(() => {});
    process.exit(1);
});

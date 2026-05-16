/**
 * Central location normalization service.
 *
 * Replaces the hardcoded CITY_ALIASES / CITY_TO_STATE maps in
 * src/lib/scraper-enrichment.ts as the primary resolution path. The legacy
 * TS maps are kept as a last-resort fallback for environments where the
 * states/cities/city_aliases tables haven't been seeded yet (local dev
 * against an unmigrated DB).
 *
 * Resolution priority for normalizeRegion():
 *   1. Google Places `addressComponents` (when present) — strongest signal.
 *      If `components.city` + `components.state` resolve via the alias map
 *      to a canonical city in a canonical state, return that.
 *   2. Free-form rawCity → alias_lower → canonical city + its state.
 *   3. rawState alone, when no city resolves — state still useful for
 *      bucketing in the dialer tree.
 *   4. parseAddressComponents() regex fallback (existing scraper-enrichment).
 *   5. inferStateFromCity() fallback against the legacy CITY_TO_STATE map.
 *   6. Give up → { state: null, city: null, isValid: false }.
 *
 * Caching: all three tables are loaded once into in-memory Maps. Cache is
 * invalidated after CACHE_TTL_MS so an INSERT into `cities` (auto-grow at
 * promote time, see ensureCity()) is visible to subsequent calls.
 */

import { db } from "@/lib/db";
import { states, cities, cityAliases } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import {
  parseAddressComponents,
  normalizeCity as legacyNormalizeCity,
  normalizeState as legacyNormalizeState,
  inferStateFromCity as legacyInferStateFromCity,
  extractPincode,
  extractStateFromAddress,
} from "@/lib/scraper-enrichment";
import type { PlaceComponents } from "@/lib/scraper/query/sources/googlePlaces";

const CACHE_TTL_MS = 10 * 60 * 1000;

interface CityRow {
  id: string;
  name: string;
  state_code: string;
  source: string | null;
}

interface StateRow {
  code: string;
  name: string;
}

interface RegionMaps {
  // Lowercased state name → canonical state row.
  stateByLower: Map<string, StateRow>;
  // State code → canonical state row.
  stateByCode: Map<string, StateRow>;
  // Lowercased alias → canonical city row (via city_aliases.city_id).
  cityByAlias: Map<string, CityRow>;
  loadedAt: number;
}

let cache: RegionMaps | null = null;
let inflightLoad: Promise<RegionMaps> | null = null;

async function loadMaps(): Promise<RegionMaps> {
  const [stateRows, cityRows, aliasRows] = await Promise.all([
    db
      .select({ code: states.code, name: states.name })
      .from(states),
    db
      .select({
        id: cities.id,
        name: cities.name,
        state_code: cities.state_code,
        source: cities.source,
      })
      .from(cities),
    db
      .select({
        alias_lower: cityAliases.alias_lower,
        city_id: cityAliases.city_id,
      })
      .from(cityAliases),
  ]);

  const stateByLower = new Map<string, StateRow>();
  const stateByCode = new Map<string, StateRow>();
  for (const s of stateRows) {
    stateByLower.set(s.name.toLowerCase(), s);
    stateByCode.set(s.code, s);
  }

  const cityById = new Map<string, CityRow>();
  for (const c of cityRows) cityById.set(c.id, c);

  const cityByAlias = new Map<string, CityRow>();
  for (const a of aliasRows) {
    const c = cityById.get(a.city_id);
    if (c) cityByAlias.set(a.alias_lower, c);
  }

  return { stateByLower, stateByCode, cityByAlias, loadedAt: Date.now() };
}

async function getMaps(): Promise<RegionMaps> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < CACHE_TTL_MS) return cache;
  if (inflightLoad) return inflightLoad;
  inflightLoad = loadMaps()
    .then((m) => {
      cache = m;
      return m;
    })
    .finally(() => {
      inflightLoad = null;
    });
  return inflightLoad;
}

// Invalidate the cache after a write so subsequent calls see auto-grown
// cities. Cheap — next call re-reads ~150 rows total.
function invalidate(): void {
  cache = null;
}

export interface RegionInput {
  components?: PlaceComponents;
  rawCity?: string | null;
  rawState?: string | null;
  rawPincode?: string | null;
  address?: string | null;
}

export interface RegionResult {
  state: string | null;
  city: string | null;
  area: string | null;
  pincode: string | null;
  country: string;
  lat: number | null;
  lng: number | null;
  isValid: boolean;
  source:
    | "google_components"
    | "alias"
    | "regex"
    | "inferred"
    | "legacy_ts"
    | "unresolved";
}

// Slug builder for auto-grown city ids. Mirrors the seed convention from
// E-108: `c_<lower_name_with_underscores>_<state_code_lower>`. The cities
// table has a UNIQUE(name, state_code), so a collision-prone slug is safe
// — the INSERT … ON CONFLICT DO NOTHING below would silently skip.
function cityIdFor(name: string, stateCode: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `c_${slug}_${stateCode.toLowerCase()}`;
}

// Auto-grow path: when Google addressComponents gives us a city in a known
// state but the city isn't yet in the cities table, insert it. Future
// resolutions then hit the fast in-memory path instead of falling through
// to the legacy TS fallback.
async function ensureCity(
  name: string,
  stateCode: string,
  lat: number | null,
  lng: number | null,
): Promise<CityRow | null> {
  const id = cityIdFor(name, stateCode);
  try {
    await db
      .insert(cities)
      .values({
        id,
        name,
        state_code: stateCode,
        lat: lat ?? undefined,
        lng: lng ?? undefined,
        source: "auto_grow",
      })
      .onConflictDoNothing();
    // Re-fetch by unique (name, state_code) so we return the canonical row
    // even if a concurrent insert raced us under a different id slug.
    const existing = await db
      .select({
        id: cities.id,
        name: cities.name,
        state_code: cities.state_code,
        source: cities.source,
      })
      .from(cities)
      .where(and(eq(cities.name, name), eq(cities.state_code, stateCode)))
      .limit(1);
    const row = existing[0] ?? null;
    // Insert the lowercase-name alias so the in-memory cityByAlias map
    // finds it on the next request — without this, resolveCity() would
    // still miss "sonipat" because the alias row never existed.
    if (row) {
      await db
        .insert(cityAliases)
        .values({ alias_lower: name.trim().toLowerCase(), city_id: row.id })
        .onConflictDoNothing();
    }
    invalidate();
    return row;
  } catch (err) {
    console.error(
      `[locations] ensureCity failed for ${name} / ${stateCode}:`,
      err,
    );
    return null;
  }
}

// Pick the best raw-city candidate for auto-grow. The cities table is the
// source of truth for the region tree, so we only insert strings that look
// like real city names. Reject:
//   - empty / whitespace-only
//   - longer than 60 chars (clearly a junk address line)
//   - contains digits or commas (suggests it's a street/PO box, not a city)
//   - contains common shop-name noise tokens
function pickCityCandidate(
  ...candidates: Array<string | null | undefined>
): string | null {
  for (const raw of candidates) {
    if (!raw) continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.length < 2 || trimmed.length > 60) continue;
    if (/[,;:]/.test(trimmed)) continue;
    if (/\d/.test(trimmed)) continue;
    // Reject obviously address-like tokens; cities don't contain these.
    if (/\b(road|rd|st|street|nagar pin|po box|p\.o\.|sector|phase|block)\b/i.test(trimmed)) {
      continue;
    }
    // Title-case for the canonical row so "sonipat" / "SONIPAT" both insert
    // as "Sonipat".
    return trimmed
      .toLowerCase()
      .split(/\s+/)
      .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
      .join(" ");
  }
  return null;
}

// Resolve a free-form city string against the alias map. Returns the
// canonical city row (or undefined). Case-insensitive, trim-tolerant.
function resolveCity(
  raw: string | null | undefined,
  maps: RegionMaps,
): CityRow | undefined {
  if (!raw) return undefined;
  const key = raw.trim().toLowerCase();
  if (!key) return undefined;
  return maps.cityByAlias.get(key);
}

function resolveState(
  raw: string | null | undefined,
  maps: RegionMaps,
): StateRow | undefined {
  if (!raw) return undefined;
  const key = raw.trim().toLowerCase();
  if (!key) return undefined;
  return maps.stateByLower.get(key);
}

export async function normalizeRegion(
  input: RegionInput,
): Promise<RegionResult> {
  const maps = await getMaps();
  const components = input.components;

  let city: CityRow | undefined;
  let state: StateRow | undefined;
  let source: RegionResult["source"] = "unresolved";
  let area: string | null = components?.area ?? null;
  let lat: number | null = components?.lat ?? null;
  let lng: number | null = components?.lng ?? null;

  // 1. Google addressComponents — strongest signal.
  if (components) {
    if (components.state) state = resolveState(components.state, maps);
    if (components.city) city = resolveCity(components.city, maps);

    // Auto-grow: Google gave us a city in a known state but the city
    // isn't seeded. Insert it so future scrapes resolve fast.
    if (!city && components.city && state) {
      const inserted = await ensureCity(
        components.city.trim(),
        state.code,
        lat,
        lng,
      );
      if (inserted) city = inserted;
    }
    if (city && state) source = "google_components";
  }

  // 2. Free-form raw inputs through the alias map.
  if (!city && input.rawCity) {
    city = resolveCity(input.rawCity, maps);
    if (city) source = "alias";
  }
  if (!state && input.rawState) {
    state = resolveState(input.rawState, maps);
    if (state && source === "unresolved") source = "alias";
  }

  // 3. Regex parse the address as a fallback.
  let parsedCityFromAddress: string | null = null;
  if ((!city || !state) && input.address) {
    const parsed = parseAddressComponents(input.address);
    if (parsed.city) parsedCityFromAddress = parsed.city;
    if (!city && parsed.city) {
      city = resolveCity(parsed.city, maps);
      if (city && source === "unresolved") source = "regex";
    }
    if (!state && parsed.state) {
      state = resolveState(parsed.state, maps);
      if (state && source === "unresolved") source = "regex";
    }
    if (!state && !parsed.state) {
      const extracted = extractStateFromAddress(input.address);
      if (extracted) {
        state = resolveState(extracted, maps);
        if (state && source === "unresolved") source = "regex";
      }
    }
  }

  // 4. Derive state from city's FK when we have a city but no state.
  if (city && !state) {
    state = maps.stateByCode.get(city.state_code);
    if (state) source = "inferred";
  }

  // 4b. Auto-grow for non-Google paths. When we have a canonical state but
  // the city text didn't resolve via aliases (e.g. raw scrape source was
  // Apify/Firecrawl with no addressComponents, or the city is a real place
  // simply not yet in the cities seed — Sonipat, Panipat, etc.), insert
  // the city under that state so future scrapes hit the fast canonical
  // path and the region tree buckets it correctly by name.
  if (!city && state) {
    const candidate = pickCityCandidate(
      input.rawCity,
      parsedCityFromAddress,
      input.components?.city,
    );
    if (candidate) {
      const inserted = await ensureCity(candidate, state.code, lat, lng);
      if (inserted) {
        city = inserted;
        if (source === "unresolved" || source === "alias") source = "alias";
      }
    }
  }

  // 5. Last-resort: legacy TS maps. Catches edge cases where the DB hasn't
  // been seeded (unmigrated dev DBs) or rawCity is in CITY_ALIASES but the
  // DB seed missed it.
  if (!city && !state) {
    const legacyCity = legacyNormalizeCity(
      input.rawCity ?? input.components?.city ?? undefined,
    );
    const legacyState = legacyNormalizeState(
      input.rawState ?? input.components?.state ?? undefined,
    );
    const inferred = legacyInferStateFromCity(legacyCity);
    const stateName = legacyState ?? inferred;
    if (legacyCity || stateName) {
      return {
        state: stateName ?? null,
        city: legacyCity ?? null,
        area,
        pincode: pickPincode(input),
        country: components?.country ?? "IN",
        lat,
        lng,
        isValid: false,
        source: "legacy_ts",
      };
    }
  }

  return {
    state: state?.name ?? null,
    city: city?.name ?? null,
    area,
    pincode: pickPincode(input),
    country: components?.country ?? "IN",
    lat,
    lng,
    isValid: Boolean(city && state),
    source: city || state ? source : "unresolved",
  };
}

function pickPincode(input: RegionInput): string | null {
  const fromComponents = input.components?.pincode?.trim();
  if (fromComponents && /^[1-9]\d{5}$/.test(fromComponents)) {
    return fromComponents;
  }
  if (input.rawPincode) {
    const trimmed = input.rawPincode.trim();
    if (/^[1-9]\d{5}$/.test(trimmed)) return trimmed;
  }
  const fromAddress = extractPincode(input.address ?? undefined);
  return fromAddress ?? null;
}

// Exposed for tests / debugging. Forces a cache reload on next call.
export function _invalidateLocationCache(): void {
  invalidate();
}

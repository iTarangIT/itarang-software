/**
 * City-centre coordinates for Indian cities, plus great-circle distance.
 *
 * Extracted from src/lib/nbfc/auction/audience.ts (E-234) so the risk engine's
 * "outside assigned city" card and the auction audience resolver measure
 * against the same centroid table with the same maths; audience.ts re-exports
 * these so its callers did not move.
 *
 * WHY CENTROIDS. No CRM entity carries coordinates — `accounts` and `leads`
 * store city / state / pincode as free text — so "is X within N km of its
 * city" can only be measured against the city's CENTRE, using the
 * `country-state-city` package already in the dependency list (4,242 Indian
 * cities, all with lat/lng). This is approximate by construction and every
 * consumer states the approximation where the number is shown: a vehicle is
 * "outside" a 25 km circle drawn around the city centre, not outside the
 * municipal boundary. Right for "roughly still in town", wrong for anything
 * that needs metres, and never silently precise.
 */
import { City } from "country-state-city";

let cityIndex: Map<string, { lat: number; lng: number }> | null = null;

/**
 * Renamed cities. The package index knows ONE spelling per city and it is
 * often the older one ("Allahabad", not "Prayagraj") — or, inconsistently,
 * the newer one ("Bengaluru", not "Bangalore"). CRM records are typed by
 * people and carry both, so a lookup miss on either would exclude a loan from
 * the geofence card for a reason nobody would guess. Both directions are
 * listed; each entry is a name the index LACKS pointing at the one it HAS
 * (verified against country-state-city 3.2.1 on 2026-08-27).
 */
const CITY_ALIASES: Record<string, string> = {
  prayagraj: "allahabad",
  gurugram: "gurgaon",
  bangalore: "bengaluru",
  bombay: "mumbai",
  madras: "chennai",
  calcutta: "kolkata",
  baroda: "vadodara",
  kochi: "cochin",
  trivandrum: "thiruvananthapuram",
  mysore: "mysuru",
  belgaum: "belagavi",
  hubli: "hubballi",
  mangalore: "mangaluru",
  shivamogga: "shimoga",
  tumkur: "tumakuru",
  bellary: "ballari",
  pondicherry: "puducherry",
  poona: "pune",
  narmadapuram: "hoshangabad",
};

export function normaliseCity(name: string): string {
  const key = name.trim().toLowerCase().replace(/\s+/g, " ");
  return CITY_ALIASES[key] ?? key;
}

function getCityIndex(): Map<string, { lat: number; lng: number }> {
  if (cityIndex) return cityIndex;
  const index = new Map<string, { lat: number; lng: number }>();
  for (const c of City.getCitiesOfCountry("IN") ?? []) {
    const lat = Number(c.latitude);
    const lng = Number(c.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const key = normaliseCity(c.name);
    // First writer wins. Duplicated city names across states are common
    // ("Aurangabad"); without coordinates on our side there is nothing to
    // disambiguate them with, so the first is as good as any and at least it
    // is deterministic across processes.
    if (!index.has(key)) index.set(key, { lat, lng });
  }
  cityIndex = index;
  return index;
}

/** Great-circle distance in km. */
export function haversineKm(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) *
      Math.cos((bLat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** The centre of a named Indian city, or null when the name is not in the index. */
export function cityCentroid(
  city: string | null | undefined,
): { lat: number; lng: number } | null {
  if (!city) return null;
  return getCityIndex().get(normaliseCity(city)) ?? null;
}

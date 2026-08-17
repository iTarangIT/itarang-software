// "Which cities did this scrape run cover?" — the input to the Run Campaign
// button on the scrape-run detail page.
//
// THE ONE RELIABLE SOURCE IS scraper_run_chunks.city (E-227), written at fan-out
// in chunkedPipeline.ts alongside query_text. It is clean: verified against a
// real run, `SCRAPE-20260817-ecbddd61` has 15 chunks all carrying
// city = 'vijayawada', which resolves through city_aliases to
// Vijayawada / Andhra Pradesh and matches 145 dealer_leads.
//
// ⚠ scraped_dealer_leads.location_city is NOT a general fallback. It is the
// upstream address parse, and it is mostly noise: 3,729 distinct values of which
// only 150 (4%) resolve through city_aliases, with real samples "01", "04",
// "1" and "09 KANHA NIRMAL"; one run alone has 1,501 distinct "cities". It is
// used here ONLY for values that survive the alias table, and the unresolved
// remainder is discarded rather than guessed — a campaign targeting "01" is far
// worse than a disabled button.
//
// scraper_runs.search_queries is never parsed. It is free jsonb prose with three
// incompatible historical shapes (see normalizeQueries in RunDetailView).
//
// COVERAGE IS HONESTLY LOW. E-227 is recent, so only a handful of the most
// recent runs carry a chunk city and essentially no historical one does. The
// empty result is the normal case for an old run, and the caller is expected to
// disable the button with a reason rather than treat it as an error.

import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

export type RunCity = {
    /** What the scraper actually recorded, e.g. "vijayawada". */
    raw: string;
    /** Canonical state, or null when it could not be resolved. */
    state: string | null;
    /** Canonical city — matches audience.ts's city_bucket exactly. */
    city: string;
    resolved: boolean;
};

export type RunCityResolution = {
    /** Pairs safe to hand to resolveDialerAudience. Only resolved ones. */
    cities: RunCity[];
    /** Raw values that matched nothing. Rendered struck through. */
    unresolvedRaw: string[];
    source: "chunks" | "scraped_leads" | "none";
};

function rowsOf<T>(result: unknown): T[] {
    return (result as { rows?: T[] }).rows ?? (result as T[]);
}

type ResolvedCityRow = {
    raw_city: string | null;
    canon_city: string | null;
    canon_state: string | null;
};

/**
 * Resolve raw city strings through city_aliases → cities → states.
 *
 * The join is the same one audience.ts uses, and that is the point: it matches
 * `pair->>'city' = city_bucket` EXACTLY on the canonical bucket, so a raw
 * "vijayawada" that is not canonicalised here would silently match nothing.
 */
async function canonicalise(rawCities: string[]): Promise<ResolvedCityRow[]> {
    if (rawCities.length === 0) return [];
    const result = await db.execute(sql`
        WITH raw AS (
          SELECT DISTINCT LOWER(TRIM(value)) AS raw_city
            FROM jsonb_array_elements_text(${JSON.stringify(rawCities)}::jsonb)
           WHERE TRIM(value) <> ''
        )
        SELECT r.raw_city,
               c.name AS canon_city,
               s.name AS canon_state
          FROM raw r
          LEFT JOIN city_aliases ca ON ca.alias_lower = r.raw_city
          LEFT JOIN cities c        ON c.id   = ca.city_id
          LEFT JOIN states s        ON s.code = c.state_code
         ORDER BY 1
    `);
    return rowsOf<ResolvedCityRow>(result);
}

/**
 * Recover a state for a city name the alias table does not know.
 *
 * Do NOT fabricate {state: "Unknown"}: audience.ts derives state_bucket from
 * dl.state, so a made-up state matches only leads whose state is ALSO
 * unresolvable — usually zero rows, silently. Asking the lead population
 * instead yields pairs that match city_bucket exactly. A name spanning two
 * states legitimately returns both.
 */
async function recoverFromLeads(rawCities: string[]): Promise<RunCity[]> {
    if (rawCities.length === 0) return [];
    const result = await db.execute(sql`
        WITH resolved AS (
          SELECT COALESCE(s_from_city.name, s_direct.name)                       AS canon_state,
                 COALESCE(c.name, NULLIF(INITCAP(TRIM(dl.city)), ''), 'Unknown') AS city_bucket,
                 LOWER(TRIM(dl.city))                                            AS raw_city
            FROM dealer_leads dl
            LEFT JOIN city_aliases ca    ON ca.alias_lower = LOWER(TRIM(dl.city))
            LEFT JOIN cities c           ON c.id = ca.city_id
            LEFT JOIN states s_from_city ON s_from_city.code = c.state_code
            LEFT JOIN states s_direct    ON LOWER(s_direct.name) = LOWER(TRIM(dl.state))
           WHERE dl.phone IS NOT NULL AND dl.phone <> ''
        )
        SELECT DISTINCT raw_city,
               city_bucket  AS canon_city,
               canon_state
          FROM resolved
         WHERE canon_state IS NOT NULL
           AND raw_city = ANY (
                 SELECT LOWER(TRIM(value))
                   FROM jsonb_array_elements_text(${JSON.stringify(rawCities)}::jsonb)
               )
    `);
    return rowsOf<ResolvedCityRow>(result)
        .filter((r) => r.canon_city && r.canon_state)
        .map((r) => ({
            raw: r.raw_city ?? "",
            city: r.canon_city as string,
            state: r.canon_state as string,
            resolved: true,
        }));
}

async function rawCitiesFromChunks(runId: string): Promise<string[]> {
    // A standalone statement, so a missing relation or column throws a catchable
    // driver error rather than failing at parse time — which is why a JS
    // try/catch is enough here and a to_regclass probe is not needed.
    try {
        const result = await db.execute(sql`
            SELECT DISTINCT TRIM(city) AS city
              FROM scraper_run_chunks
             WHERE run_id = ${runId}
               AND city IS NOT NULL AND TRIM(city) <> ''
        `);
        return rowsOf<{ city: string | null }>(result)
            .map((r) => r.city)
            .filter((c): c is string => Boolean(c));
    } catch (err) {
        console.warn("[runAudience] scraper_run_chunks unavailable:", err);
        return [];
    }
}

async function rawCitiesFromScrapedLeads(runId: string): Promise<string[]> {
    try {
        const result = await db.execute(sql`
            SELECT DISTINCT TRIM(location_city) AS city
              FROM scraped_dealer_leads
             WHERE scraper_run_id = ${runId}
               AND location_city IS NOT NULL AND TRIM(location_city) <> ''
        `);
        return rowsOf<{ city: string | null }>(result)
            .map((r) => r.city)
            .filter((c): c is string => Boolean(c));
    } catch (err) {
        console.warn("[runAudience] scraped_dealer_leads unavailable:", err);
        return [];
    }
}

function toRunCities(rows: ResolvedCityRow[]): {
    cities: RunCity[];
    unresolvedRaw: string[];
} {
    const cities: RunCity[] = [];
    const unresolvedRaw: string[] = [];
    for (const r of rows) {
        const raw = r.raw_city ?? "";
        if (r.canon_city && r.canon_state) {
            cities.push({
                raw,
                city: r.canon_city,
                state: r.canon_state,
                resolved: true,
            });
        } else if (raw) {
            unresolvedRaw.push(raw);
        }
    }
    return { cities, unresolvedRaw };
}

export async function resolveRunCities(
    runId: string,
): Promise<RunCityResolution> {
    // 1. The structured source.
    const chunkCities = await rawCitiesFromChunks(runId);
    if (chunkCities.length > 0) {
        const { cities, unresolvedRaw } = toRunCities(
            await canonicalise(chunkCities),
        );
        // 2. For a chunk city the alias table does not know, ask the leads.
        const recovered = await recoverFromLeads(unresolvedRaw);
        const stillUnresolved = unresolvedRaw.filter(
            (raw) => !recovered.some((c) => c.raw === raw),
        );
        return {
            cities: [...cities, ...recovered],
            unresolvedRaw: stillUnresolved,
            source: "chunks",
        };
    }

    // 3. Pre-E-227 fallback, alias-table only. Anything that does NOT resolve is
    //    dropped without a trace here: this source is 96% address noise, and the
    //    lead-population recovery used above would happily "resolve" a fragment
    //    like "01" against some lead whose city parsed the same way.
    const scrapedCities = await rawCitiesFromScrapedLeads(runId);
    if (scrapedCities.length > 0) {
        const { cities } = toRunCities(await canonicalise(scrapedCities));
        if (cities.length > 0) {
            return { cities, unresolvedRaw: [], source: "scraped_leads" };
        }
    }

    return { cities: [], unresolvedRaw: [], source: "none" };
}

/** "Vijayawada" · "Vijayawada +2 cities" — for the campaign name. */
export function citiesLabel(cities: RunCity[]): string {
    if (cities.length === 0) return "no city";
    if (cities.length === 1) return cities[0].city;
    return `${cities[0].city} +${cities.length - 1} cit${cities.length - 1 === 1 ? "y" : "ies"}`;
}

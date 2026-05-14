// Backfill dealer_leads.{state, city, pincode} for rows that pre-date the
// E-106 region hierarchy migration, AND fix rows whose `city` is currently
// a street-address fragment like "954" / "No. 40" / "#2953/36/1" / "2nd
// Stage" — these leaked in from the old scraper / legacy `location` column
// before normalizeCity got its looksLikeAddressFragment guard.
//
// Strategy: for every candidate row, re-parse the original Google Places
// `formattedAddress` (stored in scraped_dealer_leads.raw_data.address)
// through parseAddressComponents — that's the same logic the live scrape
// path uses, so backfilled rows and freshly-scraped rows resolve identically.
// Falls through to inferStateFromCity / extractPincode when the raw address
// isn't available.
//
// Idempotent. Run as:
//   npx tsx scripts/backfill-dealer-leads-region.ts
//
// Designed to be safe against the shared sandbox. Updates run in batches
// of BATCH_SIZE; nothing destructive — `state` and `pincode` use COALESCE
// to avoid clobbering, and `city` only overwrites when the existing value
// is NULL or matches the fragment pattern.

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const BATCH_SIZE = 500;

async function main() {
  const { sql } = await import("drizzle-orm");
  const { db } = await import("../src/lib/db");
  const {
    normalizeCity,
    normalizeState,
    inferStateFromCity,
    extractPincode,
    parseAddressComponents,
  } = await import("../src/lib/scraper-enrichment");

  const dbUrl = new URL(process.env.DATABASE_URL!);
  console.log(`[backfill] target host: ${dbUrl.hostname}`);

  // Pull every callable row that either hasn't been migrated yet OR whose
  // current `city` is a street-address fragment that needs replacing. We
  // also pull the most recent scraped_dealer_leads.raw_data for the same
  // phone — that's where the original Google Places formattedAddress lives.
  //
  // Fragment patterns mirror looksLikeAddressFragment() in
  // src/lib/scraper-enrichment.ts. Keep them in sync if that function grows
  // new cases.
  const candidates = await db.execute(sql`
    SELECT dl.id, dl.phone, dl.location, dl.city AS existing_city,
           dl.state AS existing_state,
           sdl.raw_data AS raw_data,
           sdl.location_state AS scraped_state
    FROM dealer_leads dl
    LEFT JOIN LATERAL (
      SELECT raw_data, location_state
      FROM scraped_dealer_leads
      WHERE scraped_dealer_leads.phone = dl.phone
      ORDER BY created_at DESC NULLS LAST
      LIMIT 1
    ) sdl ON TRUE
    WHERE dl.phone IS NOT NULL
      AND dl.phone <> ''
      AND (
        dl.state IS NULL
        OR dl.city IS NULL
        OR dl.city ~ '^[#0-9]'
        OR dl.city ~* '^(no\\M|no\\.|plot\\y|shop\\y|flat\\y|building\\y|unit\\y|door\\y|gala\\y)'
        OR dl.city ~* '^[[:digit:]]+(st|nd|rd|th)[[:space:]]+(stage|cross|main|floor|phase|block|sector|street)\\y'
        OR dl.city ~* '^(ground|first|second|third|fourth|fifth)[[:space:]]+floor\\y'
      )
  `);

  const rows: any[] = (candidates as any).rows ?? candidates;
  console.log(`[backfill] ${rows.length} dealer_leads rows need a region`);

  let stateInferred = 0;
  let pincodeInferred = 0;
  let cityFilled = 0;
  let unmapped = 0;

  const updates: {
    id: string;
    state: string | null;
    city: string | null;
    pincode: string | null;
  }[] = [];

  for (const r of rows) {
    const rawData =
      r.raw_data && typeof r.raw_data === "object" ? r.raw_data : null;
    const addressFromRaw =
      rawData && typeof rawData.address === "string" ? rawData.address : null;

    // Re-parse the original Google Places formattedAddress through the same
    // parser the live scrape path uses. parseAddressComponents walks from the
    // PIN backwards and rejects fragment-shaped city candidates, so this
    // recovers "Mysuru" even when dealer_leads.city currently holds "954".
    const parsed = addressFromRaw ? parseAddressComponents(addressFromRaw) : {};

    // City order: parser → normalize(existing_city) → null. We deliberately
    // do NOT fall back to r.location — that's where the legacy fragments
    // came from and normalizeCity will now reject them anyway, but skipping
    // the lookup keeps intent obvious. The CASE in the UPDATE below decides
    // whether the value actually overwrites what's in the DB.
    const cityCanonical =
      parsed.city
      ?? normalizeCity(r.existing_city ?? undefined)
      ?? null;

    // State order: parser → existing state → normalized scraped_state →
    // city→state inference. We trust the parser most because it scans the
    // full address for known state names.
    const stateCanonical =
      parsed.state
      ?? (r.existing_state ? normalizeState(r.existing_state) : undefined)
      ?? (r.scraped_state ? normalizeState(r.scraped_state) : undefined)
      ?? inferStateFromCity(cityCanonical)
      ?? null;

    const pincode =
      parsed.pincode
      ?? extractPincode(addressFromRaw ?? r.location ?? undefined)
      ?? null;

    if (stateCanonical) stateInferred += 1;
    if (pincode) pincodeInferred += 1;
    if (cityCanonical && !r.existing_city) cityFilled += 1;
    if (!stateCanonical && !pincode && !cityCanonical) unmapped += 1;

    updates.push({
      id: r.id,
      state: stateCanonical,
      city: cityCanonical,
      pincode,
    });
  }

  // Write back in batches. state and pincode use COALESCE to avoid
  // clobbering values a concurrent writer might have set. city uses a CASE
  // so that NULL or fragment-shaped values get replaced with the parser's
  // output, while legitimate existing cities are preserved.
  //
  // The CASE patterns must stay in sync with the SELECT WHERE clause above
  // and with looksLikeAddressFragment() in src/lib/scraper-enrichment.ts.
  let touched = 0;
  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const chunk = updates.slice(i, i + BATCH_SIZE);
    for (const u of chunk) {
      await db.execute(sql`
        UPDATE dealer_leads
        SET state   = COALESCE(state, ${u.state}),
            city    = CASE
                        WHEN city IS NULL OR TRIM(city) = '' THEN ${u.city}
                        WHEN city ~ '^[#0-9]' THEN ${u.city}
                        WHEN city ~* '^(no\\M|no\\.|plot\\y|shop\\y|flat\\y|building\\y|unit\\y|door\\y|gala\\y)' THEN ${u.city}
                        WHEN city ~* '^[[:digit:]]+(st|nd|rd|th)[[:space:]]+(stage|cross|main|floor|phase|block|sector|street)\\y' THEN ${u.city}
                        WHEN city ~* '^(ground|first|second|third|fourth|fifth)[[:space:]]+floor\\y' THEN ${u.city}
                        ELSE city
                      END,
            pincode = COALESCE(pincode, ${u.pincode})
        WHERE id = ${u.id}
      `);
      touched += 1;
    }
    console.log(`[backfill] processed ${Math.min(i + chunk.length, updates.length)}/${updates.length}`);
  }

  console.log(`[backfill] done. touched=${touched} state_inferred=${stateInferred} pincode_inferred=${pincodeInferred} city_filled=${cityFilled} unmapped=${unmapped}`);
  setTimeout(() => process.exit(0), 200);
}

main().catch((err) => {
  console.error("[backfill] failed:", err);
  process.exit(1);
});

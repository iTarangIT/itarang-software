-- E-107 — backfill dealer_leads.{city, state} from the original Google Places
-- formattedAddress for rows whose city is currently a street-address fragment
-- ("954" / "No. 40" / "#2953/36/1" / "2nd Stage").
--
-- These rows are pre-E-106: the old scraper wrote the FIRST comma segment of
-- formattedAddress (the street number) into dealer_leads.city, before
-- parseAddressComponents was rewritten to walk from the pincode backwards
-- and looksLikeAddressFragment() was added to normalizeCity. The freshly
-- scraped rows on the new pipeline are correct; this migration cleans up
-- history so the AI dialer's region selector stops listing "954" and
-- "2nd Stage" as cities under Karnataka.
--
-- Strategy: the canonical Google Places shape for Indian addresses is
--   "..., <city>, <state> <pincode>, India"
-- so we extract the segment immediately before "<state> <pincode>" using a
-- regex with a whitelist of known Indian state names. When the resulting
-- city candidate STILL looks like a fragment (some addresses lead with
-- "Street Road, Karnataka 570001" with no city segment at all), we leave
-- city NULL — the region selector will bucket those rows under "Unknown"
-- so they're at least dialable, even if we can't say which city.
--
-- Idempotent. Strictly additive — only touches rows whose city is NULL or
-- matches the fragment regex; never overwrites a real city. Safe to re-run.
-- Applied via pgAdmin Query Tool against AWS Postgres.

BEGIN;

-- Stage 1: derive parsed_city / parsed_state per affected dealer_leads row.
-- A row is "affected" when phone is set (so it's dialable) AND city is
-- either missing or fragment-shaped. The fragment regex MUST stay in sync
-- with looksLikeAddressFragment() in src/lib/scraper-enrichment.ts and the
-- backfill TS script — if you add a new fragment pattern there, add it
-- here in all three CASE branches.
CREATE TEMP TABLE _dl_city_backfill ON COMMIT DROP AS
WITH affected AS (
  SELECT dl.id, dl.phone
  FROM dealer_leads dl
  WHERE dl.phone IS NOT NULL AND dl.phone <> ''
    AND (
      dl.city IS NULL
      OR TRIM(dl.city) = ''
      OR dl.city ~ '^[#0-9]'
      OR dl.city ~* '^(no\.?\s|no\.?$|plot\s|shop\s|flat\s|building\s|unit\s|door\s|gala\s|h\.?\s*no|d\.?\s*no|s\.?\s*no|opp\.?\s|near\s|behind\s|beside\s)'
      OR dl.city ~* '^[0-9]+(st|nd|rd|th)[[:space:]]+(stage|cross|main|floor|phase|block|sector|street)\M'
      OR dl.city ~* '^(ground|first|second|third|fourth|fifth)[[:space:]]+floor\M'
    )
),
-- Pull the most recent scraped_dealer_leads row per affected phone — that's
-- where the original formattedAddress lives (raw_data.address).
newest_raw AS (
  SELECT DISTINCT ON (sdl.phone)
    sdl.phone,
    sdl.raw_data->>'address'  AS address,
    sdl.location_state         AS scraped_state
  FROM scraped_dealer_leads sdl
  WHERE sdl.phone IN (SELECT phone FROM affected)
  ORDER BY sdl.phone, sdl.created_at DESC NULLS LAST
),
parsed AS (
  SELECT
    a.id,
    r.address,
    r.scraped_state,
    -- PIN-anchored capture: "<city>, <state> <6-digit pin>".
    -- Group 1 = city, group 2 = state.
    regexp_match(
      r.address,
      '([^,]+),\s*(Uttar Pradesh|Madhya Pradesh|Maharashtra|Karnataka|Tamil Nadu|West Bengal|Rajasthan|Gujarat|Andhra Pradesh|Telangana|Delhi|Bihar|Haryana|Punjab|Odisha|Jharkhand|Chhattisgarh|Assam|Uttarakhand|Kerala|Goa|Himachal Pradesh|Tripura|Manipur|Meghalaya|Mizoram|Nagaland|Sikkim|Arunachal Pradesh|Chandigarh|Puducherry|Jammu and Kashmir|Ladakh)\s+[1-9][0-9]{5}',
      'i'
    ) AS m_pin,
    -- Fallback: no pincode, just "<city>, <state>" followed by comma or end.
    regexp_match(
      r.address,
      '([^,]+),\s*(Uttar Pradesh|Madhya Pradesh|Maharashtra|Karnataka|Tamil Nadu|West Bengal|Rajasthan|Gujarat|Andhra Pradesh|Telangana|Delhi|Bihar|Haryana|Punjab|Odisha|Jharkhand|Chhattisgarh|Assam|Uttarakhand|Kerala|Goa|Himachal Pradesh|Tripura|Manipur|Meghalaya|Mizoram|Nagaland|Sikkim|Arunachal Pradesh|Chandigarh|Puducherry|Jammu and Kashmir|Ladakh)\s*(,|$)',
      'i'
    ) AS m_nopin
  FROM affected a
  LEFT JOIN newest_raw r ON r.phone = a.phone
)
SELECT
  id,
  -- Prefer the PIN-anchored match; fall back to the state-only match. TRIM
  -- and clean leading/trailing whitespace so downstream comparisons match.
  TRIM(COALESCE(m_pin[1], m_nopin[1])) AS parsed_city_raw,
  -- State: prefer the parser's hit, then the scraped_state column. Both go
  -- through normalizeState equivalent already (we matched canonical names
  -- via the regex).
  COALESCE(m_pin[2], m_nopin[2], scraped_state) AS parsed_state
FROM parsed;

-- Stage 2: apply.
--   * state — COALESCE so we never clobber a value the new scraper already set.
--   * city  — overwrite only when current value is NULL or fragment-shaped,
--             AND the parsed candidate itself is not a fragment. When the
--             parser couldn't find a usable city, we explicitly set city =
--             NULL so the row collapses under "Unknown" in the region tree
--             instead of continuing to display "954".
UPDATE dealer_leads dl
SET
  state = COALESCE(dl.state, b.parsed_state),
  city = CASE
    -- Parsed candidate is good — use it. Apply the same fragment guard the
    -- live normalizeCity() applies, so we don't replace one fragment with
    -- another. Length bounds mirror looksLikeAddressFragment's 3..60 char
    -- check.
    WHEN b.parsed_city_raw IS NOT NULL
      AND LENGTH(b.parsed_city_raw) BETWEEN 3 AND 60
      AND b.parsed_city_raw !~ '^[#0-9]'
      AND b.parsed_city_raw !~* '^(no\.?\s|no\.?$|plot\s|shop\s|flat\s|building\s|unit\s|door\s|gala\s|h\.?\s*no|d\.?\s*no|s\.?\s*no|opp\.?\s|near\s|behind\s|beside\s)'
      AND b.parsed_city_raw !~* '^[0-9]+(st|nd|rd|th)[[:space:]]+(stage|cross|main|floor|phase|block|sector|street)\M'
      AND b.parsed_city_raw !~* '^(ground|first|second|third|fourth|fifth)[[:space:]]+floor\M'
    THEN
      -- INITCAP normalizes "MYSURU" / "mysuru" -> "Mysuru". For multi-word
      -- cities ("New Delhi", "Navi Mumbai") it title-cases each word.
      INITCAP(LOWER(b.parsed_city_raw))
    -- Parser had nothing usable and existing city was junk — clear it so
    -- the region selector groups this row under "Unknown" instead of
    -- continuing to advertise the street number as a city.
    ELSE NULL
  END
FROM _dl_city_backfill b
WHERE dl.id = b.id;

-- Stage 3: pincode best-effort backfill. The PIN-anchored regex already
-- captured this; pull it out and only fill rows where pincode is missing.
UPDATE dealer_leads dl
SET pincode = m[3]
FROM (
  SELECT
    a.id,
    regexp_match(
      r.address,
      '([^,]+),\s*(Uttar Pradesh|Madhya Pradesh|Maharashtra|Karnataka|Tamil Nadu|West Bengal|Rajasthan|Gujarat|Andhra Pradesh|Telangana|Delhi|Bihar|Haryana|Punjab|Odisha|Jharkhand|Chhattisgarh|Assam|Uttarakhand|Kerala|Goa|Himachal Pradesh|Tripura|Manipur|Meghalaya|Mizoram|Nagaland|Sikkim|Arunachal Pradesh|Chandigarh|Puducherry|Jammu and Kashmir|Ladakh)\s+([1-9][0-9]{5})',
      'i'
    ) AS m
  FROM dealer_leads a
  JOIN scraped_dealer_leads r ON r.phone = a.phone
  WHERE a.phone IS NOT NULL AND a.phone <> ''
    AND a.pincode IS NULL
    AND r.raw_data->>'address' IS NOT NULL
) p
WHERE dl.id = p.id
  AND p.m IS NOT NULL
  AND p.m[3] IS NOT NULL;

COMMIT;

-- Verification queries — run these after to confirm the cleanup worked.
-- Expected: zero rows.
--   SELECT id, city, state, phone
--   FROM dealer_leads
--   WHERE phone IS NOT NULL AND phone <> ''
--     AND city ~ '^[#0-9]'
--   ORDER BY state, city
--   LIMIT 50;
--
-- And re-check the region tree the AI dialer modal reads:
--   SELECT
--     COALESCE(NULLIF(TRIM(state), ''), 'Unknown') AS state,
--     COALESCE(NULLIF(TRIM(city),  ''), 'Unknown') AS city,
--     COUNT(*) AS leads
--   FROM dealer_leads
--   WHERE phone IS NOT NULL AND phone <> ''
--   GROUP BY 1, 2
--   ORDER BY leads DESC
--   LIMIT 50;

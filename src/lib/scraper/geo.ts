// Geographic scope for the dealer scraper.
//
// Every search this product runs is for an Indian dealer, but neither search
// engine was ever told that. Google Places received a bare `textQuery` and
// Apify's google-places actor a bare `searchStringsArray`, so whenever the
// engine could not anchor the town name in the query it dropped the location
// and returned the best GLOBAL match for the product phrase instead.
//
// Run SCRAPE-20260820-e3ae054b ("3w battery dealer in kaushambi pyaragraj
// ghoomaniya") is the worked example: "lead-acid battery dealer for 3-wheelers
// in Sirathu" came back as twelve Fort Lauderdale battery shops, and
// "electric vehicle battery retailer in Jasra" resolved to Jasra *in Bahrain*.
// 21 non-Indian dealers were saved and 14 were promoted into the AI dialer
// queue with fabricated +91 numbers.
//
// Two defences, and they are deliberately independent:
//   1. Constrain the request  — regionCode / countryCode on the two sources.
//   2. Constrain the result   — this module, applied in processing/filter.ts.
// (1) is best-effort: Google's regionCode biases, it does not restrict. (2) is
// the gate that actually holds.

export const TARGET_COUNTRY = "IN";

// Lowercase ISO-3166-1 alpha-2, which is the casing Apify's
// compass~crawler-google-places actor expects for `countryCode`.
export const TARGET_COUNTRY_CODE = "in";

// US / Canada addresses are the one common case with no country name in them
// at all — Google renders them as "…, Fort Lauderdale, FL 33315". A trailing
// two-letter state plus a ZIP is unambiguous enough to reject on.
const US_STATE_ZIP = /,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\s*$/;
const CA_STATE_POSTAL = /,\s*[A-Z]{2}\s+[A-Z]\d[A-Z]\s*\d[A-Z]\d\s*$/i;

// Country names as Google Maps renders them, mapped to ISO-3166-1 alpha-2.
// Scoped to places these searches can plausibly reach — India's neighbours,
// SE Asia, the Gulf, and the English-speaking regions Maps geo-biases toward
// when it is crawled from a foreign IP. Deliberately EXCLUDES short names that
// could appear inside an Indian address ("Mali", "Chad", "Niger", "Georgia").
const FOREIGN_COUNTRIES: Record<string, string> = {
  // South Asia
  nepal: "NP",
  bangladesh: "BD",
  pakistan: "PK",
  "sri lanka": "LK",
  bhutan: "BT",
  maldives: "MV",
  afghanistan: "AF",
  // South-East and East Asia
  myanmar: "MM",
  burma: "MM",
  thailand: "TH",
  vietnam: "VN",
  cambodia: "KH",
  malaysia: "MY",
  singapore: "SG",
  indonesia: "ID",
  philippines: "PH",
  china: "CN",
  "hong kong": "HK",
  japan: "JP",
  "south korea": "KR",
  taiwan: "TW",
  // Gulf and Middle East
  bahrain: "BH",
  "united arab emirates": "AE",
  uae: "AE",
  "saudi arabia": "SA",
  qatar: "QA",
  kuwait: "KW",
  oman: "OM",
  iran: "IR",
  iraq: "IQ",
  turkey: "TR",
  israel: "IL",
  jordan: "JO",
  egypt: "EG",
  // Anglophone and Europe
  "united states": "US",
  usa: "US",
  canada: "CA",
  "united kingdom": "GB",
  uk: "GB",
  ireland: "IE",
  australia: "AU",
  "new zealand": "NZ",
  "south africa": "ZA",
  kenya: "KE",
  nigeria: "NG",
  tanzania: "TZ",
  germany: "DE",
  france: "FR",
  spain: "ES",
  italy: "IT",
  netherlands: "NL",
  russia: "RU",
  brazil: "BR",
  mexico: "MX",
};

const FOREIGN_NAME_RE = new RegExp(
  `\\b(${Object.keys(FOREIGN_COUNTRIES)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})\\b`,
  "i",
);

export interface GeoScopedLead {
  address?: string | null;
  components?: { country?: string } | null;
}

// Only the last two comma-separated segments are searched for a country name.
// That is where Google puts "<state> <pin>, <country>", and confining the
// match keeps a shop on "Nepal Chowk Road" from being read as Nepalese.
// An address with no commas (Google renders Gulf addresses as
// "90 St - Al Naba'a - Sharjah - United Arab Emirates") is searched whole.
function addressTail(address: string): string {
  const parts = address
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.slice(-2).join(", ");
}

// Returns the ISO-2 code of the country this lead is evidently NOT in, or null.
//
// POSITIVE EVIDENCE ONLY. A lead is foreign because something says so — a
// Google address component, a US ZIP, a country name — never merely because
// nothing says "India". Google routinely omits the ", India" suffix on
// Plus-Code addresses, and rejecting on a missing suffix would quietly delete
// real dealers, which is a worse failure than the one being fixed.
export function detectForeignCountry(lead: GeoScopedLead): string | null {
  // Google Places returns addressComponents for ~100% of its rows, so this
  // branch decides the overwhelming majority of leads on structured data.
  const declared = lead.components?.country?.trim().toUpperCase();
  if (declared) return declared === TARGET_COUNTRY ? null : declared;

  // Apify rows carry no components at all — fall back to the address text.
  const address = (lead.address ?? "").trim();
  if (!address) return null;

  if (US_STATE_ZIP.test(address)) return "US";
  if (CA_STATE_POSTAL.test(address)) return "CA";

  const match = FOREIGN_NAME_RE.exec(addressTail(address));
  return match ? FOREIGN_COUNTRIES[match[1].toLowerCase()] ?? null : null;
}

export function isForeignLead(lead: GeoScopedLead): boolean {
  return detectForeignCountry(lead) !== null;
}

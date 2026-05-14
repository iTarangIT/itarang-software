import type { RawDealerRecord } from '@/types/scraper';

const CITY_ALIASES: Record<string, string> = {
    'blr': 'Bengaluru', 'bangalore': 'Bengaluru', 'bengaluru': 'Bengaluru',
    'dl': 'Delhi', 'new delhi': 'Delhi', 'delhi': 'Delhi',
    'mum': 'Mumbai', 'bombay': 'Mumbai', 'mumbai': 'Mumbai',
    'chn': 'Chennai', 'madras': 'Chennai', 'chennai': 'Chennai',
    'kol': 'Kolkata', 'calcutta': 'Kolkata', 'kolkata': 'Kolkata',
    'hyd': 'Hyderabad', 'hyderabad': 'Hyderabad',
    'ahd': 'Ahmedabad', 'amd': 'Ahmedabad', 'ahmedabad': 'Ahmedabad',
    'pune': 'Pune', 'pnq': 'Pune',
    'jpr': 'Jaipur', 'jaipur': 'Jaipur',
    'lko': 'Lucknow', 'lucknow': 'Lucknow',
    'pat': 'Patna', 'patna': 'Patna',
    'ind': 'Indore', 'indore': 'Indore',
    'bpl': 'Bhopal', 'bhopal': 'Bhopal',
    'ngp': 'Nagpur', 'nagpur': 'Nagpur',
    'guwahati': 'Guwahati', 'ghy': 'Guwahati',
};

const STATE_ALIASES: Record<string, string> = {
    'up': 'Uttar Pradesh', 'uttar pradesh': 'Uttar Pradesh',
    'mp': 'Madhya Pradesh', 'madhya pradesh': 'Madhya Pradesh',
    'mh': 'Maharashtra', 'maharashtra': 'Maharashtra',
    'ka': 'Karnataka', 'karnataka': 'Karnataka',
    'tn': 'Tamil Nadu', 'tamil nadu': 'Tamil Nadu',
    'wb': 'West Bengal', 'west bengal': 'West Bengal',
    'rj': 'Rajasthan', 'rajasthan': 'Rajasthan',
    'gj': 'Gujarat', 'gujarat': 'Gujarat',
    'ap': 'Andhra Pradesh', 'andhra pradesh': 'Andhra Pradesh',
    'ts': 'Telangana', 'telangana': 'Telangana',
    'dl': 'Delhi', 'delhi': 'Delhi',
    'br': 'Bihar', 'bihar': 'Bihar',
    'hr': 'Haryana', 'haryana': 'Haryana',
    'pb': 'Punjab', 'punjab': 'Punjab',
    'or': 'Odisha', 'odisha': 'Odisha',
    'jh': 'Jharkhand', 'jharkhand': 'Jharkhand',
    'cg': 'Chhattisgarh', 'chhattisgarh': 'Chhattisgarh',
    'as': 'Assam', 'assam': 'Assam',
    'uk': 'Uttarakhand', 'uttarakhand': 'Uttarakhand',
};

// City → state map for the region selector backfill. Covers the cities we
// already normalize in CITY_ALIASES plus the NCR satellite cities that
// don't share their state's name (Ghaziabad / Noida → UP, not Delhi).
// Keys are the *canonical* city forms emitted by normalizeCity().
const CITY_TO_STATE: Record<string, string> = {
    'Bengaluru': 'Karnataka',
    'Delhi': 'Delhi',
    'Mumbai': 'Maharashtra',
    'Chennai': 'Tamil Nadu',
    'Kolkata': 'West Bengal',
    'Hyderabad': 'Telangana',
    'Ahmedabad': 'Gujarat',
    'Pune': 'Maharashtra',
    'Jaipur': 'Rajasthan',
    'Lucknow': 'Uttar Pradesh',
    'Patna': 'Bihar',
    'Indore': 'Madhya Pradesh',
    'Bhopal': 'Madhya Pradesh',
    'Nagpur': 'Maharashtra',
    'Guwahati': 'Assam',
    // NCR satellites — frequent in scraper runs, not in CITY_ALIASES.
    'Ghaziabad': 'Uttar Pradesh',
    'Noida': 'Uttar Pradesh',
    'Greater Noida': 'Uttar Pradesh',
    'Gurgaon': 'Haryana',
    'Gurugram': 'Haryana',
    'Faridabad': 'Haryana',
    // Tier-2 cities the scraper hits often.
    'Nashik': 'Maharashtra',
    'Thane': 'Maharashtra',
    'Navi Mumbai': 'Maharashtra',
    'Surat': 'Gujarat',
    'Vadodara': 'Gujarat',
    'Rajkot': 'Gujarat',
    'Coimbatore': 'Tamil Nadu',
    'Madurai': 'Tamil Nadu',
    'Kanpur': 'Uttar Pradesh',
    'Agra': 'Uttar Pradesh',
    'Varanasi': 'Uttar Pradesh',
    'Allahabad': 'Uttar Pradesh',
    'Prayagraj': 'Uttar Pradesh',
    'Meerut': 'Uttar Pradesh',
    'Mysuru': 'Karnataka',
    'Mysore': 'Karnataka',
    'Mangaluru': 'Karnataka',
    'Hubballi': 'Karnataka',
    'Visakhapatnam': 'Andhra Pradesh',
    'Vijayawada': 'Andhra Pradesh',
    'Kochi': 'Kerala',
    'Thiruvananthapuram': 'Kerala',
    'Kozhikode': 'Kerala',
    'Chandigarh': 'Chandigarh',
    'Ludhiana': 'Punjab',
    'Amritsar': 'Punjab',
    'Ranchi': 'Jharkhand',
    'Jamshedpur': 'Jharkhand',
    'Raipur': 'Chhattisgarh',
    'Bhubaneswar': 'Odisha',
    'Cuttack': 'Odisha',
    'Dehradun': 'Uttarakhand',
};

export function normalizeCity(city: string | undefined): string | undefined {
    if (!city) return undefined;
    const key = city.trim().toLowerCase();
    const aliased = CITY_ALIASES[key];
    if (aliased) return aliased;
    const trimmed = city.trim();
    // Pass through known canonical cities (CITY_TO_STATE keys like "Mysuru",
    // "Belagavi") even though they're not in CITY_ALIASES.
    for (const k of Object.keys(CITY_TO_STATE)) {
        if (k.toLowerCase() === key) return trimmed;
    }
    // Otherwise reject obvious street-address fragments so direct callers
    // (the backfill, leads CSV import) don't promote "954" / "No. 40" /
    // "#2953/36/1" / "2nd Stage" into dealer_leads.city. parseAddressComponents
    // already gates city candidates through looksLikeAddressFragment; this
    // mirrors that check at the lower-level normalizer for callers that
    // pass in raw legacy values.
    if (looksLikeAddressFragment(trimmed)) return undefined;
    return trimmed;
}

export function normalizeState(state: string | undefined): string | undefined {
    if (!state) return undefined;
    const key = state.trim().toLowerCase();
    return STATE_ALIASES[key] ?? state.trim();
}

// Look up the state for a city. Input should be the canonical city form
// produced by normalizeCity(); falls back to a case-insensitive lookup
// against the canonical keys so callers can pass raw strings too. Returns
// undefined when the city isn't in our map — backfill leaves state NULL
// in that case so the region selector groups it under "Unknown".
export function inferStateFromCity(city: string | undefined | null): string | undefined {
    if (!city) return undefined;
    const direct = CITY_TO_STATE[city];
    if (direct) return direct;
    const lower = city.trim().toLowerCase();
    for (const [k, v] of Object.entries(CITY_TO_STATE)) {
        if (k.toLowerCase() === lower) return v;
    }
    return undefined;
}

// Pull an Indian PIN (6 digits, first digit 1-9) out of an address string.
// Google Places' formattedAddress always carries it like
// "..., Nashik, Maharashtra 422101, India" — we look for the standalone
// 6-digit token and return the first match. Returns undefined when none
// is present (e.g. Apify rows that only got a partial address).
export function extractPincode(address: string | undefined | null): string | undefined {
    if (!address) return undefined;
    const m = address.match(/\b[1-9]\d{5}\b/);
    return m ? m[0] : undefined;
}

// Build a lookup table of full state names + their lowercase forms for
// substring matching against `formattedAddress`. We deliberately match
// only the canonical full names (the values of STATE_ALIASES), not the
// 2-letter codes, since codes like "UP" or "OR" produce false positives
// inside arbitrary address text ("BHOPAL ROAD" matches "OR" via "B-OR-").
const STATE_FULL_NAMES = Array.from(new Set(Object.values(STATE_ALIASES)));

// Pull a state name out of a formattedAddress / raw address string. Used
// as the highest-confidence source on scraper-promoted leads — Google
// Places and Apify both put the state explicitly in the address (e.g.
// "..., Nashik, Maharashtra 422101, India"). Returns undefined when no
// known state appears in the string.
export function extractStateFromAddress(address: string | undefined | null): string | undefined {
    if (!address) return undefined;
    const lower = address.toLowerCase();
    // Prefer longer names first ("Madhya Pradesh" before "Pradesh-something"
    // would-be-collision; sorting by length descending makes the first hit
    // the most specific).
    const sorted = [...STATE_FULL_NAMES].sort((a, b) => b.length - a.length);
    for (const name of sorted) {
        if (lower.includes(name.toLowerCase())) return name;
    }
    return undefined;
}

// True when the string is clearly a street-address fragment misclassified as
// a city — digit-only ("954"), leading "#" ("#2953/36/1"), leading "No." or
// "Plot"/"Shop"/"Flat"/"Building"/"Unit"/"Door", pure floor/stage labels
// ("2nd Stage", "Ground Floor"), or shorter than 3 / longer than 60 chars.
// Used by parseAddressComponents to reject the first-comma-segment that
// Google Places' formattedAddress often leads with for Indian addresses.
export function looksLikeAddressFragment(s: string | null | undefined): boolean {
    if (!s) return true;
    const t = s.trim();
    if (t.length < 3 || t.length > 60) return true;
    if (/^[#0-9]/.test(t)) return true;
    if (/^(no\.?|plot|shop|flat|building|unit|door|gala|h\.?\s*no|d\.?\s*no|s\.?\s*no|opp\.?|near|behind|beside)\b/i.test(t)) return true;
    if (/^\d+(st|nd|rd|th)\s+(stage|cross|main|floor|phase|block|sector|street)\b/i.test(t)) return true;
    if (/^(ground|first|second|third|fourth|fifth)\s+floor\b/i.test(t)) return true;
    return false;
}

// Pull a city + state + pincode out of a Google Places formattedAddress by
// walking comma segments from the END, anchored on the 6-digit Indian PIN.
//   "Shop No. 40, 2nd Stage, 3615/1, Mysuru Road, Mysuru, Karnataka 570001, India"
//     -> { city: "Mysuru", state: "Karnataka", pincode: "570001" }
//   "#2953/36/1, Belagavi, Karnataka, India"  (no pincode)
//     -> { city: "Belagavi", state: "Karnataka" }
// When the city candidate doesn't normalize to a known city AND
// looksLikeAddressFragment rejects it, returns city: undefined so callers
// can fall back to the chunk-target city embedded in source_query.
export function parseAddressComponents(address: string | null | undefined): {
    city?: string;
    state?: string;
    pincode?: string;
} {
    if (!address) return {};

    const segments = address
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        // Drop trailing country tokens — Google Places always appends "India"
        // and a handful of rows say "Bharat".
        .filter((s) => !/^(india|bharat)$/i.test(s));

    if (!segments.length) return {};

    const pinRe = /\b[1-9]\d{5}\b/;
    let pincode: string | undefined;
    let stateCandidate: string | undefined;
    let cityCandidate: string | undefined;

    // Walk from the end looking for a segment containing the PIN. The
    // pincode segment is typically "<State> <Pincode>" (e.g. "Karnataka
    // 570001"); occasionally it's just the bare pincode.
    let pinIdx = -1;
    for (let i = segments.length - 1; i >= 0; i--) {
        const m = segments[i].match(pinRe);
        if (m) {
            pincode = m[0];
            pinIdx = i;
            const withoutPin = segments[i].replace(pinRe, "").trim();
            if (withoutPin) stateCandidate = withoutPin;
            break;
        }
    }

    if (pinIdx === -1) {
        // No PIN — last segment is the state candidate, second-to-last the city.
        stateCandidate = segments[segments.length - 1];
        if (segments.length >= 2) cityCandidate = segments[segments.length - 2];
    } else {
        // PIN found. If the pincode segment was bare (no state text in it),
        // step one segment back for the state candidate.
        if (!stateCandidate && pinIdx >= 1) {
            stateCandidate = segments[pinIdx - 1];
            if (pinIdx >= 2) cityCandidate = segments[pinIdx - 2];
        } else if (pinIdx >= 1) {
            cityCandidate = segments[pinIdx - 1];
        }
    }

    // Resolve state. Trust normalizeState first (alias map), then fall back to
    // scanning the whole address for any known state name — handles cases
    // where the pin segment had garbage like "Karnataka State" attached.
    let state = normalizeState(stateCandidate);
    if (!state || !Object.values(STATE_ALIASES).includes(state)) {
        const fromAddr = extractStateFromAddress(address);
        if (fromAddr) state = fromAddr;
    }

    // Resolve city. Prefer the known-city path (CITY_ALIASES or CITY_TO_STATE
    // keys) so we always emit canonical spellings. If the candidate is
    // clearly a street-address fragment, return city: undefined so the
    // caller can fall back to the chunk-target city.
    let city: string | undefined;
    if (cityCandidate) {
        const normalized = normalizeCity(cityCandidate);
        const lower = normalized?.toLowerCase();
        const isKnown =
            !!lower &&
            (Object.values(CITY_ALIASES).some((v) => v.toLowerCase() === lower) ||
                Object.keys(CITY_TO_STATE).some((v) => v.toLowerCase() === lower));
        if (isKnown) {
            city = normalized;
        } else if (!looksLikeAddressFragment(normalized)) {
            // Unknown but plausible (e.g. a city we haven't mapped yet, like
            // "Belagavi"). Keep it — better to surface a new real city than
            // drop the lead.
            city = normalized;
        }
    }

    return { city, state, pincode };
}

// Pull the target city out of a chunk combination_query like
// "e rickshaw battery in Mysuru" -> "Mysuru" (normalized). The chunk builder
// at chunkedPipeline.ts always uses `${variation} in ${city}`, so the city
// is the trailing token after the last " in ". Returns undefined when the
// pattern doesn't match.
export function extractTargetCityFromQuery(
    query: string | null | undefined,
): string | undefined {
    if (!query) return undefined;
    const m = query.match(/\bin\s+([A-Za-z][A-Za-z\s\-']{1,60})$/i);
    if (!m) return undefined;
    const raw = m[1].trim();
    if (!raw) return undefined;
    return normalizeCity(raw);
}

export function isPhoneValid(phone: string | undefined): boolean {
    if (!phone) return false;
    return /^\+91\d{10}$/.test(phone);
}

export function calculateQualityScore(record: RawDealerRecord): number {
    let score = 0;
    if (record.phone) score++;
    if (record.city) score++;
    if (record.dealer_name && record.dealer_name.length > 3) score++;
    if (record.source_url) score++;
    if (record.state || record.address) score++;
    return Math.max(1, score);
}

export function enrichRecord(record: RawDealerRecord): RawDealerRecord & {
    quality_score: number;
    phone_valid: boolean;
} {
    return {
        ...record,
        city: normalizeCity(record.city),
        state: normalizeState(record.state),
        quality_score: calculateQualityScore(record),
        phone_valid: isPhoneValid(record.phone),
    };
}

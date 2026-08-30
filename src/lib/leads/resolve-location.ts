/**
 * Resolve a customer's free-text address (OCR'd from an Aadhaar back / address
 * proof) to the canonical `country-state-city` state + city names.
 *
 * WHY THIS EXISTS. The BRE (`src/lib/bre/match.ts`) matches NBFC loan products
 * on an exact `state` + `city` string equality against
 * `nbfc_loan_products.active_locations`, and those entries are the
 * `country-state-city` names the admin picked from a dropdown. A lead whose
 * city never resolved is left at the `'Unknown'` placeholder, fails the
 * location rule on every product, and drops through to the Bajaj Finance card
 * — even when a partner covers the customer's district.
 *
 * Rural Aadhaar cards rarely print the "city" a lender thinks in. They print
 * the village in the city slot, the taluka after "Tal-", and the district after
 * "Dist-" — frequently in a regional script. So the lead's city is resolved by
 * trying, in order, every unit the card gives us:
 *
 *   printed city → district → taluka → each comma-segment of the full address
 *   → the PIN code (India Post: district / block / division of the PIN)
 *
 * The first one that is a `country-state-city` city of the resolved state wins.
 * The PIN step is what makes this script-independent: "नाशिक" never matches
 * "Nashik", but 422304 always resolves to Nashik district.
 *
 * Only confident matches are returned; an unmatched value is left undefined so
 * the dealer picks it manually rather than us storing a value the wizard's
 * State/City <select>s cannot show.
 */

import { and, eq, inArray } from "drizzle-orm";
import { City, State } from "country-state-city";

import { db } from "@/lib/db";
import { kycDocuments, leads } from "@/lib/db/schema";

// Regional-script / common-variant spellings of state names as printed on the
// non-English side of Aadhaar cards. Gemini sometimes reads that side instead
// of the English one, and the country-state-city lookup is English-only.
const STATE_NAME_ALIASES: Record<string, string> = {
  "महाराष्ट्र": "Maharashtra",
  "उत्तर प्रदेश": "Uttar Pradesh",
  "मध्य प्रदेश": "Madhya Pradesh",
  "राजस्थान": "Rajasthan",
  "हरियाणा": "Haryana",
  "दिल्ली": "Delhi",
  "नई दिल्ली": "Delhi",
  "बिहार": "Bihar",
  "गुजरात": "Gujarat",
  "पंजाब": "Punjab",
  "उत्तराखंड": "Uttarakhand",
  "झारखंड": "Jharkhand",
  "छत्तीसगढ़": "Chhattisgarh",
  "कर्नाटक": "Karnataka",
  "ಕರ್ನಾಟಕ": "Karnataka",
  "तमिलनाडु": "Tamil Nadu",
  "தமிழ்நாடு": "Tamil Nadu",
  "तेलंगाना": "Telangana",
  "आंध्र प्रदेश": "Andhra Pradesh",
  "पश्चिम बंगाल": "West Bengal",
  "ओडिशा": "Odisha",
  "उड़ीसा": "Odisha",
  "orissa": "Odisha",
  "new delhi": "Delhi",
  "nct of delhi": "Delhi",
  "pondicherry": "Puducherry",
  "uttaranchal": "Uttarakhand",
};

// First two digits of an Indian PIN → state (India Post postal circles). Used
// only when the printed state name could not be resolved at all.
const PIN_PREFIX_STATE: Record<string, string> = {
  "11": "Delhi", "12": "Haryana", "13": "Haryana", "14": "Punjab", "15": "Punjab",
  "16": "Punjab", "17": "Himachal Pradesh", "18": "Jammu and Kashmir",
  "19": "Jammu and Kashmir", "20": "Uttar Pradesh", "21": "Uttar Pradesh",
  "22": "Uttar Pradesh", "23": "Uttar Pradesh", "24": "Uttarakhand",
  "25": "Uttar Pradesh", "26": "Uttar Pradesh", "27": "Uttar Pradesh",
  "28": "Uttar Pradesh", "30": "Rajasthan", "31": "Rajasthan", "32": "Rajasthan",
  "33": "Rajasthan", "34": "Rajasthan", "36": "Gujarat", "37": "Gujarat",
  "38": "Gujarat", "39": "Gujarat", "40": "Maharashtra", "41": "Maharashtra",
  "42": "Maharashtra", "43": "Maharashtra", "44": "Maharashtra", "45": "Madhya Pradesh",
  "46": "Madhya Pradesh", "47": "Madhya Pradesh", "48": "Madhya Pradesh",
  "49": "Chhattisgarh", "50": "Telangana", "51": "Andhra Pradesh", "52": "Andhra Pradesh",
  "53": "Andhra Pradesh", "56": "Karnataka", "57": "Karnataka", "58": "Karnataka",
  "59": "Karnataka", "60": "Tamil Nadu", "61": "Tamil Nadu", "62": "Tamil Nadu",
  "63": "Tamil Nadu", "64": "Tamil Nadu", "67": "Kerala", "68": "Kerala", "69": "Kerala",
  "70": "West Bengal", "71": "West Bengal", "72": "West Bengal", "73": "West Bengal",
  "74": "West Bengal", "75": "Odisha", "76": "Odisha", "77": "Odisha", "78": "Assam",
  "79": "Arunachal Pradesh", "80": "Bihar", "81": "Bihar", "82": "Jharkhand",
  "83": "Jharkhand", "84": "Bihar", "85": "Bihar",
};

/** The placeholder `customer-lead.ts` writes at lead creation. */
export const UNKNOWN_LOCATION = "Unknown";

export function isUnresolvedLocation(v: string | null | undefined): boolean {
  const s = (v ?? "").trim();
  return !s || s.toLowerCase() === UNKNOWN_LOCATION.toLowerCase();
}

export interface RawAddress {
  state?: string | null;
  city?: string | null;
  district?: string | null;
  taluka?: string | null;
  full_address?: string | null;
  pincode?: string | null;
}

export interface ResolvedLocation {
  state?: string;
  city?: string;
  /** Which input produced the city — useful in logs / verifier scripts. */
  cityFrom?: "city" | "district" | "taluka" | "address" | "pincode";
}

// ---------------------------------------------------------------------------
// India Post PIN lookup (public, key-less). One PIN → district / block /
// division, in English, regardless of what script the card was printed in.
// ---------------------------------------------------------------------------

interface PinInfo {
  state?: string;
  district?: string;
  /** Block ≈ taluka/tehsil; Division ≈ postal division (often the district HQ). */
  blocks: string[];
  divisions: string[];
}

const pinCache = new Map<string, PinInfo | null>();

async function lookupPincode(pin: string): Promise<PinInfo | null> {
  if (!/^\d{6}$/.test(pin)) return null;
  if (pinCache.has(pin)) return pinCache.get(pin) ?? null;
  let info: PinInfo | null = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`https://api.postalpincode.in/pincode/${pin}`, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    clearTimeout(t);
    if (res.ok) {
      const body = (await res.json()) as Array<{
        Status?: string;
        PostOffice?: Array<{
          District?: string;
          Block?: string;
          Division?: string;
          State?: string;
        }> | null;
      }>;
      const offices = body?.[0]?.PostOffice ?? [];
      if (offices.length > 0) {
        const uniq = (xs: Array<string | undefined>) =>
          Array.from(new Set(xs.filter((x): x is string => !!x && x.trim() !== "" && x !== "NA")));
        info = {
          state: offices[0]?.State,
          district: offices[0]?.District,
          blocks: uniq(offices.map((o) => o.Block)),
          divisions: uniq(offices.map((o) => o.Division)),
        };
      }
    }
  } catch {
    // Offline / timeout — the printed-text steps still ran; just no PIN help.
    info = null;
  }
  pinCache.set(pin, info);
  return info;
}

// ---------------------------------------------------------------------------

function resolveStateName(rawState: string, pincode: string, pinState?: string): string | undefined {
  const s = rawState.trim().toLowerCase();
  const states = State.getStatesOfCountry("IN");
  const byName = (name: string) =>
    states.find((st) => st.name.toLowerCase() === name.toLowerCase())?.name;
  if (s) {
    const direct = byName(s);
    if (direct) return direct;
    const alias = STATE_NAME_ALIASES[rawState.trim()] ?? STATE_NAME_ALIASES[s];
    if (alias) return byName(alias) ?? alias;
    // Tolerate "Maharashtra 422304" / "State: Maharashtra" style noise.
    const loose = states.find((st) => s.includes(st.name.toLowerCase()));
    if (loose) return loose.name;
  }
  if (pinState) {
    const fromApi = byName(pinState) ?? byName(STATE_NAME_ALIASES[pinState.toLowerCase()] ?? "");
    if (fromApi) return fromApi;
  }
  const pin = pincode.replace(/\D/g, "");
  if (pin.length === 6) {
    const st = PIN_PREFIX_STATE[pin.slice(0, 2)];
    if (st) return byName(st) ?? st;
  }
  return undefined;
}

const UNIT_PREFIX = /^\s*(tal|taluka|tehsil|teh|dist|district|po|post|at|vill|village|mu|blk|block)\b[-:. ]*/i;

/** Strip "Tal-", "Dist:", "Post " … prefixes and trailing PIN / punctuation. */
function cleanUnit(raw: string): string {
  return raw
    .replace(UNIT_PREFIX, "")
    .replace(/\b\d{6}\b/g, "")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Resolve state + city. Async because the last resort (PIN → district) is a
 * network lookup; everything before it is in-memory.
 */
export async function resolveLeadLocation(raw: RawAddress): Promise<ResolvedLocation> {
  const out: ResolvedLocation = {};
  const rawState = raw.state ?? "";
  const rawCity = raw.city ?? "";
  const rawDistrict = raw.district ?? "";
  const rawTaluka = raw.taluka ?? "";
  const rawFullAddress = raw.full_address ?? "";
  const pincode =
    (raw.pincode ?? "").replace(/\D/g, "").slice(0, 6) ||
    (rawFullAddress.match(/\b\d{6}\b/)?.[0] ?? "");

  // The PIN lookup is consulted for the state only when the printed state is
  // unusable, and for the city only when nothing printed matched — but it's
  // cheap (cached) so fetch it once up front when we have a PIN at all.
  const pin = pincode.length === 6 ? await lookupPincode(pincode) : null;

  const stateName = resolveStateName(rawState, pincode, pin?.state);
  if (!stateName) return out;
  const stateMatch = State.getStatesOfCountry("IN").find((st) => st.name === stateName);
  if (!stateMatch) return out;
  out.state = stateMatch.name;

  const cities = City.getCitiesOfState("IN", stateMatch.isoCode);
  const findCity = (rawUnit: string): string | undefined => {
    const c = cleanUnit(rawUnit).toLowerCase();
    if (!c) return undefined;
    // Exact (case-insensitive) first; else tolerate the "Allahabad" ⇄
    // "Allahabad City" / "Nashik" ⇄ "Nashik Division" prefix difference
    // between OCR text and the package name.
    const hit =
      cities.find((ct) => ct.name.toLowerCase() === c) ||
      cities.find((ct) => {
        const n = ct.name.toLowerCase();
        return c.startsWith(n) || n.startsWith(c);
      });
    return hit?.name;
  };

  // Address goes small → large ("village, taluka, district, state, PIN"), so
  // walk it largest-unit-first: a district name is a far better "city" for a
  // lender than a village that happens to share a name with some town.
  const rawSegments = rawFullAddress.split(/[,\n]/).map((t) => t.trim());
  // "Dist- Nashik" / "Tal- Niphad" segments are the district / taluka even
  // when the extractor didn't fill those fields — rank them with their unit,
  // not as anonymous address text, so the district still beats the taluka.
  const tagged = (re: RegExp) => rawSegments.filter((t) => re.test(t)).map(cleanUnit);
  const distFromAddress = tagged(/^\s*(dist|district)\b/i);
  const talFromAddress = tagged(/^\s*(tal|taluka|tehsil|teh|blk|block)\b/i);
  const segments = rawSegments
    .map(cleanUnit)
    .filter((t) => t && !/^\d+$/.test(t))
    .reverse();

  const attempts: Array<[ResolvedLocation["cityFrom"], string[]]> = [
    ["city", [rawCity]],
    ["district", [rawDistrict, ...distFromAddress]],
    ["taluka", [rawTaluka, ...talFromAddress]],
    ["address", segments],
    ["pincode", pin ? [pin.district ?? "", ...pin.divisions, ...pin.blocks] : []],
  ];
  for (const [from, candidates] of attempts) {
    for (const cand of candidates) {
      const city = findCity(cand);
      if (city) {
        out.city = city;
        out.cityFrom = from;
        return out;
      }
    }
  }
  return out;
}

/**
 * Re-resolve a lead whose state/city is still the `'Unknown'` placeholder from
 * the address document already on file (kyc_documents.ocr_data), and persist
 * whatever resolves. Used at Step 4 so a lead captured before the resolver
 * learned about districts / PINs still gets its lenders instead of Bajaj.
 *
 * Returns the (possibly updated) state/city. Never throws.
 */
export async function reresolveLeadLocationFromDocs(
  leadId: string,
): Promise<{ state: string | null; city: string | null; changed: boolean }> {
  const [lead] = await db
    .select({ state: leads.state, city: leads.city })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!lead) return { state: null, city: null, changed: false };
  if (!isUnresolvedLocation(lead.state) && !isUnresolvedLocation(lead.city)) {
    return { state: lead.state, city: lead.city, changed: false };
  }

  try {
    const docs = await db
      .select({ doc_type: kycDocuments.doc_type, ocr: kycDocuments.ocr_data, created: kycDocuments.created_at })
      .from(kycDocuments)
      .where(
        and(
          eq(kycDocuments.lead_id, leadId),
          eq(kycDocuments.doc_for, "customer"),
          inArray(kycDocuments.doc_type, ["aadhaar_back", "address_proof"]),
        ),
      );
    // Aadhaar first (authoritative), newest first within a type.
    docs.sort((a, b) => {
      if (a.doc_type !== b.doc_type) return a.doc_type === "aadhaar_back" ? -1 : 1;
      return (b.created?.getTime() ?? 0) - (a.created?.getTime() ?? 0);
    });

    for (const d of docs) {
      const f = (d.ocr ?? {}) as Record<string, unknown>;
      const s = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
      const loc = await resolveLeadLocation({
        state: s(f.state),
        city: s(f.city),
        district: s(f.district),
        taluka: s(f.taluka),
        full_address: s(f.full_address),
        pincode: s(f.pincode),
      });
      const patch: Partial<typeof leads.$inferInsert> = {};
      if (loc.state && isUnresolvedLocation(lead.state)) patch.state = loc.state;
      if (loc.city && isUnresolvedLocation(lead.city)) patch.city = loc.city;
      if (Object.keys(patch).length === 0) continue;
      patch.updated_at = new Date();
      await db.update(leads).set(patch).where(eq(leads.id, leadId));
      return {
        state: patch.state ?? lead.state,
        city: patch.city ?? lead.city,
        changed: true,
      };
    }
  } catch (e) {
    console.warn("[resolve-location] re-resolve failed for", leadId, e);
  }
  return { state: lead.state, city: lead.city, changed: false };
}

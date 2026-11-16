/**
 * AI dialer list item 3 (13 Nov 2026): the short shop name the agent says out
 * loud. Listing titles come from Google Maps and are written for search, not
 * speech: "Bansal Battery House - exide Car Battery | Amaron Car Battery
 * Dealer Saket", "TVS - Dynamic Motors Pvt Ltd", "K.G.N SCRAP TRADERS". The
 * agent reading those verbatim sounds like a robot and loses the dealer in
 * the first three seconds.
 *
 * Pure and rule-based: no I/O, no LLM. A rep can override the result per lead
 * (dealer_lead_spoken_names, E-378); the override always wins.
 */

/** A segment that is only a brand / OEM banner in front of the real name. */
const BRAND_PREFIX_RE =
    /^(?:eastman(?:\s+dealer)?|tvs|exide(?:\s+care)?|livguard|luminous|amaron(?:\s+pitstop)?|okaya|microtek|montra(?:\s+electric)?|jk\s+tyres?|bridgestone(?:\s+select)?|michelin(?:\s+tyres?(?:\s*&\s*services)?)?|hero(?:\s+moto\s*corp)?|bajaj(?:\s+auto)?|ather|ola(?:\s+electric)?|sf\s+powerbay|electricpe|chetak(?:\s+ev(?:\s+scooter)?)?|suzuki|yamaha|honda|battery\s+shop|[\w ]+\s+(?:dealer|distributor)s?)$/i;

/** Search-engine tails: everything from here on is SEO, not the name. */
const SEO_CUT_RE =
    /\s+(?:best|near\s+me|authori[sz]ed|dealers?\b|distributors?\b|wholesalers?\b|manufacturers?\b|shop\s+in|store\s+in|in\s+[A-Z][a-z]+)\b.*$/;

/** A legal form ends the name; whatever follows it is a listing tail. */
const LEGAL_CUT_RE = /\s+(?:pvt\.?\s*ltd\.?|private\s+limited|\(p\)\s*ltd\.?)(?:\s.*)?$/i;

/** Always dropped from the end: legal forms. */
const LEGAL_TAIL_RE = /\s+(?:pvt\.?|ltd\.?|limited|llp|\(regd\.?\)|regd\.?|inc\.?)$/i;

/** Dropped from the end only when two words of name are left without it. */
const GENERIC_TAIL_RE =
    /\s+(?:enterprises?|traders?|trading(?:\s+co(?:mpany)?)?|agenc(?:y|ies)|(?:&|and)\s+sons|distributors?|dealers?|co\.?|company)$/i;

/** Never the last word of a spoken name ("Shyam Battery and", "Auto Electrical &"). */
const DANGLING_RE = /\s+(?:and|&|of|for|the|in|at|by)$/i;

/** Short all-caps words that are words, not initials: read as words. */
const CAPS_WORDS = new Set(["NEW", "OLD", "THE", "AND", "SRI", "OM", "JAI", "MAA", "RAJ", "RAM", "SAI", "DEV", "CAR"]);

const MAX_WORDS = 3;

/** "SHREYAS BATTERY HOUSE" → "Shreyas Battery House"; short caps (TVS, EV, AB) stay. */
function speakableCase(word: string): string {
    const isCaps = word === word.toUpperCase() && /[A-Z]/.test(word);
    if (isCaps && word.length <= 3 && !CAPS_WORDS.has(word)) return word;
    if (isCaps) return word.charAt(0) + word.slice(1).toLowerCase();
    return word.charAt(0).toUpperCase() + word.slice(1);
}

function tidy(s: string): string {
    return (
        s
            .replace(/\([^)]*\)?/g, " ") // "(BANDA)", "(Luminous Distributor)", an unclosed "(…"
            // "K.G.N" / "M. S." / "R.R.CYCLE" / "S.M.SUBHANI" → spaced letters …
            .replace(/\b([A-Za-z])\.\s*/g, (_m, c: string) => `${c.toUpperCase()} `)
            // … and runs of single capitals join: "T N G" → "TNG", "S M Solar" → "SM Solar".
            .replace(/\b[A-Z](?:\s+[A-Z]\b(?!-))+/g, (m) => m.replace(/\s+/g, ""))
            .replace(/\s+/g, " ")
            .trim()
    );
}

function words(s: string): string[] {
    return s.split(" ").filter(Boolean);
}

const SEGMENT_SPLIT_RE =
    /\s+[-–—|·/]\s+|\s*\|\s*|\s*--+\s*|[,:/]|\s+-(?=[A-Z])|(?<=\S)-\s+|(?<=[A-Za-z]{3})-(?=[A-Za-z]{3})/;

/** The name a person would say on the phone, or "" when there is no name. */
export function spokenShopName(raw: string | null | undefined): string {
    // A pasted title can hold several shops, one per line: the first is the name.
    const firstLine = (raw ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "";
    const full = firstLine.replace(/\s+/g, " ").trim();
    if (!full) return "";

    // 1. Split the listing title into segments and pick the one that is the name.
    const segments = full
        .split(SEGMENT_SPLIT_RE)
        .map((s) => tidy(s))
        .filter(Boolean);
    let name = segments[0] ?? "";
    // "Exide Care - Jay Batteries" → the dealer; but "Chetak EV Scooter - Mysore"
    // has a one-word city after the brand, which is not a name.
    if (segments.length > 1 && BRAND_PREFIX_RE.test(name) && words(segments[1]).length >= 2) {
        name = segments[1];
    }

    // 2. Cut search-engine tails, then legal and generic suffixes.
    name = name.replace(SEO_CUT_RE, "").replace(LEGAL_CUT_RE, "").trim();
    for (let i = 0; i < 4; i++) {
        const before = name;
        name = name.replace(LEGAL_TAIL_RE, "").trim();
        const withoutGeneric = name.replace(GENERIC_TAIL_RE, "").trim();
        if (withoutGeneric !== name && words(withoutGeneric).length >= 2) name = withoutGeneric;
        if (name === before) break;
    }
    name = name.replace(/^m\/s\.?\s+/i, "").trim();

    // 3. At most three words, no dangling "and", in a case the TTS reads as words.
    let out = words(name).slice(0, MAX_WORDS).join(" ").replace(/[\s.,&:;\-–—|·]+$/g, "");
    while (DANGLING_RE.test(out)) out = out.replace(DANGLING_RE, "").replace(/[\s.,&:;\-]+$/g, "");
    out = words(out).map(speakableCase).join(" ");
    if (out) return out;
    return words(tidy(full)).slice(0, MAX_WORDS).map(speakableCase).join(" ");
}

/** The override a rep set, else the computed name. */
export function resolveSpokenName(
    shopName: string | null | undefined,
    override: string | null | undefined,
): string {
    const o = (override ?? "").trim();
    return o || spokenShopName(shopName);
}

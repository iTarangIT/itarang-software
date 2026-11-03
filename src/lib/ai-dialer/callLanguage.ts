// AI dialer — which language a dealer is called in (3 Nov 2026, item 2).
//
// Priya opens in Hindi. When the dealer answers in another language the voice
// agent switches (ElevenLabs language_detection + language_presets) and reports
// what it spoke in the data-collection field `call_language`. The finalizer
// stores that on dealer_leads.language, so the NEXT call can open in it.
//
// dealer_leads.language already holds lower-case English names ("hindi"), so
// that is the stored form; the agent speaks ISO 639-1 codes.
//
// Pure: no db, no env — vitest covers it.

export const AGENT_LANGUAGES = ["hi", "mr", "kn", "en", "gu", "bn", "pa"] as const;
export type AgentLanguage = (typeof AGENT_LANGUAGES)[number];

/** The agent's default; a call in it needs no override. */
export const DEFAULT_AGENT_LANGUAGE: AgentLanguage = "hi";

const STORED_NAME: Record<AgentLanguage, string> = {
    hi: "hindi",
    mr: "marathi",
    kn: "kannada",
    en: "english",
    gu: "gujarati",
    bn: "bengali",
    pa: "punjabi",
};

const ALIASES: Record<string, AgentLanguage> = {
    hi: "hi",
    hindi: "hi",
    hinglish: "hi",
    "हिंदी": "hi",
    "हिन्दी": "hi",
    mr: "mr",
    marathi: "mr",
    "मराठी": "mr",
    kn: "kn",
    kannada: "kn",
    "ಕನ್ನಡ": "kn",
    en: "en",
    english: "en",
    gu: "gu",
    gujarati: "gu",
    "ગુજરાતી": "gu",
    bn: "bn",
    bengali: "bn",
    bangla: "bn",
    "বাংলা": "bn",
    pa: "pa",
    punjabi: "pa",
    panjabi: "pa",
    "ਪੰਜਾਬੀ": "pa",
};

/** Any stored or reported spelling → the agent's code, or null when unknown. */
export function toAgentLanguage(raw: string | null | undefined): AgentLanguage | null {
    const key = (raw ?? "").trim().toLowerCase();
    if (!key) return null;
    // "en-IN", "hi_IN" → the language part.
    return ALIASES[key] ?? ALIASES[key.split(/[-_]/)[0]] ?? null;
}

/** The value written to dealer_leads.language. */
export function storedLanguageName(code: AgentLanguage): string {
    return STORED_NAME[code];
}

/**
 * The language override for an outbound call: only when the dealer is known to
 * speak something other than the default. null → let the agent open in Hindi.
 */
export function openingLanguageOverride(stored: string | null | undefined): AgentLanguage | null {
    const code = toAgentLanguage(stored);
    return code && code !== DEFAULT_AGENT_LANGUAGE ? code : null;
}

/**
 * What to write back after a call, or null to leave the lead alone. Only a call
 * where a person spoke counts — a voicemail or IVR "language" says nothing
 * about the dealer.
 */
export function languageToStore(input: {
    callLanguage: string | null | undefined;
    dealerSpoke: boolean;
    current: string | null | undefined;
}): string | null {
    if (!input.dealerSpoke) return null;
    const code = toAgentLanguage(input.callLanguage);
    if (!code) return null;
    const name = storedLanguageName(code);
    return toAgentLanguage(input.current) === code ? null : name;
}

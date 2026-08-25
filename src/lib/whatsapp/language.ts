/**
 * WhatsApp bot output language — the pure, DB-free half.
 *
 * Constants, the type and the normaliser live here so the translating adapter
 * and unit tests can import them without pulling in the Drizzle client
 * (`@/lib/db` throws at import time when DATABASE_URL is unset). The DB-backed
 * read/write + cache lives in language-settings.ts.
 */

export const WHATSAPP_LANGUAGES = ["english", "hindi", "hinglish"] as const;
export type WhatsAppLanguage = (typeof WHATSAPP_LANGUAGES)[number];

export const WHATSAPP_LANGUAGE_LABELS: Record<WhatsAppLanguage, string> = {
  english: "English",
  hindi: "Hindi (हिंदी)",
  hinglish: "Hinglish",
};

export type WhatsAppLanguageSettings = {
  language: WhatsAppLanguage;
};

export const DEFAULT_WHATSAPP_LANGUAGE_SETTINGS: WhatsAppLanguageSettings = {
  language: "english",
};

export function isWhatsAppLanguage(raw: unknown): raw is WhatsAppLanguage {
  return (
    typeof raw === "string" &&
    (WHATSAPP_LANGUAGES as readonly string[]).includes(raw)
  );
}

/**
 * Normalise whatever is in the jsonb column into a complete settings object.
 * Unknown / missing language → keep the base value, never throw.
 */
export function normalizeWhatsAppLanguageSettings(
  raw: unknown,
  base: WhatsAppLanguageSettings = DEFAULT_WHATSAPP_LANGUAGE_SETTINGS,
): WhatsAppLanguageSettings {
  const patch = (raw && typeof raw === "object" ? raw : {}) as {
    language?: unknown;
  };
  const lang =
    typeof patch.language === "string" ? patch.language.toLowerCase() : undefined;
  return {
    language: isWhatsAppLanguage(lang) ? lang : base.language,
  };
}

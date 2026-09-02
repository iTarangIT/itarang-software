/**
 * WhatsApp bot output language — one global switch for every flow.
 *
 * Stored as one jsonb blob under the `whatsapp_language` key in `app_settings`,
 * the same store `kyc_auto_approval`, `nbfc_request_sla` and `gdrive_mirror`
 * use. Set from /admin/settings/whatsapp/language; read by the translating
 * adapter (`translating-adapter.ts`) on every outbound send.
 *
 * Because it is read on EVERY send, the value is cached in-process for a short
 * window rather than hitting the DB each time. A change made in the admin
 * clears the local cache immediately and reaches other processes (the BullMQ
 * worker, a second PM2 instance) within LANGUAGE_CACHE_TTL_MS.
 *
 * DEFAULT IS ENGLISH: deploying this changes nothing until an admin picks a
 * language — and English is a pass-through with no Gemini call at all.
 */

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";

import {
  DEFAULT_WHATSAPP_LANGUAGE_SETTINGS,
  normalizeWhatsAppLanguageSettings,
  type WhatsAppLanguage,
  type WhatsAppLanguageSettings,
} from "./language";

const SETTINGS_KEY = "whatsapp_language";

export {
  DEFAULT_WHATSAPP_LANGUAGE_SETTINGS,
  WHATSAPP_LANGUAGES,
  WHATSAPP_LANGUAGE_LABELS,
  isWhatsAppLanguage,
  normalizeWhatsAppLanguageSettings,
} from "./language";
export type { WhatsAppLanguage, WhatsAppLanguageSettings } from "./language";

/** Read the stored settings. Never throws — a DB hiccup must not block a send. */
export async function getWhatsAppLanguageSettings(): Promise<WhatsAppLanguageSettings> {
  try {
    const [row] = await db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, SETTINGS_KEY))
      .limit(1);
    return normalizeWhatsAppLanguageSettings(row?.value);
  } catch (err) {
    console.error("[whatsapp-language] failed to read settings:", err);
    return { ...DEFAULT_WHATSAPP_LANGUAGE_SETTINGS };
  }
}

export async function setWhatsAppLanguageSettings(
  patch: Partial<WhatsAppLanguageSettings>,
): Promise<WhatsAppLanguageSettings> {
  const current = await getWhatsAppLanguageSettings();
  const next = normalizeWhatsAppLanguageSettings(patch, current);
  const now = new Date();

  await db
    .insert(appSettings)
    .values({ key: SETTINGS_KEY, value: next, updated_at: now })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: next, updated_at: now },
    });

  clearWhatsAppLanguageCache();
  return next;
}

// ---------------------------------------------------------------------------
// Per-process cache for the hot read path.

export const LANGUAGE_CACHE_TTL_MS = 30_000;

let cached: { language: WhatsAppLanguage; at: number } | null = null;

/** The language every outbound message should be sent in, cached ~30 s. */
export async function getWhatsAppLanguage(): Promise<WhatsAppLanguage> {
  if (cached && Date.now() - cached.at < LANGUAGE_CACHE_TTL_MS) {
    return cached.language;
  }
  const { language } = await getWhatsAppLanguageSettings();
  cached = { language, at: Date.now() };
  return language;
}

export function clearWhatsAppLanguageCache(): void {
  cached = null;
}

/**
 * Green Energy News — settings (E-306).
 *
 * One jsonb blob under `green_news` in app_settings (same store as
 * kyc_auto_approval / nbfc_request_sla / the digests). Read merges the stored
 * patch over the defaults and never throws — the ticker must not die on a DB
 * hiccup and the card would rather show defaults than an error.
 *
 * No admin UI in v1: edit the row to add feeds / queries or switch it off.
 */

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";

import { DEFAULT_GREEN_NEWS_SETTINGS, GREEN_NEWS_SETTINGS_KEY, normalizeGreenNewsSettings } from "./settings-core";
import type { GreenNewsSettings } from "./settings-core";

export {
  DEFAULT_GREEN_NEWS_SETTINGS,
  GREEN_NEWS_SETTINGS_KEY,
  normalizeGreenNewsSettings,
  type GreenNewsSettings,
} from "./settings-core";

export async function getGreenNewsSettings(): Promise<GreenNewsSettings> {
  try {
    const [row] = await db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, GREEN_NEWS_SETTINGS_KEY))
      .limit(1);
    return normalizeGreenNewsSettings(row?.value);
  } catch (err) {
    console.error("[green-news] failed to read settings:", err instanceof Error ? err.message : err);
    return { ...DEFAULT_GREEN_NEWS_SETTINGS };
  }
}

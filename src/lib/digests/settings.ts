/**
 * Digest settings — the database half (E-287, generalised by E-288).
 *
 * One jsonb blob per kind, under that kind's `settingsKey` in `app_settings` —
 * the same generic key/value store used by `kyc_auto_approval`,
 * `nbfc_request_sla` and `fx_rates_fallback`. A dedicated table would buy
 * nothing: these are singletons read by one ticker and written by one admin form.
 *
 * The read path merges the stored patch over the kind's DEFAULTS rather than
 * trusting the row to be complete, so adding a field — or a new section to a
 * descriptor — is not a data migration. Rows written before it existed simply
 * pick up its default.
 *
 * The shape, the defaults, the validation and the schedule are all in
 * ./schedule (pure, unit tested).
 */

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";

import { defaultSettings, normalizeSettings } from "./schedule";
import type { DigestSettings, DigestSettingsPatch } from "./schedule";
import type { DigestKindDescriptor } from "./types";

/**
 * Read a kind's settings. Never throws — a DB hiccup here must not take the
 * ticker down, and the settings screen would rather render defaults than an
 * error boundary.
 */
export async function getDigestSettings(
  kind: DigestKindDescriptor,
): Promise<DigestSettings> {
  try {
    const [row] = await db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, kind.settingsKey))
      .limit(1);
    return normalizeSettings(row?.value, kind.sections);
  } catch (err) {
    console.error(`[digest:${kind.id}] failed to read settings:`, err);
    return defaultSettings(kind.sections);
  }
}

/**
 * Merge a partial patch over the current settings and persist the whole object,
 * so a reader never has to know which generation of the shape it is looking at.
 */
export async function setDigestSettings(
  kind: DigestKindDescriptor,
  patch: DigestSettingsPatch,
): Promise<DigestSettings> {
  const current = await getDigestSettings(kind);
  const next = normalizeSettings(patch, kind.sections, current);
  const now = new Date();

  await db
    .insert(appSettings)
    .values({ key: kind.settingsKey, value: next, updated_at: now })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: next, updated_at: now },
    });

  return next;
}

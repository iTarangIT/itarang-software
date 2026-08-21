/**
 * NBFC request SLA settings (E-254).
 *
 * One jsonb blob under the `nbfc_request_sla` key in `app_settings`, exactly
 * like the E-246 KYC auto-approval blob (`kyc_auto_approval`) — a singleton read
 * by one ticker and written by one admin form.
 *
 * Two windows, both in WHOLE MINUTES (see auto-approval-settings.ts for why
 * minutes and not hours):
 *   forwardSlaMinutes — leg 1. From the moment an NBFC request / verdict lands
 *     with the admin until the sweep may auto-forward it to the dealer.
 *   pushSlaMinutes    — leg 2. From the moment the dealer's uploads land the
 *     request in admin review until the sweep may auto-verify them and push
 *     the request back to the NBFC.
 *
 * DEFAULTS ARE OFF. Deploying E-254 plus this code changes no behaviour until
 * an admin turns it on at /admin/settings/nbfc-request-sla. Leg 2 in
 * particular hands documents to a lender WITHOUT a human review, so it must
 * never switch itself on as a side effect of a deploy.
 *
 * The read path merges the stored patch over DEFAULTS, so adding a field here
 * is not a data migration.
 */

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import {
  clampSlaMinutes,
  MAX_SLA_MINUTES,
  MIN_SLA_MINUTES,
  SLA_PRESETS_MINUTES,
  formatSlaWindow,
} from "@/lib/kyc/auto-approval-settings";

// Re-exported so the form/API for THIS feature import one module and the
// two SLA features cannot drift apart on bounds, presets or wording.
export { clampSlaMinutes, MAX_SLA_MINUTES, MIN_SLA_MINUTES, SLA_PRESETS_MINUTES, formatSlaWindow };

const SETTINGS_KEY = "nbfc_request_sla";

export type NbfcRequestSlaSettings = {
  /** Master kill switch. Everything below is inert while this is false. */
  enabled: boolean;
  /** Leg 1 — whole minutes the admin has to act on an NBFC request/verdict. */
  forwardSlaMinutes: number;
  /** Leg 2 — whole minutes the admin has to review the dealer's uploads. */
  pushSlaMinutes: number;
  /** Auto-forward NBFC requests / verdicts to the dealer when leg 1 expires. */
  autoForwardToDealer: boolean;
  /** Auto-verify the uploads and push to the NBFC when leg 2 expires. */
  autoPushToNbfc: boolean;
};

export const DEFAULT_NBFC_REQUEST_SLA_SETTINGS: NbfcRequestSlaSettings = {
  enabled: false,
  forwardSlaMinutes: 240, // 4 hours
  pushSlaMinutes: 240, // 4 hours
  autoForwardToDealer: true,
  autoPushToNbfc: true,
};

function toBool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

/**
 * Normalise whatever is in the jsonb column into a complete settings object.
 * Exported so the API route validates a PUT body through the same funnel the
 * reader uses.
 */
export function normalizeNbfcRequestSlaSettings(
  raw: unknown,
  base: NbfcRequestSlaSettings = DEFAULT_NBFC_REQUEST_SLA_SETTINGS,
): NbfcRequestSlaSettings {
  const patch = (raw && typeof raw === "object" ? raw : {}) as Partial<
    Record<keyof NbfcRequestSlaSettings, unknown>
  >;
  return {
    enabled: toBool(patch.enabled, base.enabled),
    forwardSlaMinutes:
      patch.forwardSlaMinutes !== undefined
        ? clampSlaMinutes(patch.forwardSlaMinutes)
        : base.forwardSlaMinutes,
    pushSlaMinutes:
      patch.pushSlaMinutes !== undefined
        ? clampSlaMinutes(patch.pushSlaMinutes)
        : base.pushSlaMinutes,
    autoForwardToDealer: toBool(patch.autoForwardToDealer, base.autoForwardToDealer),
    autoPushToNbfc: toBool(patch.autoPushToNbfc, base.autoPushToNbfc),
  };
}

/**
 * Read the current settings. Never throws — this is read inside the NBFC raise
 * route, the verdict upsert and the dealer's upload path, none of which may
 * fail because a settings read hiccuped. Failing closed to `enabled: false`
 * is the safe direction: the request simply waits for a human.
 */
export async function getNbfcRequestSlaSettings(): Promise<NbfcRequestSlaSettings> {
  try {
    const [row] = await db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, SETTINGS_KEY))
      .limit(1);
    return normalizeNbfcRequestSlaSettings(row?.value);
  } catch (err) {
    console.error("[nbfc-request-sla] failed to read settings:", err);
    return { ...DEFAULT_NBFC_REQUEST_SLA_SETTINGS };
  }
}

/** Merge a partial patch over the current settings and persist the whole object. */
export async function setNbfcRequestSlaSettings(
  patch: Partial<NbfcRequestSlaSettings>,
): Promise<NbfcRequestSlaSettings> {
  const current = await getNbfcRequestSlaSettings();
  const next = normalizeNbfcRequestSlaSettings(patch, current);
  const now = new Date();
  await db
    .insert(appSettings)
    .values({ key: SETTINGS_KEY, value: next, updated_at: now })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: next, updated_at: now },
    });
  return next;
}

/**
 * The leg-1 deadline to stamp when a request/verdict lands with the admin, or
 * null when the feature (or leg 1) is off — the sweep skips NULL, so a request
 * raised while disabled can never be auto-forwarded later by flipping the
 * switch on.
 */
export function forwardDueAtFrom(
  at: Date,
  settings: NbfcRequestSlaSettings,
): Date | null {
  if (!settings.enabled || !settings.autoForwardToDealer) return null;
  return new Date(at.getTime() + settings.forwardSlaMinutes * 60_000);
}

/** The leg-2 deadline to stamp when the dealer's uploads reach admin review. */
export function pushDueAtFrom(
  at: Date,
  settings: NbfcRequestSlaSettings,
): Date | null {
  if (!settings.enabled || !settings.autoPushToNbfc) return null;
  return new Date(at.getTime() + settings.pushSlaMinutes * 60_000);
}

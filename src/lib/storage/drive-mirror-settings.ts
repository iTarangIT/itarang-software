/**
 * Google Drive mirror settings (E-255).
 *
 * One jsonb blob under the `gdrive_mirror` key in `app_settings`, same shape of
 * thing as the E-254 NBFC-request-SLA blob: a singleton read by one ticker and
 * written by one admin form (/admin/settings/gdrive-mirror).
 *
 * What lives here vs. in env:
 *   - env  → the CREDENTIAL. The Drive mirror authenticates with the same
 *            service account the Sheets export and the expense scanner use
 *            (`GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_PRIVATE_KEY`).
 *   - here → the knobs an admin may reasonably flip without a deploy: the
 *            master switch, which Drive folder is the root of the backup, and
 *            (optionally) which Workspace user the service account acts as.
 *
 * Every knob also has an env fallback (`GDRIVE_MIRROR_ENABLED`,
 * `GDRIVE_MIRROR_ROOT_FOLDER_ID`, `GDRIVE_MIRROR_IMPERSONATE`) so a box can be
 * configured from .env alone; a value saved from the admin form wins over env.
 *
 * DEFAULT IS OFF. Deploying E-255 plus this code uploads nothing to Drive until
 * an admin turns it on. The ledger rows are still written while it is off (they
 * are cheap, and mean nothing is missed between deploy and switch-on) — the
 * ticker simply does not process them.
 */

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";

const SETTINGS_KEY = "gdrive_mirror";

export type DriveMirrorSettings = {
  /** Master switch. Ledger rows are still written while false; nothing is uploaded. */
  enabled: boolean;
  /**
   * Drive folder id that is the ROOT of the backup. Objects are laid out under
   * it as <root>/<logical bucket>/<key path…>. Null = not configured.
   */
  rootFolderId: string | null;
  /**
   * Workspace user the service account impersonates (domain-wide delegation).
   * When set, files are OWNED by this user and count against their quota;
   * when null the service account uploads as itself, which only works into a
   * Shared Drive (a service account has no My-Drive storage of its own).
   */
  impersonateUser: string | null;
};

function envBool(name: string): boolean | undefined {
  const v = (process.env[name] || "").trim().toLowerCase();
  if (!v) return undefined;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function envStr(name: string): string | null {
  const v = (process.env[name] || "").trim();
  return v || null;
}

export function defaultDriveMirrorSettings(): DriveMirrorSettings {
  return {
    enabled: envBool("GDRIVE_MIRROR_ENABLED") ?? false,
    rootFolderId: envStr("GDRIVE_MIRROR_ROOT_FOLDER_ID"),
    impersonateUser: envStr("GDRIVE_MIRROR_IMPERSONATE"),
  };
}

function toBool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

function toNullableStr(raw: unknown, fallback: string | null): string | null {
  if (raw === null) return null;
  if (typeof raw === "string") {
    const t = raw.trim();
    return t || null;
  }
  return fallback;
}

/** Normalise whatever is in the jsonb column into a complete settings object. */
export function normalizeDriveMirrorSettings(
  raw: unknown,
  base: DriveMirrorSettings = defaultDriveMirrorSettings(),
): DriveMirrorSettings {
  const patch = (raw && typeof raw === "object" ? raw : {}) as Partial<
    Record<keyof DriveMirrorSettings, unknown>
  >;
  return {
    enabled: toBool(patch.enabled, base.enabled),
    rootFolderId:
      patch.rootFolderId !== undefined
        ? toNullableStr(patch.rootFolderId, base.rootFolderId)
        : base.rootFolderId,
    impersonateUser:
      patch.impersonateUser !== undefined
        ? toNullableStr(patch.impersonateUser, base.impersonateUser)
        : base.impersonateUser,
  };
}

/**
 * Read the current settings. Never throws — this is consulted from inside the
 * S3 put path, which must not fail because a settings read hiccuped. Failing
 * closed to `enabled: false` is the safe direction: the row waits in the
 * ledger for the ticker.
 */
export async function getDriveMirrorSettings(): Promise<DriveMirrorSettings> {
  try {
    const [row] = await db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, SETTINGS_KEY))
      .limit(1);
    return normalizeDriveMirrorSettings(row?.value);
  } catch (err) {
    console.error("[gdrive-mirror] failed to read settings:", err);
    return defaultDriveMirrorSettings();
  }
}

/** Merge a partial patch over the current settings and persist the whole object. */
export async function setDriveMirrorSettings(
  patch: Partial<DriveMirrorSettings>,
): Promise<DriveMirrorSettings> {
  const current = await getDriveMirrorSettings();
  const next = normalizeDriveMirrorSettings(patch, current);
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

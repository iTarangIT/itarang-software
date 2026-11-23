/**
 * 23 Nov — app_settings 'dealer_check_settings' (see ./dealer-check-settings-rules.ts).
 * No migration: app_settings is a key → jsonb store that already exists.
 */
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";

import { normalizeDealerCheckSettings, type DealerCheckSettings } from "./dealer-check-settings-rules";

export * from "./dealer-check-settings-rules";

const KEY = "dealer_check_settings";

export async function getDealerCheckSettings(): Promise<DealerCheckSettings> {
  try {
    const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, KEY)).limit(1);
    return normalizeDealerCheckSettings(row?.value);
  } catch (err) {
    console.error("[dealer-check-settings] read failed:", err);
    return normalizeDealerCheckSettings(null);
  }
}

async function save(next: DealerCheckSettings): Promise<DealerCheckSettings> {
  const now = new Date();
  await db
    .insert(appSettings)
    .values({ key: KEY, value: next, updated_at: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: next, updated_at: now } });
  return next;
}

/** Replace the alert recipients (Settings › Dealer check alerts). Keeps the house approvers. */
export async function setDealerCheckRecipients(raw: unknown): Promise<DealerCheckSettings> {
  const cur = await getDealerCheckSettings();
  const next = normalizeDealerCheckSettings({ ...cur, recipients: raw });
  return save(next);
}

/** Turn "Can approve" on / off for one house team login. Keeps the recipients. */
export async function setHouseApprover(userId: string, on: boolean): Promise<DealerCheckSettings> {
  const cur = await getDealerCheckSettings();
  const ids = new Set(cur.houseApproverIds);
  if (on) ids.add(userId);
  else ids.delete(userId);
  return save(normalizeDealerCheckSettings({ ...cur, houseApproverIds: [...ids] }));
}

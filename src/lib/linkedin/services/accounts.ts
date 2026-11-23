/**
 * LinkedIn accounts (one Unipile-connected LinkedIn login each), their pacing
 * settings, health and pause (doc §6.4).
 */
import { asc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { liAccounts, liCampaigns, liSettings } from "@/lib/db/schema";
import { SYSTEM_PARTY } from "@/lib/notifications/provenance";

import { messagingProvider } from "../providers";
import type { AccountHealth } from "../providers/messaging/types";
import { logAction, todayCounts } from "./actionLog";
import { LINKEDIN_ROLES } from "../roles";
import { DEFAULT_SETTINGS, inviteCap, type PacingSettings } from "./pacing";

export type LiAccount = typeof liAccounts.$inferSelect;


export async function listAccounts(): Promise<LiAccount[]> {
  return db.select().from(liAccounts).orderBy(asc(liAccounts.created_at));
}

export async function getAccount(id: string): Promise<LiAccount | null> {
  const [row] = await db.select().from(liAccounts).where(eq(liAccounts.id, id)).limit(1);
  return row ?? null;
}

export async function createAccount(label: string, actorId: string | null): Promise<LiAccount> {
  const [row] = await db
    .insert(liAccounts)
    .values({ label: label.trim() || "LinkedIn account", created_by: actorId, owner_user_id: actorId })
    .returning();
  await db.insert(liSettings).values({ account_id: row.id }).onConflictDoNothing();
  return row;
}

export async function getSettings(accountId: string): Promise<PacingSettings> {
  const [row] = await db.select().from(liSettings).where(eq(liSettings.account_id, accountId)).limit(1);
  if (!row) return { ...DEFAULT_SETTINGS };
  const { account_id: _a, updated_at: _u, updated_by: _b, ...s } = row;
  return s;
}

export async function saveSettings(accountId: string, patch: Partial<PacingSettings>, actorId: string | null) {
  const merged = { ...(await getSettings(accountId)), ...patch };
  await db
    .insert(liSettings)
    .values({ account_id: accountId, ...merged, updated_by: actorId, updated_at: new Date() })
    .onConflictDoUpdate({
      target: liSettings.account_id,
      set: { ...merged, updated_by: actorId, updated_at: new Date() },
    });
  return merged;
}

/** Called from Unipile's hosted-auth notify webhook: attach the new account id. */
export async function attachProviderAccount(localId: string, providerAccountId: string): Promise<void> {
  await db
    .update(liAccounts)
    .set({
      provider_account_id: providerAccountId,
      status: "ok",
      status_reason: null,
      warmup_started_at: new Date(),
      updated_at: new Date(),
    })
    .where(eq(liAccounts.id, localId));
  await logAction({ accountId: localId, action: "connect", ok: true, detail: `provider account ${providerAccountId}` });
}

/**
 * Challenge / captcha / restriction → account paused, its campaigns paused,
 * the Sales Head and CEO alerted. No automatic re-login (doc §6.4).
 */
export async function pauseAccount(accountId: string, health: AccountHealth | "paused", reason: string): Promise<void> {
  const status = health === "ok" ? "paused" : health;
  await db
    .update(liAccounts)
    .set({ status, status_reason: reason.slice(0, 500), updated_at: new Date() })
    .where(eq(liAccounts.id, accountId));
  await db
    .update(liCampaigns)
    .set({ status: "paused", updated_at: new Date() })
    .where(eq(liCampaigns.account_id, accountId));
  await logAction({ accountId, action: "pause", ok: true, detail: `${status}: ${reason}` });
  await alertAccountPaused(accountId, status, reason);
}

export async function resumeAccount(accountId: string, actorId: string | null): Promise<void> {
  await db
    .update(liAccounts)
    .set({ status: "ok", status_reason: null, updated_at: new Date() })
    .where(eq(liAccounts.id, accountId));
  await logAction({ accountId, action: "resume", ok: true, actorId });
}

async function alertAccountPaused(accountId: string, status: string, reason: string): Promise<void> {
  try {
    const account = await getAccount(accountId);
    const { emit } = await import("@/lib/notifications/emit");
    await emit({
      type: "linkedin.account_paused",
      title: `LinkedIn account paused: ${account?.label ?? accountId}`,
      message: `Sending stopped (${status}). ${reason}`.slice(0, 500),
      from: SYSTEM_PARTY,
      to: [
        {
          audience: { kind: "roles", roles: [...LINKEDIN_ROLES] },
          as: SYSTEM_PARTY,
          href: "/sales-head/linkedin/accounts",
        },
      ],
    });
  } catch (err) {
    console.error("[linkedin] pause alert failed:", err instanceof Error ? err.message : err);
  }
}

/** Probe the provider and pause on a bad state. */
export async function checkHealth(account: LiAccount): Promise<AccountHealth | null> {
  if (!account.provider_account_id) return null;
  const health = await messagingProvider(account.provider).accountHealth(account.provider_account_id);
  await db.update(liAccounts).set({ last_health_at: new Date() }).where(eq(liAccounts.id, account.id));
  await logAction({ accountId: account.id, action: "health", ok: health === "ok", detail: health });
  if (health !== "ok" && account.status === "ok") {
    await pauseAccount(account.id, health, `Provider reports ${health}`);
  }
  return health;
}

/** Accounts screen: status, today's usage against caps. */
export async function accountsOverview(now = new Date()) {
  const accounts = await listAccounts();
  return Promise.all(
    accounts.map(async (a) => {
      const settings = await getSettings(a.id);
      const counts = await todayCounts(a.id, now);
      return {
        ...a,
        settings,
        today: {
          invites: counts.invites,
          invite_cap: inviteCap(settings, a.warmup_started_at, now),
          messages: counts.messages,
          message_cap: settings.messages_per_day,
        },
      };
    }),
  );
}

/**
 * Poll ticker (doc §6.3, Phase 2): every account's poll interval, sending
 * hours only.
 *   - account health → pause on challenge / restriction
 *   - acceptances    → invite_sent → accepted, message queued for the send ticker
 *   - invite expiry  → invite_expired after invite_expiry_days
 *   - replies        → conversations + messages (idempotent); a reply stops sends
 *
 * Only chats with a known prospect are imported — the module does not copy
 * the account's whole LinkedIn inbox into the CRM.
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { liAccounts, liCampaignProspects, liCampaigns, liProspects } from "@/lib/db/schema";

import { messagingProvider } from "../providers";
import { logAction } from "../services/actionLog";
import { checkHealth, getSettings, type LiAccount } from "../services/accounts";
import { syncChat } from "../services/inbox";
import { inviteExpired, pollDue, type PacingSettings } from "../services/pacing";
import { LIVE_STATES, nextState } from "../state/prospect-state";

const DAY_MS = 86_400_000;

export async function runPollTick(now = new Date(), opts: { force?: boolean } = {}) {
  const accounts = await db
    .select()
    .from(liAccounts)
    .where(and(eq(liAccounts.status, "ok"), sql`${liAccounts.provider_account_id} IS NOT NULL`));
  let polled = 0;
  for (const a of accounts) {
    const settings = await getSettings(a.id);
    if (!opts.force && !pollDue(settings, a.last_polled_at, now)) continue;
    try {
      await pollAccount(a, settings, now);
      polled++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[linkedin:poll] account ${a.id} failed:`, msg);
      await logAction({ accountId: a.id, action: "poll", ok: false, detail: msg });
    }
  }
  return { accounts: accounts.length, polled };
}

export async function pollAccount(account: LiAccount, settings: PacingSettings, now: Date) {
  const health = await checkHealth(account);
  if (health && health !== "ok") return;
  const provider = messagingProvider(account.provider);
  const ref = account.provider_account_id!;

  // ── acceptances + expiry
  const pending = await db
    .select({ cp: liCampaignProspects, p: liProspects })
    .from(liCampaignProspects)
    .innerJoin(liCampaigns, eq(liCampaigns.id, liCampaignProspects.campaign_id))
    .innerJoin(liProspects, eq(liProspects.id, liCampaignProspects.prospect_id))
    .where(and(eq(liCampaigns.account_id, account.id), eq(liCampaignProspects.state, "invite_sent")));
  if (pending.length) {
    const oldest = pending.reduce((m, r) => Math.min(m, r.cp.invite_sent_at?.getTime() ?? now.getTime()), now.getTime());
    const connected = new Set(await provider.listConnections(ref, new Date(oldest - DAY_MS)));
    for (const { cp, p } of pending) {
      if (p.provider_id && connected.has(p.provider_id)) {
        await db
          .update(liCampaignProspects)
          .set({ state: nextState("invite_sent", "accepted")!, accepted_at: now, next_action_at: now, updated_at: now })
          .where(eq(liCampaignProspects.id, cp.id));
        await db.update(liProspects).set({ connection_state: "connected" }).where(eq(liProspects.id, p.id));
      } else if (inviteExpired(settings, cp.invite_sent_at, now)) {
        await db
          .update(liCampaignProspects)
          .set({ state: nextState("invite_sent", "expire")!, next_action_at: null, updated_at: now })
          .where(eq(liCampaignProspects.id, cp.id));
      }
    }
  }

  // ── replies
  const since = account.last_polled_at
    ? new Date(account.last_polled_at.getTime() - 60 * 60_000)
    : new Date(now.getTime() - 7 * DAY_MS);
  const chats = await provider.listConversations(ref, since);
  const byProvider = new Map<string, { prospectId: string; campaignId: string | null }>();
  const attendeeIds = chats.map((c) => c.attendeeProviderId).filter((x): x is string => !!x);
  if (attendeeIds.length) {
    const rows = await db
      .select({ id: liProspects.id, provider_id: liProspects.provider_id })
      .from(liProspects)
      .where(inArray(liProspects.provider_id, attendeeIds));
    const live = rows.length
      ? await db
          .select({ prospect_id: liCampaignProspects.prospect_id, campaign_id: liCampaignProspects.campaign_id, state: liCampaignProspects.state })
          .from(liCampaignProspects)
          .where(inArray(liCampaignProspects.prospect_id, rows.map((r) => r.id)))
      : [];
    for (const r of rows) {
      const cp = live.find((l) => l.prospect_id === r.id && (LIVE_STATES as readonly string[]).includes(l.state)) ??
        live.find((l) => l.prospect_id === r.id);
      byProvider.set(r.provider_id!, { prospectId: r.id, campaignId: cp?.campaign_id ?? null });
    }
  }
  let inbound = 0;
  for (const chat of chats) {
    const link = chat.attendeeProviderId ? byProvider.get(chat.attendeeProviderId) : undefined;
    if (!link) continue;
    const messages = await provider.getConversation(ref, chat.chatId);
    const r = await syncChat({ accountId: account.id, chatId: chat.chatId, prospectId: link.prospectId, campaignId: link.campaignId, messages });
    inbound += r.newInbound;
  }

  await db.update(liAccounts).set({ last_polled_at: now }).where(eq(liAccounts.id, account.id));
  await logAction({ accountId: account.id, action: "poll", ok: true, detail: `${chats.length} chats, ${inbound} new replies, ${pending.length} invites checked` });
}

/**
 * The paced send ticker (doc §6.1–6.4). The ONLY code that calls
 * sendInvite / sendMessage. One action per account per tick, and only when:
 *
 *   - sends are allowed on this site (live CRM, or ALLOW_JOB_SENDS / LI_ALLOW_SENDS = 1),
 *   - the account is ok, inside its sending hours, past its random gap,
 *   - today's cap (counted from li_action_log) has room,
 *   - for campaign rows: a live approval exists and its hashes match what is
 *     about to be sent (acceptance test 1). A mismatch is refused, failed, logged.
 *
 * Rows are claimed with UPDATE … FOR UPDATE SKIP LOCKED and a 10-minute lease,
 * so two processes can never send the same row.
 */
import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  liAccounts,
  liApprovals,
  liCampaignProspects,
  liCampaigns,
  liConversations,
  liMessages,
  liOutbox,
  liProspects,
} from "@/lib/db/schema";
import { jobSendsAllowed } from "@/lib/runtime/liveSite";

import { approvalHashes, checkApproval } from "../lib/hash";
import { renderTemplate } from "../lib/render-template";
import { messagingProvider } from "../providers";
import type { AccountHealth } from "../providers/messaging/types";
import { lastSendAt, logAction, todayCounts } from "../services/actionLog";
import { getSettings, pauseAccount, type LiAccount } from "../services/accounts";
import { loadAttachment } from "../services/attachments";
import { canAct, gapFor, inSendingWindow } from "../services/pacing";
import { nextState, type ProspectState } from "../state/prospect-state";

const LEASE_MS = 10 * 60_000;
const RETRY_MS = 30 * 60_000;
const MAX_ATTEMPTS = 3;

export function linkedInSendsAllowed(): boolean {
  return jobSendsAllowed() || process.env.LI_ALLOW_SENDS?.trim() === "1";
}

export type SendTickResult = { accounts: number; sent: number; refused: number; skipped: string[] };

export async function runSendTick(now = new Date()): Promise<SendTickResult> {
  const result: SendTickResult = { accounts: 0, sent: 0, refused: 0, skipped: [] };
  if (!linkedInSendsAllowed()) {
    result.skipped.push("sends disabled on this site (set LI_ALLOW_SENDS=1 to allow)");
    return result;
  }
  const accounts = await db
    .select()
    .from(liAccounts)
    .where(and(eq(liAccounts.status, "ok"), sql`${liAccounts.provider_account_id} IS NOT NULL`));
  for (const account of accounts) {
    result.accounts++;
    try {
      const r = await tickAccount(account, now);
      if (r === "sent") result.sent++;
      else if (r === "refused") result.refused++;
      else if (r) result.skipped.push(`${account.label}: ${r}`);
    } catch (err) {
      console.error(`[linkedin:send] account ${account.id} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return result;
}

async function tickAccount(account: LiAccount, now: Date): Promise<string | null> {
  const settings = await getSettings(account.id);
  if (!inSendingWindow(settings, now)) return "outside sending hours";
  const last = await lastSendAt(account.id);
  const gapMs = last ? gapFor(settings, `${account.id}:${last.id}`) : 0;
  if (last && now.getTime() - last.at.getTime() < gapMs) return null; // waiting out the gap — normal

  const counts = await todayCounts(account.id, now);
  const base = { settings, counts, warmupStartedAt: account.warmup_started_at, lastActionAt: last?.at ?? null, gapMs, now };

  // 1. Admin replies typed in the inbox come first.
  if (canAct({ ...base, action: "message" }).ok) {
    const r = await sendOneReply(account, now);
    if (r) return r;
  }
  // 2. Campaign rows.
  return sendOneCampaignRow(account, base, now);
}

async function sendOneReply(account: LiAccount, now: Date): Promise<string | null> {
  const claimed = await db.execute(sql`
    UPDATE li_outbox SET status = 'sending'
    WHERE id = (
      SELECT o.id FROM li_outbox o
      JOIN li_conversations c ON c.id = o.conversation_id
      WHERE o.status = 'queued' AND c.account_id = ${account.id}
      ORDER BY o.created_at
      FOR UPDATE OF o SKIP LOCKED
      LIMIT 1
    )
    RETURNING id`);
  const id = (claimed as unknown as { id: string }[])[0]?.id;
  if (!id) return null;
  const [row] = await db
    .select({ o: liOutbox, c: liConversations, p: liProspects })
    .from(liOutbox)
    .innerJoin(liConversations, eq(liConversations.id, liOutbox.conversation_id))
    .leftJoin(liProspects, eq(liProspects.id, liConversations.prospect_id))
    .where(eq(liOutbox.id, id))
    .limit(1);
  if (!row) return null;
  if (row.p?.do_not_contact) {
    await db.update(liOutbox).set({ status: "failed", error: "do not contact" }).where(eq(liOutbox.id, id));
    return "refused";
  }
  const attachment = row.o.attachment_id ? await loadAttachment(row.o.attachment_id) : null;
  const res = await messagingProvider(account.provider).sendMessage(
    account.provider_account_id!,
    row.p?.provider_id ?? "",
    row.o.body,
    attachment ?? undefined,
    row.c.provider_chat_id,
  );
  if (res.ok) {
    await db.update(liOutbox).set({ status: "sent", sent_at: now, error: null }).where(eq(liOutbox.id, id));
    if (res.messageId) {
      await db
        .insert(liMessages)
        .values({
          conversation_id: row.c.id,
          provider_message_id: res.messageId,
          direction: "out",
          body: row.o.body,
          attachment_name: attachment?.fileName ?? null,
          sent_by: row.o.created_by,
          sent_at: now,
        })
        .onConflictDoNothing();
    }
    await db.update(liConversations).set({ last_message_at: now }).where(eq(liConversations.id, row.c.id));
    await logAction({ accountId: account.id, action: "reply", ok: true, prospectId: row.p?.id, actorId: row.o.created_by });
    return "sent";
  }
  await db.update(liOutbox).set({ status: "failed", error: res.error.slice(0, 1000) }).where(eq(liOutbox.id, id));
  await logAction({ accountId: account.id, action: "reply", ok: false, prospectId: row.p?.id, detail: res.error });
  await maybePause(account, res.health, res.error);
  return "reply failed";
}

async function sendOneCampaignRow(
  account: LiAccount,
  base: Omit<Parameters<typeof canAct>[0], "action">,
  now: Date,
): Promise<string | null> {
  const lease = new Date(now.getTime() + LEASE_MS);
  const claimed = await db.execute(sql`
    UPDATE li_campaign_prospects SET next_action_at = ${lease.toISOString()}::timestamptz, updated_at = now()
    WHERE id = (
      SELECT cp.id FROM li_campaign_prospects cp
      JOIN li_campaigns c ON c.id = cp.campaign_id
      WHERE c.account_id = ${account.id} AND c.status = 'running'
        AND cp.state IN ('queued', 'accepted')
        AND cp.next_action_at IS NOT NULL AND cp.next_action_at <= ${now.toISOString()}::timestamptz
      ORDER BY (cp.state = 'accepted') DESC, cp.next_action_at
      FOR UPDATE OF cp SKIP LOCKED
      LIMIT 1
    )
    RETURNING id`);
  const id = (claimed as unknown as { id: string }[])[0]?.id;
  if (!id) return null;

  const [row] = await db
    .select({ cp: liCampaignProspects, c: liCampaigns, p: liProspects })
    .from(liCampaignProspects)
    .innerJoin(liCampaigns, eq(liCampaigns.id, liCampaignProspects.campaign_id))
    .innerJoin(liProspects, eq(liProspects.id, liCampaignProspects.prospect_id))
    .where(eq(liCampaignProspects.id, id))
    .limit(1);
  if (!row) return null;
  const { cp, c, p } = row;
  const state = cp.state as ProspectState;

  const move = async (event: Parameters<typeof nextState>[1], extra: Partial<typeof liCampaignProspects.$inferInsert> = {}) => {
    const to = nextState(state, event);
    if (!to) throw new Error(`illegal transition ${state} --${event}`);
    await db
      .update(liCampaignProspects)
      .set({ state: to, updated_at: new Date(), ...extra })
      .where(eq(liCampaignProspects.id, cp.id));
  };
  const refuse = async (reason: string) => {
    await move("fail", { last_error: `refused: ${reason}`, next_action_at: null });
    await logAction({ accountId: account.id, campaignId: c.id, prospectId: p.id, action: "refused", ok: false, detail: reason });
    return "refused";
  };

  if (p.do_not_contact) {
    await move("stop", { stopped_reason: "do not contact", next_action_at: null });
    return null;
  }

  // ── R7: the approval gate, recomputed from what is about to be sent.
  const [approval] = await db
    .select()
    .from(liApprovals)
    .where(and(eq(liApprovals.campaign_id, c.id), isNull(liApprovals.voided_at)))
    .limit(1);
  let attachment: Awaited<ReturnType<typeof loadAttachment>> = null;
  if (c.attachment_id) {
    attachment = await loadAttachment(c.attachment_id);
    if (!attachment) return refuse("attachment could not be loaded");
  }
  const values = { first_name: p.first_name, company: p.company, headline: p.headline, city: p.city };
  const fresh = renderTemplate(c.template, values);
  const check = checkApproval({
    approval: approval ?? null,
    current: approvalHashes({ template: c.template, inviteNote: c.invite_note, attachmentSha256: attachment?.sha256 ?? null }),
    frozen: cp.rendered_message,
    fresh: fresh.missing.length ? null : fresh.text,
  });
  if (!check.ok) return refuse(check.reason);

  const provider = messagingProvider(account.provider);
  const accountRef = account.provider_account_id!;

  // ── Resolve the LinkedIn id + connection degree (S6), first touch only for queued rows.
  let providerId = p.provider_id;
  let connection = (p.connection_state as "none" | "pending" | "connected" | null) ?? null;
  if (state === "queued" || !providerId) {
    try {
      const r = await provider.resolveProfile(accountRef, providerId ?? p.profile_id);
      providerId = r.providerId;
      connection = r.connection;
      await db
        .update(liProspects)
        .set({ provider_id: r.providerId, connection_state: r.connection, connection_checked_at: now, updated_at: now })
        .where(eq(liProspects.id, p.id));
      await logAction({ accountId: account.id, prospectId: p.id, action: "resolve", ok: true, detail: r.connection });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logAction({ accountId: account.id, prospectId: p.id, action: "resolve", ok: false, detail: msg });
      return retryOrFail(cp, msg, now);
    }
  }

  // Already invited outside this module: wait for acceptance like any invite.
  if (state === "queued" && connection === "pending") {
    await move("invite_sent", { invite_sent_at: now, next_action_at: null });
    return "invite already pending";
  }

  const action: "invite" | "message" = state === "accepted" || connection === "connected" ? "message" : "invite";
  const pace = canAct({ ...base, action });
  if (!pace.ok) {
    // Release the lease; try again later.
    await db
      .update(liCampaignProspects)
      .set({ next_action_at: new Date(now.getTime() + RETRY_MS) })
      .where(eq(liCampaignProspects.id, cp.id));
    return pace.reason;
  }

  if (action === "invite") {
    const res = await provider.sendInvite(accountRef, providerId!, cp.rendered_note ?? undefined);
    if (!res.ok) {
      await logAction({ accountId: account.id, campaignId: c.id, prospectId: p.id, action: "invite", ok: false, detail: res.error });
      await maybePause(account, res.health, res.error);
      return retryOrFail(cp, res.error, now);
    }
    await move("invite_sent", { invite_sent_at: now, next_action_at: null, attempts: 0, last_error: null });
    await db.update(liProspects).set({ connection_state: "pending" }).where(eq(liProspects.id, p.id));
    await logAction({ accountId: account.id, campaignId: c.id, prospectId: p.id, action: "invite", ok: true });
    return "sent";
  }

  const [existingChat] = await db
    .select()
    .from(liConversations)
    .where(and(eq(liConversations.account_id, account.id), eq(liConversations.prospect_id, p.id)))
    .limit(1);
  const res = await provider.sendMessage(
    accountRef,
    providerId!,
    cp.rendered_message ?? "",
    attachment ?? undefined,
    existingChat?.provider_chat_id ?? null,
  );
  if (!res.ok) {
    await logAction({ accountId: account.id, campaignId: c.id, prospectId: p.id, action: "message", ok: false, detail: res.error });
    await maybePause(account, res.health, res.error);
    return retryOrFail(cp, res.error, now);
  }
  await move("message_sent", { message_sent_at: now, next_action_at: null, attempts: 0, last_error: null });
  const [conv] = await db
    .insert(liConversations)
    .values({ account_id: account.id, provider_chat_id: res.chatId, prospect_id: p.id, campaign_id: c.id, last_message_at: now })
    .onConflictDoUpdate({
      target: [liConversations.account_id, liConversations.provider_chat_id],
      set: { last_message_at: now, campaign_id: c.id },
    })
    .returning();
  if (res.messageId) {
    await db
      .insert(liMessages)
      .values({
        conversation_id: conv.id,
        provider_message_id: res.messageId,
        direction: "out",
        body: cp.rendered_message,
        attachment_name: attachment?.fileName ?? null,
        campaign_prospect_id: cp.id,
        sent_at: now,
      })
      .onConflictDoNothing();
  }
  await logAction({ accountId: account.id, campaignId: c.id, prospectId: p.id, action: "message", ok: true });
  return "sent";
}

async function retryOrFail(cp: typeof liCampaignProspects.$inferSelect, error: string, now: Date): Promise<string> {
  const attempts = cp.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    const to = nextState(cp.state as ProspectState, "fail");
    await db
      .update(liCampaignProspects)
      .set({ state: to ?? cp.state, attempts, last_error: error.slice(0, 1000), next_action_at: null, updated_at: now })
      .where(eq(liCampaignProspects.id, cp.id));
  } else {
    await db
      .update(liCampaignProspects)
      .set({ attempts, last_error: error.slice(0, 1000), next_action_at: new Date(now.getTime() + RETRY_MS), updated_at: now })
      .where(eq(liCampaignProspects.id, cp.id));
  }
  return "send failed";
}

/** Any challenge / restriction → pause, drain, alert (doc §6.4, acceptance test 5). */
async function maybePause(account: LiAccount, health: AccountHealth | undefined, error: string) {
  if (health && health !== "ok") await pauseAccount(account.id, health, error);
}

/**
 * Inbox (R5, R6): conversations captured by the poll ticker, admin replies
 * (queued, sent by the send ticker under the same pacing), agent drafts.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  liCampaignProspects,
  liConversations,
  liMessages,
  liOutbox,
  liProspects,
} from "@/lib/db/schema";

import { draftReply } from "../agent/reply-draft";
import type { Message } from "../providers/messaging/types";
import { nextState, TERMINAL_STATES, type ProspectState } from "../state/prospect-state";
import { stopProspectEverywhere, updateProspect } from "./prospects";

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

export async function listConversations(opts: { accountId?: string | null } = {}) {
  const lastIn = sql<string | null>`(SELECT m.body FROM li_messages m WHERE m.conversation_id = ${liConversations.id} ORDER BY m.sent_at DESC LIMIT 1)`;
  const q = db
    .select({ c: liConversations, p: liProspects, last_body: lastIn })
    .from(liConversations)
    .leftJoin(liProspects, eq(liProspects.id, liConversations.prospect_id));
  const rows = await (opts.accountId ? q.where(eq(liConversations.account_id, opts.accountId)) : q)
    // Replies first (doc screen 5): unread, then the latest inbound, then the rest.
    .orderBy(desc(liConversations.unread), sql`${liConversations.last_inbound_at} DESC NULLS LAST`, desc(liConversations.last_message_at))
    .limit(300);
  return rows.map(({ c, p, last_body }) => ({
    ...c,
    last_body,
    prospect: p
      ? { id: p.id, full_name: p.full_name, headline: p.headline, company: p.company, public_url: p.public_url, do_not_contact: p.do_not_contact }
      : null,
  }));
}

export async function getThread(conversationId: string) {
  const [row] = await db
    .select({ c: liConversations, p: liProspects })
    .from(liConversations)
    .leftJoin(liProspects, eq(liProspects.id, liConversations.prospect_id))
    .where(eq(liConversations.id, conversationId))
    .limit(1);
  if (!row) throw httpError(404, "Conversation not found");
  const messages = await db
    .select()
    .from(liMessages)
    .where(eq(liMessages.conversation_id, conversationId))
    .orderBy(asc(liMessages.sent_at));
  const outbox = await db
    .select()
    .from(liOutbox)
    .where(and(eq(liOutbox.conversation_id, conversationId), inArray(liOutbox.status, ["queued", "failed"])))
    .orderBy(asc(liOutbox.created_at));
  if (row.c.unread) {
    await db.update(liConversations).set({ unread: false }).where(eq(liConversations.id, conversationId));
  }
  return {
    conversation: row.c,
    prospect: row.p
      ? { id: row.p.id, full_name: row.p.full_name, headline: row.p.headline, company: row.p.company, city: row.p.city, public_url: row.p.public_url, do_not_contact: row.p.do_not_contact, lead_id: row.p.lead_id }
      : null,
    messages,
    outbox,
  };
}

/** Admin reply — pressing Send is the approval; the send ticker sends it under pacing. */
export async function queueReply(conversationId: string, body: string, attachmentId: string | null, actorId: string | null) {
  const text = body.trim();
  if (!text) throw httpError(400, "Reply is empty");
  const t = await getThread(conversationId);
  if (t.prospect?.do_not_contact) throw httpError(409, "This prospect is marked do-not-contact");
  const [row] = await db
    .insert(liOutbox)
    .values({ conversation_id: conversationId, body: text.slice(0, 8000), attachment_id: attachmentId, created_by: actorId })
    .returning();
  return row;
}

export async function draftFor(conversationId: string) {
  const t = await getThread(conversationId);
  const result = await draftReply({
    prospect: { full_name: t.prospect?.full_name ?? null, headline: t.prospect?.headline ?? null, company: t.prospect?.company ?? null },
    thread: t.messages.map((m) => ({ fromMe: m.direction === "out", text: m.body, at: m.sent_at })),
  });
  if (!result) throw httpError(503, "No draft — the assistant model is not configured or did not answer");
  if (result.sentiment) {
    await db.update(liConversations).set({ sentiment: result.sentiment }).where(eq(liConversations.id, conversationId));
    if (result.sentiment === "negative" && t.prospect) {
      await stopProspectEverywhere(t.prospect.id, "negative reply");
    }
  }
  return result;
}

export async function stopContacting(conversationId: string, actorId: string | null) {
  const t = await getThread(conversationId);
  if (!t.prospect) throw httpError(409, "This conversation is not linked to a prospect");
  void actorId;
  return updateProspect(t.prospect.id, { do_not_contact: true, do_not_contact_reason: "stopped from inbox" });
}

/**
 * Poll ticker: store a chat's messages (idempotent on provider_message_id —
 * acceptance test 10). A new inbound message marks the prospect replied in
 * its live campaign and stops further automatic sends (acceptance test 4).
 */
export async function syncChat(args: {
  accountId: string;
  chatId: string;
  prospectId: string | null;
  campaignId: string | null;
  messages: Message[];
}): Promise<{ newInbound: number }> {
  const [conv] = await db
    .insert(liConversations)
    .values({
      account_id: args.accountId,
      provider_chat_id: args.chatId,
      prospect_id: args.prospectId,
      campaign_id: args.campaignId,
    })
    .onConflictDoUpdate({
      target: [liConversations.account_id, liConversations.provider_chat_id],
      set: {
        prospect_id: sql`COALESCE(${liConversations.prospect_id}, EXCLUDED.prospect_id)`,
        campaign_id: sql`COALESCE(${liConversations.campaign_id}, EXCLUDED.campaign_id)`,
      },
    })
    .returning();

  let newInbound = 0;
  let lastAt: Date | null = conv.last_message_at;
  let lastIn: Date | null = conv.last_inbound_at;
  for (const m of args.messages) {
    const inserted = await db
      .insert(liMessages)
      .values({
        conversation_id: conv.id,
        provider_message_id: m.messageId,
        direction: m.fromMe ? "out" : "in",
        body: m.text,
        attachment_name: m.attachmentName,
        sent_at: m.sentAt,
        seen_at: m.seenAt,
      })
      .onConflictDoNothing()
      .returning({ id: liMessages.id });
    if (!inserted.length) {
      if (m.fromMe && m.seenAt) {
        await db
          .update(liMessages)
          .set({ seen_at: m.seenAt })
          .where(and(eq(liMessages.provider_message_id, m.messageId), sql`${liMessages.seen_at} IS NULL`));
      }
      continue;
    }
    if (!lastAt || m.sentAt > lastAt) lastAt = m.sentAt;
    if (!m.fromMe) {
      newInbound++;
      if (!lastIn || m.sentAt > lastIn) lastIn = m.sentAt;
    }
  }
  await db
    .update(liConversations)
    .set({ last_message_at: lastAt, last_inbound_at: lastIn, ...(newInbound ? { unread: true } : {}) })
    .where(eq(liConversations.id, conv.id));

  const prospectId = conv.prospect_id ?? args.prospectId;
  if (prospectId) {
    const live = await db
      .select()
      .from(liCampaignProspects)
      .where(eq(liCampaignProspects.prospect_id, prospectId));
    for (const cp of live) {
      if (TERMINAL_STATES.has(cp.state as ProspectState)) continue;
      // Seen state on our sent message (doc §6.5): only when LinkedIn reports it.
      const seen = args.messages.find((m) => m.fromMe && m.seenAt);
      if (newInbound) {
        const to = nextState(cp.state as ProspectState, "replied");
        if (to) {
          await db
            .update(liCampaignProspects)
            .set({ state: to, replied_at: lastIn ?? new Date(), next_action_at: null, updated_at: new Date() })
            .where(eq(liCampaignProspects.id, cp.id));
        }
      } else if (seen && cp.state === "message_sent") {
        await db
          .update(liCampaignProspects)
          .set({ state: nextState("message_sent", "seen")!, seen_at: seen.seenAt, updated_at: new Date() })
          .where(eq(liCampaignProspects.id, cp.id));
      }
    }
  }
  return { newInbound };
}

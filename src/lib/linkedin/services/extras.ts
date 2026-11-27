/**
 * E-398 extras: campaign categories + meetings. These live in their own tables
 * so a DB without E-398 keeps every E-393 screen working. Every reader goes
 * through extrasReady(), which probes to_regclass and caches the answer for
 * 5 minutes (so applying the migration takes effect without a pm2 reload).
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  liCampaignCategories,
  liCampaignProspects,
  liConversations,
  liMeetingHints,
  liMeetings,
} from "@/lib/db/schema";

import { isCategory, UNCATEGORISED } from "../categories";
import { logAction } from "./actionLog";

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

const PROBE_TTL_MS = 5 * 60_000;
let ready: boolean | null = null;
let probedAt = 0;

export async function extrasReady(): Promise<boolean> {
  const now = Date.now();
  if (ready !== null && now - probedAt < PROBE_TTL_MS) return ready;
  try {
    const res = await db.execute<{ present: boolean }>(sql`
      SELECT (to_regclass('public.li_campaign_categories') IS NOT NULL
          AND to_regclass('public.li_meetings') IS NOT NULL
          AND to_regclass('public.li_meeting_hints') IS NOT NULL) AS present`);
    ready = Boolean((res as unknown as { present: boolean }[])[0]?.present);
  } catch {
    ready = false;
  }
  probedAt = now;
  if (!ready) console.warn("[linkedin] E-398 tables absent — categories and meetings are hidden. Apply drizzle/E-398_linkedin_categories_meetings.sql.");
  return ready;
}

const NOT_READY = "Categories and meetings need database migration E-398 — ask the admin to apply it.";

// ── Categories ────────────────────────────────────────────────────────────

export async function setCategory(campaignId: string, category: string, actorId: string | null): Promise<void> {
  if (!isCategory(category)) throw httpError(400, "Pick a category from the list");
  if (!(await extrasReady())) throw httpError(503, NOT_READY);
  await db
    .insert(liCampaignCategories)
    .values({ campaign_id: campaignId, category, updated_by: actorId })
    .onConflictDoUpdate({
      target: liCampaignCategories.campaign_id,
      set: { category, updated_by: actorId, updated_at: new Date() },
    });
}

/** campaign id → category ("Uncategorised" when none / E-398 absent). */
export async function categoriesFor(campaignIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!campaignIds.length || !(await extrasReady())) return map;
  const rows = await db
    .select({ id: liCampaignCategories.campaign_id, category: liCampaignCategories.category })
    .from(liCampaignCategories)
    .where(inArray(liCampaignCategories.campaign_id, campaignIds));
  for (const r of rows) map.set(r.id, r.category);
  return map;
}

export const categoryOf = (map: Map<string, string>, id: string) => map.get(id) ?? UNCATEGORISED;

// ── Meetings ──────────────────────────────────────────────────────────────

/**
 * The campaign row a conversation belongs to: the conversation's own campaign
 * if set, else the prospect's most recent campaign row on that account.
 */
async function campaignRowFor(conversationId: string) {
  const [c] = await db.select().from(liConversations).where(eq(liConversations.id, conversationId)).limit(1);
  if (!c) throw httpError(404, "Conversation not found");
  if (!c.prospect_id) return { conversation: c, row: null };
  const where = c.campaign_id
    ? and(eq(liCampaignProspects.campaign_id, c.campaign_id), eq(liCampaignProspects.prospect_id, c.prospect_id))
    : eq(liCampaignProspects.prospect_id, c.prospect_id);
  const [row] = await db.select().from(liCampaignProspects).where(where).orderBy(desc(liCampaignProspects.created_at)).limit(1);
  return { conversation: c, row: row ?? null };
}

export async function setMeeting(conversationId: string, on: boolean, actorId: string | null) {
  if (!(await extrasReady())) throw httpError(503, NOT_READY);
  const { conversation, row } = await campaignRowFor(conversationId);
  if (!row) throw httpError(409, "This conversation is not part of a campaign, so there is no campaign to count the meeting against.");
  if (on) {
    await db
      .insert(liMeetings)
      .values({ campaign_prospect_id: row.id, conversation_id: conversationId, marked_by: actorId })
      .onConflictDoNothing();
  } else {
    await db.delete(liMeetings).where(eq(liMeetings.campaign_prospect_id, row.id));
  }
  // Marked or cleared by a person: the AI nudge has done its job either way.
  await db
    .update(liMeetingHints)
    .set({ dismissed_at: new Date() })
    .where(and(eq(liMeetingHints.conversation_id, conversationId), isNull(liMeetingHints.dismissed_at)));
  await logAction({
    accountId: conversation.account_id,
    campaignId: row.campaign_id,
    prospectId: row.prospect_id,
    action: "meeting",
    ok: on,
    detail: on ? "meeting scheduled" : "meeting cleared",
    actorId,
  });
  return { meeting: on };
}

/** The AI saw a meeting agreed — a nudge only. Never re-raised once dismissed. */
export async function raiseMeetingHint(conversationId: string): Promise<void> {
  if (!(await extrasReady())) return;
  await db.insert(liMeetingHints).values({ conversation_id: conversationId }).onConflictDoNothing();
}

export async function dismissMeetingHint(conversationId: string): Promise<void> {
  if (!(await extrasReady())) return;
  await db
    .update(liMeetingHints)
    .set({ dismissed_at: new Date() })
    .where(and(eq(liMeetingHints.conversation_id, conversationId), isNull(liMeetingHints.dismissed_at)));
}

/** For the inbox: is a meeting marked on this conversation's campaign row, and is there an open hint? */
export async function meetingStateFor(conversationIds: string[]): Promise<Map<string, { meeting: boolean; hint: boolean }>> {
  const map = new Map<string, { meeting: boolean; hint: boolean }>();
  if (!conversationIds.length || !(await extrasReady())) return map;
  const rows = await db.execute<{ id: string; meeting: boolean; hint: boolean }>(sql`
    SELECT c.id,
      EXISTS (
        SELECT 1 FROM li_campaign_prospects cp JOIN li_meetings m ON m.campaign_prospect_id = cp.id
        WHERE cp.prospect_id = c.prospect_id AND (c.campaign_id IS NULL OR cp.campaign_id = c.campaign_id)
      ) AS meeting,
      EXISTS (SELECT 1 FROM li_meeting_hints h WHERE h.conversation_id = c.id AND h.dismissed_at IS NULL) AS hint
    FROM li_conversations c
    WHERE c.id IN (${sql.join(conversationIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
  for (const r of rows as unknown as { id: string; meeting: boolean; hint: boolean }[]) {
    map.set(r.id, { meeting: Boolean(r.meeting), hint: Boolean(r.hint) && !r.meeting });
  }
  return map;
}

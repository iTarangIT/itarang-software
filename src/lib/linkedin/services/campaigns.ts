/**
 * Campaigns: draft → preview → approve (R7) → running, plus pause / stop.
 *
 * Approval freezes the rendered message and note per prospect and stores the
 * template / note / attachment hashes. ANY edit to template, note or
 * attachment voids the approval and returns the campaign to draft (doc §6.1).
 * The send ticker re-checks the hashes before every send.
 */
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  liApprovals,
  liAttachments,
  liCampaignProspects,
  liCampaigns,
  liConversations,
  liProspects,
} from "@/lib/db/schema";

import { approvalHashes } from "../lib/hash";
import { INVITE_NOTE_MAX, MESSAGE_MAX, renderTemplate } from "../lib/render-template";
import { LIVE_STATES, nextState, TERMINAL_STATES, type ProspectState } from "../state/prospect-state";
import { logAction } from "./actionLog";
import { kpis } from "./kpis";

export { kpis } from "./kpis";

export type LiCampaign = typeof liCampaigns.$inferSelect;

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

export async function getCampaign(id: string): Promise<LiCampaign> {
  const [c] = await db.select().from(liCampaigns).where(eq(liCampaigns.id, id)).limit(1);
  if (!c) throw httpError(404, "Campaign not found");
  return c;
}

export async function listCampaigns() {
  const rows = await db.select().from(liCampaigns).orderBy(desc(liCampaigns.created_at)).limit(200);
  const counts = await stateCounts(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, counts: counts.get(r.id) ?? {} }));
}

async function stateCounts(ids: string[]) {
  const map = new Map<string, Record<string, number>>();
  if (!ids.length) return map;
  const rows = await db
    .select({ id: liCampaignProspects.campaign_id, state: liCampaignProspects.state, n: sql<number>`count(*)::int` })
    .from(liCampaignProspects)
    .where(inArray(liCampaignProspects.campaign_id, ids))
    .groupBy(liCampaignProspects.campaign_id, liCampaignProspects.state);
  for (const r of rows) {
    const m = map.get(r.id) ?? {};
    m[r.state] = Number(r.n);
    map.set(r.id, m);
  }
  return map;
}

function validateTexts(template: string, inviteNote: string | null | undefined) {
  if (template.length > MESSAGE_MAX) throw httpError(400, `Message is longer than ${MESSAGE_MAX} characters`);
  if ((inviteNote ?? "").length > INVITE_NOTE_MAX) {
    throw httpError(400, `Invite note is longer than ${INVITE_NOTE_MAX} characters (LinkedIn's limit)`);
  }
}

export async function createCampaign(args: {
  name: string;
  accountId: string;
  template: string;
  inviteNote?: string | null;
  attachmentId?: string | null;
  prospectIds: string[];
  actorId: string | null;
}) {
  validateTexts(args.template, args.inviteNote);
  const [c] = await db
    .insert(liCampaigns)
    .values({
      name: args.name.trim() || "LinkedIn campaign",
      account_id: args.accountId,
      template: args.template,
      invite_note: args.inviteNote ?? null,
      attachment_id: args.attachmentId ?? null,
      created_by: args.actorId,
    })
    .returning();
  await addProspects(c.id, args.prospectIds);
  return c;
}

export async function addProspects(campaignId: string, prospectIds: string[]) {
  const c = await getCampaign(campaignId);
  if (c.status !== "draft") throw httpError(409, "Prospects can only be added to a draft campaign");
  const ids = [...new Set(prospectIds)];
  if (!ids.length) return;
  await db
    .insert(liCampaignProspects)
    .values(ids.map((prospect_id) => ({ campaign_id: campaignId, prospect_id })))
    .onConflictDoNothing();
}

export async function removeProspects(campaignId: string, prospectIds: string[]) {
  const c = await getCampaign(campaignId);
  if (c.status !== "draft") throw httpError(409, "Prospects can only be removed from a draft campaign");
  if (!prospectIds.length) return;
  await db
    .delete(liCampaignProspects)
    .where(and(eq(liCampaignProspects.campaign_id, campaignId), inArray(liCampaignProspects.prospect_id, prospectIds)));
}

/** Void the live approval and return every not-yet-sent row to `selected`. */
async function voidApproval(campaignId: string, reason: string) {
  await db
    .update(liApprovals)
    .set({ voided_at: new Date(), void_reason: reason })
    .where(and(eq(liApprovals.campaign_id, campaignId), isNull(liApprovals.voided_at)));
  for (const from of ["approved", "queued"] as ProspectState[]) {
    const to = nextState(from, "void");
    if (!to) continue;
    await db
      .update(liCampaignProspects)
      .set({ state: to, next_action_at: null, rendered_message: null, rendered_note: null, updated_at: new Date() })
      .where(and(eq(liCampaignProspects.campaign_id, campaignId), eq(liCampaignProspects.state, from)));
  }
}

export async function updateCampaign(
  id: string,
  patch: { name?: string; template?: string; inviteNote?: string | null; attachmentId?: string | null },
  actorId: string | null,
) {
  const c = await getCampaign(id);
  if (c.status === "stopped" || c.status === "done") throw httpError(409, "A stopped campaign cannot be edited");
  const template = patch.template ?? c.template;
  const inviteNote = patch.inviteNote !== undefined ? patch.inviteNote : c.invite_note;
  const attachmentId = patch.attachmentId !== undefined ? patch.attachmentId : c.attachment_id;
  validateTexts(template, inviteNote);
  const contentChanged =
    template !== c.template || (inviteNote ?? null) !== (c.invite_note ?? null) || (attachmentId ?? null) !== (c.attachment_id ?? null);
  if (contentChanged && c.status !== "draft") {
    await voidApproval(id, "template, note or attachment edited");
    await logAction({ accountId: c.account_id, campaignId: id, action: "approve", ok: false, detail: "approval voided by edit", actorId });
  }
  const [row] = await db
    .update(liCampaigns)
    .set({
      name: patch.name?.trim() || c.name,
      template,
      invite_note: inviteNote ?? null,
      attachment_id: attachmentId ?? null,
      status: contentChanged ? "draft" : c.status,
      updated_at: new Date(),
    })
    .where(eq(liCampaigns.id, id))
    .returning();
  return row;
}

export type PreviewRow = {
  campaign_prospect_id: string;
  prospect_id: string;
  full_name: string | null;
  company: string | null;
  headline: string | null;
  city: string | null;
  public_url: string;
  state: string;
  message: string;
  note: string | null;
  missing: string[];
  blocked: string | null; // why it will not be sent
};

/** The rendered message for every prospect (Compose screen), with flags. */
export async function previewCampaign(id: string): Promise<{ campaign: LiCampaign; rows: PreviewRow[] }> {
  const campaign = await getCampaign(id);
  const rows = await db
    .select({ cp: liCampaignProspects, p: liProspects })
    .from(liCampaignProspects)
    .innerJoin(liProspects, eq(liProspects.id, liCampaignProspects.prospect_id))
    .where(eq(liCampaignProspects.campaign_id, id))
    .orderBy(liProspects.full_name);

  const liveElsewhere = new Set(
    rows.length
      ? (
          await db
            .select({ id: liCampaignProspects.prospect_id })
            .from(liCampaignProspects)
            .where(
              and(
                inArray(liCampaignProspects.prospect_id, rows.map((r) => r.p.id)),
                ne(liCampaignProspects.campaign_id, id),
                inArray(liCampaignProspects.state, [...LIVE_STATES]),
              ),
            )
        ).map((r) => r.id)
      : [],
  );

  return {
    campaign,
    rows: rows.map(({ cp, p }) => {
      const values = { first_name: p.first_name, company: p.company, headline: p.headline, city: p.city };
      const msg = renderTemplate(campaign.template, values);
      const note = campaign.invite_note ? renderTemplate(campaign.invite_note, values) : null;
      const missing = [...new Set([...msg.missing, ...(note?.missing ?? [])])];
      let blocked: string | null = null;
      if (p.do_not_contact) blocked = "Do not contact";
      else if (liveElsewhere.has(p.id)) blocked = "Already in another running campaign";
      else if (missing.length) blocked = `Missing: ${missing.join(", ")}`;
      else if (!msg.text) blocked = "Empty message";
      else if (note && note.text.length > INVITE_NOTE_MAX) blocked = `Invite note over ${INVITE_NOTE_MAX} characters`;
      return {
        campaign_prospect_id: cp.id,
        prospect_id: p.id,
        full_name: p.full_name,
        company: p.company,
        headline: p.headline,
        city: p.city,
        public_url: p.public_url,
        state: cp.state,
        message: msg.text,
        note: note?.text ?? null,
        missing,
        blocked,
      };
    }),
  };
}

/** R7 — create the approval, freeze rendered text, queue the sendable rows. */
export async function approveCampaign(id: string, actorId: string | null) {
  const { campaign, rows } = await previewCampaign(id);
  if (campaign.status !== "draft") throw httpError(409, "Only a draft campaign can be approved");
  if (!campaign.template.trim()) throw httpError(400, "The message is empty");
  const sendable = rows.filter((r) => !r.blocked && r.state === "selected");
  if (!sendable.length) throw httpError(400, "No prospect can be sent this message (see the flags in preview)");

  let attachmentSha: string | null = null;
  if (campaign.attachment_id) {
    const [a] = await db.select().from(liAttachments).where(eq(liAttachments.id, campaign.attachment_id)).limit(1);
    if (!a) throw httpError(400, "The attachment no longer exists");
    attachmentSha = a.sha256;
  }
  const hashes = approvalHashes({ template: campaign.template, inviteNote: campaign.invite_note, attachmentSha256: attachmentSha });

  await db.transaction(async (tx) => {
    await tx
      .update(liApprovals)
      .set({ voided_at: new Date(), void_reason: "superseded" })
      .where(and(eq(liApprovals.campaign_id, id), isNull(liApprovals.voided_at)));
    await tx.insert(liApprovals).values({ campaign_id: id, ...hashes, prospect_count: sendable.length, approved_by: actorId });
    // Flag the rest so the preview shows why they were left out.
    for (const r of rows.filter((x) => x.blocked)) {
      await tx
        .update(liCampaignProspects)
        .set({ missing_fields: r.blocked, updated_at: new Date() })
        .where(eq(liCampaignProspects.id, r.campaign_prospect_id));
    }
    const now = new Date();
    for (const r of sendable) {
      const approved = nextState("selected", "approve")!;
      const queued = nextState(approved, "enqueue")!;
      await tx
        .update(liCampaignProspects)
        .set({
          state: queued,
          rendered_message: r.message,
          rendered_note: r.note,
          missing_fields: null,
          next_action_at: now,
          last_error: null,
          updated_at: now,
        })
        .where(and(eq(liCampaignProspects.id, r.campaign_prospect_id), eq(liCampaignProspects.state, "selected")));
    }
    await tx.update(liCampaigns).set({ status: "running", updated_at: now }).where(eq(liCampaigns.id, id));
  });
  await logAction({
    accountId: campaign.account_id,
    campaignId: id,
    action: "approve",
    ok: true,
    detail: `${sendable.length} prospects queued`,
    actorId,
  });
  return { queued: sendable.length, skipped: rows.length - sendable.length };
}

export async function setCampaignStatus(id: string, action: "pause" | "resume" | "stop", actorId: string | null) {
  const c = await getCampaign(id);
  if (action === "pause") {
    if (c.status !== "running") throw httpError(409, "Only a running campaign can be paused");
    await db.update(liCampaigns).set({ status: "paused", updated_at: new Date() }).where(eq(liCampaigns.id, id));
  } else if (action === "resume") {
    if (c.status !== "paused") throw httpError(409, "Only a paused campaign can be resumed");
    const [live] = await db
      .select({ id: liApprovals.id })
      .from(liApprovals)
      .where(and(eq(liApprovals.campaign_id, id), isNull(liApprovals.voided_at)))
      .limit(1);
    if (!live) throw httpError(409, "The approval was voided; review and approve again");
    await db.update(liCampaigns).set({ status: "running", updated_at: new Date() }).where(eq(liCampaigns.id, id));
  } else {
    await db.update(liCampaigns).set({ status: "stopped", updated_at: new Date() }).where(eq(liCampaigns.id, id));
    const live = await db
      .select({ id: liCampaignProspects.id, state: liCampaignProspects.state })
      .from(liCampaignProspects)
      .where(eq(liCampaignProspects.campaign_id, id));
    for (const r of live) {
      if (TERMINAL_STATES.has(r.state as ProspectState)) continue;
      const to = nextState(r.state as ProspectState, "stop");
      if (!to) continue;
      await db
        .update(liCampaignProspects)
        .set({ state: to, stopped_reason: "campaign stopped", next_action_at: null, updated_at: new Date() })
        .where(eq(liCampaignProspects.id, r.id));
    }
  }
  await logAction({ accountId: c.account_id, campaignId: id, action: action === "resume" ? "resume" : "pause", ok: true, detail: `campaign ${action}`, actorId });
  return getCampaign(id);
}

/** Tracking screen: counts per state + per-prospect rows with timestamps. */
export async function campaignDetail(id: string) {
  const campaign = await getCampaign(id);
  const rows = await db
    .select({ cp: liCampaignProspects, p: liProspects })
    .from(liCampaignProspects)
    .innerJoin(liProspects, eq(liProspects.id, liCampaignProspects.prospect_id))
    .where(eq(liCampaignProspects.campaign_id, id))
    .orderBy(desc(liCampaignProspects.updated_at));
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.cp.state] = (counts[r.cp.state] ?? 0) + 1;
  const [approval] = await db
    .select()
    .from(liApprovals)
    .where(eq(liApprovals.campaign_id, id))
    .orderBy(desc(liApprovals.approved_at))
    .limit(1);
  const [attachment] = campaign.attachment_id
    ? await db.select().from(liAttachments).where(eq(liAttachments.id, campaign.attachment_id)).limit(1)
    : [];
  return {
    campaign,
    approval: approval ?? null,
    attachment: attachment ? { id: attachment.id, file_name: attachment.file_name, size_bytes: attachment.size_bytes } : null,
    counts,
    kpis: kpis(
      rows.map((r) => r.cp),
      Number(
        (
          await db
            .select({ n: sql<number>`count(*)::int` })
            .from(liConversations)
            .where(and(eq(liConversations.campaign_id, id), eq(liConversations.sentiment, "positive")))
        )[0]?.n ?? 0,
      ),
    ),
    rows: rows.map(({ cp, p }) => ({
      ...cp,
      full_name: p.full_name,
      company: p.company,
      headline: p.headline,
      public_url: p.public_url,
      do_not_contact: p.do_not_contact,
    })),
  };
}

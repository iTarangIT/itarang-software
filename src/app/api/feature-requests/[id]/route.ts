/**
 * GET   /api/feature-requests/{id} — the request, its full discussion, files,
 *       and what the caller may do next.
 * PATCH /api/feature-requests/{id} — edit the request's fields. Only the
 *       person it was sent back to, while it is `changes_requested`. The old
 *       values are kept in the event log.
 */
import { asc, eq } from "drizzle-orm";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import {
  featureRequestAttachments,
  featureRequestCommentEdits,
  featureRequestComments,
  featureRequestEvents,
  featureRequests,
} from "@/lib/db/schema";
import {
  actorOf,
  claimAttachments,
  HttpError,
  loadMembers,
  requireSeat,
  stateOf,
  userNames,
} from "@/lib/feature-requests/server";
import {
  availableActions,
  canEditRequest,
  devNextStatuses,
  PRIORITIES,
} from "@/lib/feature-requests/workflow";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function idFrom(ctx: Ctx): Promise<string> {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) throw new HttpError("Feature request not found.", 404);
  return id;
}

export const GET = withErrorHandler(async (_req: Request, ctx: Ctx) => {
  const user = await requireSeat();
  const id = await idFrom(ctx);

  const [fr] = await db.select().from(featureRequests).where(eq(featureRequests.id, id)).limit(1);
  if (!fr) throw new HttpError("Feature request not found.", 404);

  const [comments, edits, attachments, events, members] = await Promise.all([
    db
      .select()
      .from(featureRequestComments)
      .where(eq(featureRequestComments.feature_request_id, id))
      .orderBy(asc(featureRequestComments.created_at)),
    db
      .select({
        comment_id: featureRequestCommentEdits.comment_id,
        previous_body: featureRequestCommentEdits.previous_body,
        edited_by: featureRequestCommentEdits.edited_by,
        edited_at: featureRequestCommentEdits.edited_at,
      })
      .from(featureRequestCommentEdits)
      .innerJoin(featureRequestComments, eq(featureRequestComments.id, featureRequestCommentEdits.comment_id))
      .where(eq(featureRequestComments.feature_request_id, id))
      .orderBy(asc(featureRequestCommentEdits.edited_at)),
    db
      .select({
        id: featureRequestAttachments.id,
        comment_id: featureRequestAttachments.comment_id,
        file_name: featureRequestAttachments.file_name,
        mime_type: featureRequestAttachments.mime_type,
        size_bytes: featureRequestAttachments.size_bytes,
        uploaded_by: featureRequestAttachments.uploaded_by,
        created_at: featureRequestAttachments.created_at,
      })
      .from(featureRequestAttachments)
      .where(eq(featureRequestAttachments.feature_request_id, id))
      .orderBy(asc(featureRequestAttachments.created_at)),
    db
      .select()
      .from(featureRequestEvents)
      .where(eq(featureRequestEvents.feature_request_id, id))
      .orderBy(asc(featureRequestEvents.created_at)),
    loadMembers(),
  ]);

  const names = await userNames([
    fr.created_by,
    fr.current_owner_id,
    fr.assigned_developer_id,
    ...comments.map((c) => c.author_id),
    ...attachments.map((a) => a.uploaded_by),
    ...events.flatMap((e) => [e.actor_id, e.target_user_id]),
  ]);
  const nameOf = (uid: string | null) => (uid ? (names.get(uid)?.name ?? "Unknown user") : null);

  const state = stateOf(fr);
  const actor = actorOf(user);
  const actions = availableActions(state, actor);

  return successResponse({
    me: { id: user.id, seat: user.seat, name: user.name },
    request: {
      ...fr,
      created_by_name: nameOf(fr.created_by),
      current_owner_name: nameOf(fr.current_owner_id),
      assigned_developer_name: nameOf(fr.assigned_developer_id),
    },
    comments: comments.map((c) => ({
      ...c,
      author_name: nameOf(c.author_id),
      edits: edits
        .filter((e) => e.comment_id === c.id)
        .map((e) => ({ previous_body: e.previous_body, edited_at: e.edited_at, edited_by_name: nameOf(e.edited_by) })),
    })),
    attachments: attachments.map((a) => ({ ...a, uploaded_by_name: nameOf(a.uploaded_by) })),
    events: events.map((e) => ({
      ...e,
      actor_name: nameOf(e.actor_id),
      target_name: nameOf(e.target_user_id),
    })),
    members: members.map((m) => ({ id: m.id, name: m.name, seat: m.seat })),
    actions,
    canEdit: canEditRequest(state, actor),
    nextStatuses: actions.includes("set_status") ? devNextStatuses(state.status) : [],
  });
});

const patchSchema = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  description: z.string().trim().min(10).max(20000).optional(),
  priority: z.enum(PRIORITIES).optional(),
  module: z.string().trim().min(1).max(120).optional(),
  attachmentIds: z.array(z.string().uuid()).max(20).default([]),
});

const EDITABLE = ["title", "description", "priority", "module"] as const;

export const PATCH = withErrorHandler(async (req: Request, ctx: Ctx) => {
  const user = await requireSeat();
  const id = await idFrom(ctx);
  const input = patchSchema.parse(await req.json());

  await db.transaction(async (tx) => {
    const [fr] = await tx.select().from(featureRequests).where(eq(featureRequests.id, id)).for("update");
    if (!fr) throw new HttpError("Feature request not found.", 404);
    if (!canEditRequest(stateOf(fr), actorOf(user))) {
      throw new HttpError("You can only edit a request that has been sent back to you.", 403);
    }

    const changed = EDITABLE.filter((k) => input[k] !== undefined && input[k] !== fr[k]);
    if (changed.length === 0 && input.attachmentIds.length === 0) return;

    const previous = Object.fromEntries(changed.map((k) => [k, fr[k]]));
    if (changed.length > 0) {
      await tx
        .update(featureRequests)
        .set({ ...Object.fromEntries(changed.map((k) => [k, input[k]])), updated_at: new Date() })
        .where(eq(featureRequests.id, id));
    }

    const parts: string[] = [...changed];
    if (input.attachmentIds.length > 0) parts.push(`${input.attachmentIds.length} file(s)`);
    const [comment] = await tx
      .insert(featureRequestComments)
      .values({
        feature_request_id: id,
        author_id: user.id,
        author_role: user.seat,
        kind: "edited",
        body: `Updated ${parts.join(", ")}`,
      })
      .returning({ id: featureRequestComments.id });
    await claimAttachments(tx, input.attachmentIds, user.id, id, comment.id);
    await tx.insert(featureRequestEvents).values({
      feature_request_id: id,
      actor_id: user.id,
      action: "edit",
      from_status: fr.status,
      to_status: fr.status,
      note: JSON.stringify({ previous }),
    });
  });

  return successResponse({ ok: true });
});

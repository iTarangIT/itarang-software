/**
 * POST /api/feature-requests/{id}/comments — add a comment or a reply.
 *
 * Body: { body, parentId?, attachmentIds? }. Any active member may comment at
 * any status, including after Closed. Replies are one level deep, like GitHub:
 * a reply to a reply hangs off the same top-level comment.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { featureRequestComments, featureRequests } from "@/lib/db/schema";
import { claimAttachments, HttpError, notifyMembers, requireSeat } from "@/lib/feature-requests/server";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  body: z.string().max(20000).default(""),
  parentId: z.string().uuid().optional(),
  attachmentIds: z.array(z.string().uuid()).max(20).default([]),
});

export const POST = withErrorHandler(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireSeat();
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) throw new HttpError("Feature request not found.", 404);
  const input = bodySchema.parse(await req.json());
  const text = input.body.trim();
  if (!text && input.attachmentIds.length === 0) throw new HttpError("Write something or attach a file.", 400);

  const { fr, parentAuthor } = await db.transaction(async (tx) => {
    const [fr] = await tx.select().from(featureRequests).where(eq(featureRequests.id, id)).limit(1);
    if (!fr) throw new HttpError("Feature request not found.", 404);

    let parentId: string | null = null;
    let parentAuthor: string | null = null;
    if (input.parentId) {
      const [parent] = await tx
        .select()
        .from(featureRequestComments)
        .where(eq(featureRequestComments.id, input.parentId))
        .limit(1);
      if (!parent || parent.feature_request_id !== id) throw new HttpError("That comment no longer exists.", 400);
      parentId = parent.parent_id ?? parent.id;
      parentAuthor = parent.author_id;
    }

    const [comment] = await tx
      .insert(featureRequestComments)
      .values({
        feature_request_id: id,
        parent_id: parentId,
        author_id: user.id,
        author_role: user.seat,
        kind: "comment",
        body: text,
      })
      .returning({ id: featureRequestComments.id });
    await claimAttachments(tx, input.attachmentIds, user.id, id, comment.id);
    await tx.update(featureRequests).set({ updated_at: new Date() }).where(eq(featureRequests.id, id));
    return { fr, parentAuthor };
  });

  const recipients = new Set(
    [fr.current_owner_id, fr.created_by, fr.assigned_developer_id, parentAuthor].filter((x): x is string => !!x),
  );
  recipients.delete(user.id);
  await notifyMembers([...recipients], fr, input.parentId ? "new reply" : "new comment", "comment");

  return successResponse({ ok: true }, 201);
});

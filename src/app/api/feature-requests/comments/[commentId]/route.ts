/**
 * PATCH /api/feature-requests/comments/{commentId} — edit your own comment.
 *
 * The previous text is kept in feature_request_comment_edits, so an edit never
 * loses history. System entries (approvals, rejections, …) can't be edited, and
 * nothing can be deleted.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { featureRequestCommentEdits, featureRequestComments } from "@/lib/db/schema";
import { HttpError, requireSeat } from "@/lib/feature-requests/server";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ body: z.string().trim().min(1, "A comment can't be empty").max(20000) });

export const PATCH = withErrorHandler(async (req: Request, ctx: { params: Promise<{ commentId: string }> }) => {
  const user = await requireSeat();
  const { commentId } = await ctx.params;
  if (!z.string().uuid().safeParse(commentId).success) throw new HttpError("Comment not found.", 404);
  const { body } = bodySchema.parse(await req.json());

  await db.transaction(async (tx) => {
    const [c] = await tx
      .select()
      .from(featureRequestComments)
      .where(eq(featureRequestComments.id, commentId))
      .for("update");
    if (!c) throw new HttpError("Comment not found.", 404);
    if (c.author_id !== user.id) throw new HttpError("You can only edit your own comments.", 403);
    if (c.kind !== "comment") throw new HttpError("Approval and status entries can't be edited.", 403);
    if (c.body === body) return;

    await tx.insert(featureRequestCommentEdits).values({
      comment_id: c.id,
      previous_body: c.body,
      edited_by: user.id,
    });
    await tx
      .update(featureRequestComments)
      .set({ body, edited_at: new Date() })
      .where(eq(featureRequestComments.id, c.id));
  });

  return successResponse({ ok: true });
});

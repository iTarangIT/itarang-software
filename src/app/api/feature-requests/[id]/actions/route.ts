/**
 * POST /api/feature-requests/{id}/actions — the single transition endpoint.
 *
 * Body: { action, reason?, note?, target?, developerId?, toStatus?, attachmentIds? }
 * The state machine (src/lib/feature-requests/workflow.ts) decides; this route
 * locks the row, applies the patch, and writes the event + the system comment
 * that makes the step visible in the discussion.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { featureRequestComments, featureRequestEvents, featureRequests } from "@/lib/db/schema";
import {
  actorOf,
  claimAttachments,
  directoryOf,
  headlineFor,
  HttpError,
  loadMembers,
  notifyMembers,
  requireSeat,
  stateOf,
} from "@/lib/feature-requests/server";
import { applyAction, STATUSES, type ActionInput } from "@/lib/feature-requests/workflow";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  action: z.enum(["approve", "request_changes", "reject", "resubmit", "reopen", "assign", "set_status"]),
  reason: z.string().max(10000).optional(),
  note: z.string().max(10000).optional(),
  target: z.enum(["requester", "product_reviewer"]).optional(),
  developerId: z.string().uuid().optional(),
  toStatus: z.enum(STATUSES).optional(),
  attachmentIds: z.array(z.string().uuid()).max(20).default([]),
});

function toInput(b: z.infer<typeof bodySchema>): ActionInput {
  switch (b.action) {
    case "approve":
    case "resubmit":
      return { action: b.action, note: b.note };
    case "request_changes":
      return { action: b.action, reason: b.reason ?? "", target: b.target };
    case "reject":
    case "reopen":
      return { action: b.action, reason: b.reason ?? "" };
    case "assign":
      if (!b.developerId) throw new HttpError("Pick a developer.", 400);
      return { action: b.action, developerId: b.developerId, note: b.note };
    case "set_status":
      if (!b.toStatus) throw new HttpError("Pick the new status.", 400);
      return { action: b.action, toStatus: b.toStatus, note: b.note };
  }
}

export const POST = withErrorHandler(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireSeat();
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) throw new HttpError("Feature request not found.", 404);
  const body = bodySchema.parse(await req.json());
  const input = toInput(body);
  const dir = directoryOf(await loadMembers());

  const outcome = await db.transaction(async (tx) => {
    // Lock, then decide on the row as it is NOW — two reviewers clicking at
    // once can't both act on the same status.
    const [fr] = await tx.select().from(featureRequests).where(eq(featureRequests.id, id)).for("update");
    if (!fr) throw new HttpError("Feature request not found.", 404);

    const result = applyAction(stateOf(fr), actorOf(user), input, dir);
    const { patch } = result;

    await tx
      .update(featureRequests)
      .set({
        status: patch.status,
        current_owner_id: patch.currentOwnerId,
        resubmit_to_status: patch.resubmitToStatus,
        assigned_developer_id: patch.assignedDeveloperId,
        revision: patch.revision,
        updated_at: new Date(),
        closed_at: patch.closedAt === "now" ? new Date() : null,
      })
      .where(eq(featureRequests.id, id));

    await tx.insert(featureRequestEvents).values({
      feature_request_id: id,
      actor_id: user.id,
      action: result.event.action,
      from_status: result.event.fromStatus,
      to_status: result.event.toStatus,
      target_user_id: result.event.targetUserId,
      note: result.event.note,
    });
    const [comment] = await tx
      .insert(featureRequestComments)
      .values({
        feature_request_id: id,
        author_id: user.id,
        author_role: user.seat,
        kind: result.comment.kind,
        body: result.comment.body,
      })
      .returning({ id: featureRequestComments.id });
    await claimAttachments(tx, body.attachmentIds, user.id, id, comment.id);

    return { fr, result };
  });

  await notifyMembers(
    outcome.result.notifyUserIds,
    outcome.fr,
    headlineFor(outcome.result.event.action, outcome.result.patch.status),
    outcome.result.event.action,
  );

  return successResponse({ status: outcome.result.patch.status });
});

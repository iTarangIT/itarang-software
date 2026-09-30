/**
 * GET  /api/feature-requests?view=awaiting_me|active|done|all — the list.
 * POST /api/feature-requests — the CEO (requester seat) raises a request.
 */
import { and, desc, eq, inArray, notInArray, type SQL } from "drizzle-orm";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { featureRequestComments, featureRequestEvents, featureRequests } from "@/lib/db/schema";
import {
  claimAttachments,
  directoryOf,
  HttpError,
  loadMembers,
  notifyMembers,
  requireSeat,
  userNames,
} from "@/lib/feature-requests/server";
import { PRIORITIES } from "@/lib/feature-requests/workflow";

export const dynamic = "force-dynamic";

const DONE = ["closed", "rejected"];

export const GET = withErrorHandler(async (req: Request) => {
  const user = await requireSeat();
  const view = new URL(req.url).searchParams.get("view") ?? "awaiting_me";

  let where: SQL | undefined;
  if (view === "awaiting_me") {
    where = and(eq(featureRequests.current_owner_id, user.id), notInArray(featureRequests.status, DONE));
  } else if (view === "active") {
    where = notInArray(featureRequests.status, DONE);
  } else if (view === "done") {
    where = inArray(featureRequests.status, DONE);
  }

  const rows = await db
    .select({
      id: featureRequests.id,
      code: featureRequests.code,
      title: featureRequests.title,
      priority: featureRequests.priority,
      module: featureRequests.module,
      status: featureRequests.status,
      current_owner_id: featureRequests.current_owner_id,
      assigned_developer_id: featureRequests.assigned_developer_id,
      created_by: featureRequests.created_by,
      revision: featureRequests.revision,
      created_at: featureRequests.created_at,
      updated_at: featureRequests.updated_at,
    })
    .from(featureRequests)
    .where(where)
    .orderBy(desc(featureRequests.updated_at))
    .limit(500);

  const names = await userNames(rows.flatMap((r) => [r.current_owner_id, r.assigned_developer_id, r.created_by]));
  const nameOf = (id: string | null) => (id ? (names.get(id)?.name ?? null) : null);

  return successResponse({
    seat: user.seat,
    items: rows.map((r) => ({
      ...r,
      current_owner_name: nameOf(r.current_owner_id),
      assigned_developer_name: nameOf(r.assigned_developer_id),
      created_by_name: nameOf(r.created_by),
    })),
  });
});

const createSchema = z.object({
  title: z.string().trim().min(3, "Give the request a title").max(200),
  description: z.string().trim().min(10, "Describe the feature in a little more detail").max(20000),
  priority: z.enum(PRIORITIES),
  module: z.string().trim().min(1, "Pick a module").max(120),
  attachmentIds: z.array(z.string().uuid()).max(20).default([]),
});

export const POST = withErrorHandler(async (req: Request) => {
  const user = await requireSeat(["requester"]);
  const input = createSchema.parse(await req.json());

  const dir = directoryOf(await loadMembers());
  if (!dir.productReviewerId) {
    throw new HttpError("No active Product Head is set up for feature requests.", 409);
  }

  const created = await db.transaction(async (tx) => {
    const [fr] = await tx
      .insert(featureRequests)
      .values({
        title: input.title,
        description: input.description,
        priority: input.priority,
        module: input.module,
        status: "pending_product_review",
        current_owner_id: dir.productReviewerId,
        created_by: user.id,
      })
      .returning();

    await claimAttachments(tx, input.attachmentIds, user.id, fr.id, null);
    await tx.insert(featureRequestEvents).values({
      feature_request_id: fr.id,
      actor_id: user.id,
      action: "create",
      to_status: "pending_product_review",
      target_user_id: dir.productReviewerId,
    });
    await tx.insert(featureRequestComments).values({
      feature_request_id: fr.id,
      author_id: user.id,
      author_role: user.seat,
      kind: "created",
      body: "",
    });
    return fr;
  });

  await notifyMembers([dir.productReviewerId], created, "new request for product review", "created");
  return successResponse({ id: created.id, code: created.code }, 201);
});

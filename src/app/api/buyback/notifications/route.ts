/**
 * GET   /api/buyback/notifications        — the caller's own buyback feed
 * PATCH /api/buyback/notifications        — mark read
 *
 * The buyback bell (items 12/13). Scoped to `type LIKE 'buyback.%'` by an
 * explicit product decision: this is the buyback module's bell, not the
 * application's.
 *
 * THE RULE THAT MAKES THAT DECISION SAFE, and the reason PATCH exists here
 * rather than reusing anything: THE READ FILTER AND THE WRITE FILTER ARE THE
 * SAME FILTER. A feed narrowed to buyback.* paired with an unscoped
 * mark-all-read would mark 537 unrelated notifications read — including the
 * `escalation_raised` rows that go to admin/sales_head/ceo — destroying an
 * urgent escalation that this bell never displayed. Reading a subset and
 * writing the superset is the bug; they are written together here so they
 * cannot drift apart.
 *
 * WHY user_id AND NOT dealer_id. Buyback notifications arrive via notifyRoles(),
 * which fans out one row PER USER and sets user_id; dealer_id stays NULL on all
 * 460 of them. The pre-existing /api/dealer/notifications filters dealer_id, so
 * it cannot return a buyback notification at all — not "does not yet",
 * structurally cannot. That is a large part of why 997 notifications sit unread:
 * nothing could read them.
 *
 * `read IS NOT TRUE`, never `read = false`. The column is nullable (default
 * false), and `= false` silently skips NULLs — an unread notification that never
 * appears and never counts.
 *
 * WHO ACTUALLY GETS FED TODAY: only iTarang staff. dispatch.ts's PORTAL channel
 * hardwires notifyRoles(BUYBACK_ADMIN_ROLES) and ignores the event's
 * recipient_party, so a DEALER- or VENDOR-addressed portal event still lands in
 * the admins' bell. This route is correct for all three roles the day that is
 * fixed; until then a dealer's feed is honestly empty rather than wrong.
 */

import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireAuth } from "@/lib/auth-utils";
import { db } from "@/lib/db";
import { notifications } from "@/lib/db/schema";

export const runtime = "nodejs";

/** The one filter. Both verbs use it — that is the point. */
const BUYBACK_ONLY = like(notifications.type, "buyback.%");

/**
 * Nullable column: `= false` would skip NULL, which is unread. `IS NOT TRUE`
 * matches both false and NULL, which is exactly what "unread" means here.
 *
 * A raw sql fragment, not a drizzle helper: `isNot` does not exist in drizzle-orm
 * (it type-checked but is undefined at runtime — the build caught what tsc did
 * not), and `ne(read, true)` is `read <> true`, which is UNKNOWN for NULL and so
 * silently drops every NULL-read notification from the count.
 */
const UNREAD = sql`${notifications.read} IS NOT TRUE`;

const FEED_LIMIT = 30;

export const GET = withErrorHandler(async (req: Request) => {
  const user = await requireAuth();
  const unreadOnly = new URL(req.url).searchParams.get("unread") === "true";

  // Scoped in the WHERE. A notification addressed to someone else is not
  // fetched-then-filtered; it is never selected.
  const mine = and(eq(notifications.user_id, user.id), BUYBACK_ONLY);

  const rows = await db
    .select({
      id: notifications.id,
      type: notifications.type,
      title: notifications.title,
      message: notifications.message,
      data: notifications.data,
      read: notifications.read,
      created_at: notifications.created_at,
    })
    .from(notifications)
    .where(unreadOnly ? and(mine, UNREAD) : mine)
    .orderBy(desc(notifications.created_at))
    .limit(FEED_LIMIT);

  // Counted in the DB, not from `rows`: the feed is capped at FEED_LIMIT, so
  // counting the page would silently cap the badge at 30 too and quietly
  // understate a backlog — which on db-1 today is 460 rows.
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(mine, UNREAD));

  return successResponse({ notifications: rows, unread_count: Number(count) });
});

const patchSchema = z.object({
  /** Specific rows, or omit to mark the caller's whole buyback feed read. */
  ids: z.array(z.string()).min(1).max(100).optional(),
});

export const PATCH = withErrorHandler(async (req: Request) => {
  const user = await requireAuth();
  const body = patchSchema.parse(await req.json().catch(() => ({})));

  // BUYBACK_ONLY is not optional here, and neither is the user scope. Drop
  // either and this marks somebody else's mail read, or somebody's escalation.
  const scope = and(eq(notifications.user_id, user.id), BUYBACK_ONLY);

  const updated = await db
    .update(notifications)
    .set({ read: true, read_at: new Date() })
    .where(body.ids ? and(scope, inArray(notifications.id, body.ids)) : and(scope, UNREAD))
    .returning({ id: notifications.id });

  return successResponse({ marked_read: updated.length });
});

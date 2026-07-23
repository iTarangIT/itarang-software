/**
 * GET    /api/buyback/notifications   — the caller's own buyback feed (filtered, paged)
 * PATCH  /api/buyback/notifications   — mark read / archive / unarchive
 * DELETE /api/buyback/notifications   — soft-delete
 *
 * The buyback notification centre (items 12/13). Scoped to `type LIKE 'buyback.%'`
 * by an explicit product decision: this is the buyback module's bell, not the
 * whole application's.
 *
 * THE RULE THAT MAKES THAT DECISION SAFE: THE READ FILTER AND THE WRITE FILTER
 * ARE THE SAME FILTER. A feed narrowed to buyback.* paired with an unscoped
 * mark-all-read would mark the ~537 unrelated notifications read — including the
 * `escalation_raised` rows that go to admin/sales_head/ceo — destroying an
 * urgent escalation this bell never displayed. Reading a subset and writing the
 * superset is the bug; every verb here carries the SAME scope so they cannot
 * drift apart. An optional `category` narrows a bulk mark-read further, never
 * wider.
 *
 * WHY user_id AND NOT dealer_id. Buyback notifications are written per-user with
 * user_id set and dealer_id NULL (see dispatch.ts writeBell). All three roles —
 * dealer, admin, vendor — are fed this way now that writeBell honours the
 * event's recipient_party, so this one route serves every buyback role; who the
 * caller is only changes the per-row deep link (linkFor).
 *
 * `read IS NOT TRUE`, never `read = false`: the column is nullable (default
 * false) and `= false` silently skips NULLs — an unread row that never appears
 * and never counts.
 *
 * E-199 — Archive and Delete are soft (archived_at / deleted_at). A deleted row
 * is hidden, not gone (audit + escalation-safety); the feed always excludes
 * deleted rows, and the default `active` view also excludes archived ones.
 */

import { and, desc, eq, inArray, isNotNull, isNull, like, lt, not, or, sql } from "drizzle-orm";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireAuth } from "@/lib/auth-utils";
import { portalRoleOf } from "@/lib/buyback/auth";
import {
  CATEGORIES,
  categorize,
  linkFor,
  priorityOf,
  typeFilterForCategory,
  type NotificationCategory,
} from "@/lib/buyback/notification-meta";
import { db } from "@/lib/db";
import { notifications } from "@/lib/db/schema";

export const runtime = "nodejs";

/** The one filter. Every verb uses it — that is the point. */
const BUYBACK_ONLY = like(notifications.type, "buyback.%");

/**
 * Nullable column: `= false` would skip NULL, which is unread. `IS NOT TRUE`
 * matches both false and NULL, which is exactly what "unread" means here. A raw
 * fragment because drizzle's `isNot` does not exist at runtime and `ne(read,
 * true)` drops NULLs.
 */
const UNREAD = sql`${notifications.read} IS NOT TRUE`;
const READ = sql`${notifications.read} IS TRUE`;

const FEED_LIMIT = 30;

/** A user-visible 400 (withErrorHandler honours `.status`). */
function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

/** Resolve the caller's buyback portal role for per-row deep links. */
async function callerRole(): Promise<{ userId: string; role: "dealer" | "admin" | "vendor" }> {
  const user = await requireAuth();
  const vendorEntityId = (user as { vendor_entity_id?: string | null }).vendor_entity_id ?? null;
  // Fall back to "dealer" for link shaping only — the WHERE scope is always
  // user_id, so a mis-shaped link is the worst case, never a data leak.
  const role = portalRoleOf(user.role, !!user.dealer_id, !!vendorEntityId) ?? "dealer";
  return { userId: user.id, role };
}

/** Adds a category type-filter clause, if the param names a real category. */
function categoryClause(categoryParam: string | null) {
  if (!categoryParam || !(CATEGORIES as string[]).includes(categoryParam)) return null;
  const f = typeFilterForCategory(categoryParam as NotificationCategory);
  if (f.types.length === 0) return null;
  return f.negate ? not(inArray(notifications.type, f.types)) : inArray(notifications.type, f.types);
}

export const GET = withErrorHandler(async (req: Request) => {
  const { userId, role } = await callerRole();
  const url = new URL(req.url);

  const status = url.searchParams.get("status"); // unread | read | all
  const unreadLegacy = url.searchParams.get("unread") === "true"; // back-compat with the old bell
  const view = url.searchParams.get("view") === "archived" ? "archived" : "active";
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || FEED_LIMIT, 1), 100);
  const cursor = url.searchParams.get("cursor");

  // Scoped in the WHERE — a row addressed to someone else is never selected.
  const clauses = [eq(notifications.user_id, userId), BUYBACK_ONLY, isNull(notifications.deleted_at)];
  clauses.push(view === "archived" ? isNotNull(notifications.archived_at) : isNull(notifications.archived_at));

  if (status === "unread" || unreadLegacy) clauses.push(UNREAD);
  else if (status === "read") clauses.push(READ);

  const catClause = categoryClause(url.searchParams.get("category"));
  if (catClause) clauses.push(catClause);

  // Keyset pagination on (created_at, id) — stable under same-timestamp ties,
  // which offset pagination is not once rows are being marked/archived between
  // pages.
  if (cursor) {
    const [iso, id] = cursor.split("__");
    const t = new Date(iso);
    if (!Number.isNaN(t.getTime())) {
      clauses.push(
        or(
          lt(notifications.created_at, t),
          and(eq(notifications.created_at, t), lt(notifications.id, id ?? "")),
        )!,
      );
    }
  }

  const rows = await db
    .select({
      id: notifications.id,
      type: notifications.type,
      title: notifications.title,
      message: notifications.message,
      data: notifications.data,
      read: notifications.read,
      archived_at: notifications.archived_at,
      created_at: notifications.created_at,
    })
    .from(notifications)
    .where(and(...clauses))
    .orderBy(desc(notifications.created_at), desc(notifications.id))
    .limit(limit);

  // The badge number: unread AND active (not archived, not deleted). Counted in
  // the DB, not from `rows` — the page is capped, so counting it would silently
  // cap the badge at `limit` too and understate the backlog.
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.user_id, userId),
        BUYBACK_ONLY,
        isNull(notifications.deleted_at),
        isNull(notifications.archived_at),
        UNREAD,
      ),
    );

  const enriched = rows.map((r) => {
    const category = categorize(r.type);
    return {
      ...r,
      category,
      priority: priorityOf(r.type),
      href: linkFor(role, category, (r.data ?? null) as { request_id?: string | null } | null),
    };
  });

  const last = rows[rows.length - 1];
  const next_cursor =
    rows.length === limit && last?.created_at
      ? `${last.created_at.toISOString()}__${last.id}`
      : null;

  return successResponse({ notifications: enriched, unread_count: Number(count), next_cursor });
});

const patchSchema = z.object({
  /** Specific rows, or omit (action:"read" only) to mark the whole buyback feed. */
  ids: z.array(z.string()).min(1).max(200).optional(),
  action: z.enum(["read", "archive", "unarchive"]).optional(),
  /** Narrows a bulk mark-read to one category — never widens the scope. */
  category: z.string().optional(),
});

export const PATCH = withErrorHandler(async (req: Request) => {
  const user = await requireAuth();
  const body = patchSchema.parse(await req.json().catch(() => ({})));
  const action = body.action ?? "read";

  // Neither the user scope nor BUYBACK_ONLY is ever optional here. Drop either
  // and this marks somebody else's mail — or somebody's escalation — read.
  const scope = and(eq(notifications.user_id, user.id), BUYBACK_ONLY);

  if (action === "archive" || action === "unarchive") {
    if (!body.ids?.length) throw badRequest(`\"${action}\" needs an explicit ids list.`);
    const updated = await db
      .update(notifications)
      .set({ archived_at: action === "archive" ? new Date() : null })
      .where(and(scope, inArray(notifications.id, body.ids)))
      .returning({ id: notifications.id });
    return successResponse({ updated: updated.length });
  }

  // read — bulk when no ids; an optional category narrows the bulk.
  const where = body.ids?.length
    ? and(scope, inArray(notifications.id, body.ids))
    : and(scope, UNREAD, categoryClause(body.category ?? null) ?? undefined);

  const updated = await db
    .update(notifications)
    .set({ read: true, read_at: new Date() })
    .where(where)
    .returning({ id: notifications.id });

  return successResponse({ marked_read: updated.length });
});

const deleteSchema = z.object({ ids: z.array(z.string()).min(1).max(200) });

export const DELETE = withErrorHandler(async (req: Request) => {
  const user = await requireAuth();
  const body = deleteSchema.parse(await req.json().catch(() => ({})));

  // Soft — the row is hidden, not gone. Same scope as every other verb.
  const updated = await db
    .update(notifications)
    .set({ deleted_at: new Date() })
    .where(and(eq(notifications.user_id, user.id), BUYBACK_ONLY, inArray(notifications.id, body.ids)))
    .returning({ id: notifications.id });

  return successResponse({ deleted: updated.length });
});

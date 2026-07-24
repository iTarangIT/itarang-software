/**
 * GET    /api/notifications   — the caller's own CRM-wide feed (filtered, paged)
 * PATCH  /api/notifications   — mark read / archive / unarchive
 * DELETE /api/notifications   — soft-delete
 *
 * THE bell feed for every portal: admin, dealer, NBFC and vendor all read this
 * one route. Ported from `/api/buyback/notifications`, which had solved the same
 * problem correctly for one module; the differences are that this one is not
 * scoped to `buyback.%`, and that its recipient scope also matches the legacy
 * dealer rows (see below). The buyback route stays as-is — its narrower feed
 * still powers the buyback notification centre.
 *
 * THE SCOPE IS ONE FUNCTION, USED BY ALL THREE VERBS. A feed that reads one set
 * of rows paired with a mark-all-read that writes a wider set is the bug that
 * silently marks somebody else's escalation read. `recipientScope()` below is
 * the single definition; GET, PATCH and DELETE all call it, so read and write
 * cannot drift apart. An optional `category` narrows a bulk mark-read further,
 * never wider.
 *
 * WHY THE SCOPE HAS TWO HALVES:
 *
 *   user_id = :me                                    -- everything modern
 *   OR (user_id IS NULL AND dealer_id = :myDealerId) -- pre-hub dealer rows
 *
 * Every row `src/lib/notifications/emit.ts` writes sets user_id. Rows written
 * before it — all ~11 dealer notification helpers — set only dealer_id, which is
 * exactly why the dealer bell was empty. The second clause surfaces that history
 * instead of stranding it. The `user_id IS NULL` guard is load-bearing: without
 * it a NEW per-user dealer row would ALSO match every colleague at that dealer
 * via dealer_id, so one person's read would appear to mark everyone's.
 *
 * `read IS NOT TRUE`, never `read = false`: the column is nullable (default
 * false) and `= false` silently skips NULLs — an unread row that never appears
 * and never counts.
 *
 * Archive and Delete are soft (archived_at / deleted_at, E-199/E-200). A deleted
 * row is hidden, not gone (audit + escalation-safety); the feed always excludes
 * deleted rows, and the default `active` view also excludes archived ones.
 */

import { and, desc, eq, inArray, isNotNull, isNull, lt, not, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireAuth } from "@/lib/auth-utils";
import { db } from "@/lib/db";
import { notifications } from "@/lib/db/schema";
import {
  CATEGORIES,
  categorize,
  linkFor,
  priorityOf,
  typeFilterForCategory,
  type NotificationCategory,
  type NotificationRole,
} from "@/lib/notifications/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UNREAD = sql`${notifications.read} IS NOT TRUE`;
const READ = sql`${notifications.read} IS TRUE`;
const FEED_LIMIT = 30;

/** A user-visible 400 (withErrorHandler honours `.status`). */
function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

interface Caller {
  userId: string;
  dealerId: string | null;
  /** Which portal the caller is in — shapes the per-row fallback deep link. */
  role: NotificationRole;
}

/** NBFC seats are `nbfc_*` roles; everyone else falls out of the usual buckets. */
function portalRoleFor(role: string | null | undefined, hasDealerId: boolean): NotificationRole {
  const r = (role ?? "").toLowerCase();
  if (r.startsWith("nbfc") || r === "risk_head") return "nbfc";
  if (r === "scrap_vendor") return "vendor";
  if (r === "dealer" && hasDealerId) return "dealer";
  return "admin";
}

async function caller(): Promise<Caller> {
  const user = await requireAuth();
  return {
    userId: user.id,
    dealerId: user.dealer_id ?? null,
    role: portalRoleFor(user.role, !!user.dealer_id),
  };
}

/**
 * THE scope. Every verb uses it — that is the point. See the doc-block above for
 * why the legacy half is guarded on `user_id IS NULL`.
 */
function recipientScope(c: Caller): SQL {
  const mine = eq(notifications.user_id, c.userId);
  if (!c.dealerId) return mine;
  return or(mine, and(isNull(notifications.user_id), eq(notifications.dealer_id, c.dealerId)))!;
}

/** Adds a category type-filter clause, if the param names a real category. */
function categoryClause(categoryParam: string | null): SQL | null {
  if (!categoryParam || !(CATEGORIES as string[]).includes(categoryParam)) return null;
  const f = typeFilterForCategory(categoryParam as NotificationCategory);
  if (f.types.length === 0) return null;
  return f.negate
    ? (not(inArray(notifications.type, f.types)) as SQL)
    : (inArray(notifications.type, f.types) as SQL);
}

export const GET = withErrorHandler(async (req: Request) => {
  const c = await caller();
  const url = new URL(req.url);

  const status = url.searchParams.get("status"); // unread | read | all
  const unreadLegacy = url.searchParams.get("unread") === "true";
  const view = url.searchParams.get("view") === "archived" ? "archived" : "active";
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || FEED_LIMIT, 1), 100);
  const cursor = url.searchParams.get("cursor");

  const clauses: SQL[] = [recipientScope(c), isNull(notifications.deleted_at)];
  clauses.push(
    view === "archived" ? isNotNull(notifications.archived_at) : isNull(notifications.archived_at),
  );

  if (status === "unread" || unreadLegacy) clauses.push(UNREAD);
  else if (status === "read") clauses.push(READ);

  const catClause = categoryClause(url.searchParams.get("category"));
  if (catClause) clauses.push(catClause);

  // Keyset pagination on (created_at, id) — stable under same-timestamp ties,
  // which offset pagination is not once rows are marked/archived between pages.
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
      lead_id: notifications.lead_id,
      read: notifications.read,
      archived_at: notifications.archived_at,
      created_at: notifications.created_at,
    })
    .from(notifications)
    .where(and(...clauses))
    .orderBy(desc(notifications.created_at), desc(notifications.id))
    .limit(limit);

  // The badge number: unread AND active. Counted in the DB, not from `rows` —
  // the page is capped, so counting it would cap the badge at `limit` too and
  // understate the backlog.
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        recipientScope(c),
        isNull(notifications.deleted_at),
        isNull(notifications.archived_at),
        UNREAD,
      ),
    );

  const enriched = rows.map((r) => {
    const data = (r.data ?? {}) as Record<string, unknown>;
    return {
      ...r,
      category: categorize(r.type),
      priority: priorityOf(r.type),
      // emit() stores a per-recipient href; linkFor only fills the gap for rows
      // written before it existed, so no row is ever a dead click.
      href: linkFor(c.role, r.type, data, r.lead_id),
      from: data.from ?? null,
      to: data.to ?? null,
      stage: data.stage ?? null,
      actions: Array.isArray(data.actions) ? data.actions : null,
    };
  });

  const last = rows[rows.length - 1];
  const next_cursor =
    rows.length === limit && last?.created_at
      ? `${last.created_at.toISOString()}__${last.id}`
      : null;

  return successResponse({
    notifications: enriched,
    unread_count: Number(count),
    next_cursor,
    role: c.role,
  });
});

const patchSchema = z.object({
  /** Specific rows, or omit (action:"read" only) to mark the whole feed. */
  ids: z.array(z.string()).min(1).max(200).optional(),
  action: z.enum(["read", "archive", "unarchive"]).optional(),
  /** Narrows a bulk mark-read to one category — never widens the scope. */
  category: z.string().optional(),
});

export const PATCH = withErrorHandler(async (req: Request) => {
  const c = await caller();
  const body = patchSchema.parse(await req.json().catch(() => ({})));
  const action = body.action ?? "read";

  // The recipient scope is never optional here. Drop it and this marks somebody
  // else's mail — or somebody's escalation — read.
  const scope = recipientScope(c);

  if (action === "archive" || action === "unarchive") {
    if (!body.ids?.length) throw badRequest(`"${action}" needs an explicit ids list.`);
    const updated = await db
      .update(notifications)
      .set({ archived_at: action === "archive" ? new Date() : null })
      .where(and(scope, inArray(notifications.id, body.ids)))
      .returning({ id: notifications.id });
    return successResponse({ updated: updated.length });
  }

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
  const c = await caller();
  const body = deleteSchema.parse(await req.json().catch(() => ({})));

  // Soft — the row is hidden, not gone. Same scope as every other verb.
  const updated = await db
    .update(notifications)
    .set({ deleted_at: new Date() })
    .where(and(recipientScope(c), inArray(notifications.id, body.ids)))
    .returning({ id: notifications.id });

  return successResponse({ deleted: updated.length });
});

/**
 * GET /api/buyback/notifications/summary
 *
 * One role-aware counts endpoint that feeds BOTH the sidebar badges
 * ("Notifications (5)", "Negotiations (2)") and the dashboard action-center
 * strip. Polled on the same cadence as the feed and deduped by React Query.
 *
 * Returns:
 *   unread:  { total, byCategory }   — unread AND active (not archived/deleted),
 *                                      the same definition the feed's badge uses
 *   actions: [{ key, label, count, href }]  — role-scoped workflow-state counts,
 *                                      "what needs my attention", per the caller
 *
 * SCOPE MIRRORS auth.ts: a dealer sees only their own entity's deals, a vendor
 * only threads routed to them, an admin all deals. A caller with no buyback
 * surface gets zeros rather than an error — this is a shared endpoint.
 *
 * PROD-SAFE: the buyback tables do not exist on every environment. The unread
 * query hits `notifications` (CRM-wide, always present); the workflow-count
 * queries are wrapped so a missing relation degrades to an empty actions list
 * instead of a 500.
 */

import { sql } from "drizzle-orm";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireAuth } from "@/lib/auth-utils";
import { portalRoleOf } from "@/lib/buyback/auth";
import { CATEGORIES, categorize, type NotificationCategory } from "@/lib/buyback/notification-meta";
import { db } from "@/lib/db";

export const runtime = "nodejs";

interface ActionChip {
  key: string;
  label: string;
  count: number;
  href: string;
}

type StatusCounts = Record<string, number>;

/** Sum a set of deal/thread statuses out of a GROUP BY result. */
const sum = (counts: StatusCounts, ...statuses: string[]): number =>
  statuses.reduce((n, s) => n + (counts[s] ?? 0), 0);

async function statusCounts(query: ReturnType<typeof sql>): Promise<StatusCounts> {
  const rows = (await db.execute(query)) as unknown as Array<{ status: string; n: number }>;
  const out: StatusCounts = {};
  for (const r of rows) out[String(r.status)] = Number(r.n);
  return out;
}

async function dealerActions(entityId: string): Promise<ActionChip[]> {
  const c = await statusCounts(sql`
    SELECT d.status AS status, count(*)::int AS n
    FROM buyback_deals d
    JOIN buyback_requests br ON br.id = d.request_id
    WHERE br.dealer_entity_id = ${entityId}
    GROUP BY d.status
  `);
  return [
    { key: "in_review", label: "In review", count: sum(c, "SUBMITTED", "UNDER_REVIEW"), href: "/dealer-portal/buyback/requests" },
    {
      key: "needs_response",
      label: "Needs your response",
      count: sum(c, "INFO_REQUESTED", "NEGOTIATING", "FINAL_OFFER_SENT"),
      href: "/dealer-portal/buyback/requests",
    },
    { key: "pickups", label: "Upcoming pickups", count: sum(c, "PICKUP_SCHEDULED"), href: "/dealer-portal/buyback/pickups" },
    { key: "payments", label: "Awaiting payment", count: sum(c, "INVOICE_APPROVED"), href: "/dealer-portal/buyback/payments" },
  ];
}

async function adminActions(): Promise<ActionChip[]> {
  const c = await statusCounts(sql`SELECT status, count(*)::int AS n FROM buyback_deals GROUP BY status`);
  return [
    { key: "new", label: "New requests", count: sum(c, "SUBMITTED"), href: "/admin/buyback" },
    {
      key: "negotiation",
      label: "In negotiation",
      count: sum(c, "NEGOTIATING", "FINAL_OFFER_SENT", "INFO_REQUESTED"),
      href: "/admin/buyback/negotiations",
    },
    { key: "pricing", label: "Needs pricing", count: sum(c, "DEALER_ACCEPTED"), href: "/admin/buyback" },
    { key: "vendor", label: "Vendor leg", count: sum(c, "MARGIN_SET", "VENDOR_ROUTED", "VENDOR_NEGOTIATING"), href: "/admin/buyback" },
    { key: "po", label: "Ready for PO", count: sum(c, "VENDOR_AGREED"), href: "/admin/buyback" },
    { key: "fulfilment", label: "Fulfilment", count: sum(c, "PO_EXCHANGED", "PICKUP_SCHEDULED"), href: "/admin/buyback" },
    { key: "invoices", label: "Invoices to approve", count: sum(c, "INVOICE_RAISED"), href: "/admin/buyback/payments" },
    { key: "settlement", label: "Pending settlement", count: sum(c, "INVOICE_APPROVED"), href: "/admin/buyback/payments" },
  ];
}

async function vendorActions(entityId: string): Promise<ActionChip[]> {
  const c = await statusCounts(sql`
    SELECT t.status AS status, count(*)::int AS n
    FROM vendor_threads t
    JOIN scrap_vendors sv ON sv.id = t.vendor_id
    WHERE sv.entity_id = ${entityId}
    GROUP BY t.status
  `);
  return [
    { key: "new_quotations", label: "New quotations", count: sum(c, "SENT"), href: "/vendor-portal/inbox" },
    { key: "active_bids", label: "Active bids", count: sum(c, "COUNTERED"), href: "/vendor-portal/bids" },
    { key: "won", label: "Won lots", count: sum(c, "AGREED"), href: "/vendor-portal/orders" },
  ];
}

export const GET = withErrorHandler(async () => {
  const user = await requireAuth();
  const vendorEntityId = (user as { vendor_entity_id?: string | null }).vendor_entity_id ?? null;
  const role = portalRoleOf(user.role, !!user.dealer_id, !!vendorEntityId);

  // Unread-by-category — hits `notifications` (present on every env), so always safe.
  const unreadRows = (await db.execute(sql`
    SELECT type, count(*)::int AS n
    FROM notifications
    WHERE user_id = ${user.id} AND type LIKE 'buyback.%'
      AND read IS NOT TRUE AND deleted_at IS NULL AND archived_at IS NULL
    GROUP BY type
  `)) as unknown as Array<{ type: string; n: number }>;

  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<NotificationCategory, number>;
  let total = 0;
  for (const row of unreadRows) {
    const n = Number(row.n);
    byCategory[categorize(String(row.type))] += n;
    total += n;
  }

  // Workflow-state counts — wrapped: on an env with no buyback tables this
  // degrades to an empty list rather than 500ing the shared endpoint.
  let actions: ActionChip[] = [];
  try {
    if (role === "dealer" && user.dealer_id) actions = await dealerActions(user.dealer_id);
    else if (role === "vendor" && vendorEntityId) actions = await vendorActions(vendorEntityId);
    else if (role === "admin") actions = await adminActions();
  } catch {
    actions = [];
  }

  return successResponse({ unread: { total, byCategory }, actions });
});

/**
 * GET /api/dealer-accounts/[id]/history — tracker ID 241-1: the dealer page's
 * header numbers (stage, last invoice, usual gap, revenue, last visit), its
 * booked next visit, and ONE history list (visits, quotes, recorded orders,
 * invoices) newest first. Same access as the account page itself (E-358).
 *
 * The health numbers are My dealers' own (listDealerHealth), so the page and the
 * list never disagree. Amounts a rep reported on a visit are labelled as such
 * and are never part of revenue.
 */
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { ACCOUNT_QUOTE_VIEW_ROLES } from "@/lib/accounts/quotationAccess";
import { assertAccountQuoteAccess } from "@/lib/accounts/quotations/access";
import { listDealerHealth } from "@/lib/dealers/accountHealth";
import { accountHistory, openAccountBooking } from "@/lib/visits/dealerVisitStore";
import { istDay, mayLogAccountVisit } from "@/lib/visits/verifiedCapture";
import { hasOrderClaimTables } from "@/lib/accounts/tables";
import { getTeamMemberIds } from "@/lib/users/team";
import { leadHrefFor } from "@/lib/leads/newOwnerNotice";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (_req: Request, ctx: { params: Promise<{ id: string }> | { id: string } }) => {
    const user = await requireRole([...ACCOUNT_QUOTE_VIEW_ROLES]);
    const { id } = await ctx.params;
    await assertAccountQuoteAccess(user, id, "view");

    const [health, booking, claimsOn, teamIds] = await Promise.all([
        listDealerHealth().then((rows) => rows.find((r) => r.account_id === id) ?? null),
        openAccountBooking(id),
        hasOrderClaimTables(),
        getTeamMemberIds(user.id),
    ]);
    const history = await accountHistory(id, health?.converted_on ?? null, health?.came_through === "lead");
    const lastVisit = history.find((h) => h.kind === "visit") ?? null;
    const lastInvoice = history.find((h) => h.kind === "invoice" && !h.title.startsWith("Credit")) ?? null;

    return successResponse({
        today: istDay(new Date()),
        health: health && {
            bucket: health.bucket,
            dealer: health.dealer,
            city: health.city,
            lead_id: health.lead_id,
            lead_href: health.lead_id ? leadHrefFor(user.role, health.lead_id) : null,
            came_through: health.came_through,
            converted_on: health.converted_on,
            last_order: health.last_order,
            days_since_last_order: health.days_since_last_order,
            days_since_conversion: health.days_since_conversion,
            orders: health.orders,
            revenue_90d: health.revenue_90d,
            revenue_lifetime: health.revenue_lifetime,
            avg_reorder_days: health.avg_reorder_days,
            pending_order: health.order_claim?.status === "pending",
            owner_id: health.owner_id,
            owner_name: health.owner_name,
        },
        last_invoice_title: lastInvoice?.title ?? null,
        last_visit_at: lastVisit?.at ?? null,
        next_visit: booking,
        // Same rules as the My dealers row (IDs 210 and 5).
        can_log_visit: mayLogAccountVisit({ userId: user.id, ownerId: health?.owner_id ?? null, teamIds }),
        can_record_order:
            claimsOn && !!health && health.owner_id === user.id && health.bucket !== "closed" && !health.order_claim,
        owner_is_you: !!health && health.owner_id === user.id,
        history,
    });
});

/**
 * DELETE /api/admin/leads/[id]
 *
 * E-285 — the admin's half of the multi-party delete. Removes the customer
 * application from the ADMIN dashboards (KYC Review, Product Review) only. The
 * dealer keeps their copy and the lender keeps its file; the application is
 * destroyed only when every party that holds it has deleted it.
 *
 * Restricted to admin/ceo — the KYC and product queues are visible to the wider
 * sales roles, but removing a file from the company's own record is not a
 * sales-executive action.
 */
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { markLeadDeleted } from "@/lib/leads/multi-party-delete";

export const dynamic = "force-dynamic";

export const DELETE = withErrorHandler(
  async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireRole(["admin", "ceo"]);
    const { id } = await params;

    const [lead] = await db
      .select({ id: leads.id, deleted_by_admin_at: leads.deleted_by_admin_at })
      .from(leads)
      .where(eq(leads.id, id))
      .limit(1);

    if (!lead) return errorResponse("Application not found", 404);
    if (lead.deleted_by_admin_at) return errorResponse("Application already deleted", 404);

    const { purged, state } = await markLeadDeleted({
      leadId: id,
      scope: "admin",
      userId: user.id,
    });

    const waitingOn: string[] = [];
    if (!state.dealerDeletedAt) waitingOn.push("dealer");
    if (state.liveNbfcAssignments > 0) waitingOn.push("NBFC");

    return successResponse({
      success: true,
      purged,
      message: purged
        ? "Application deleted."
        : `Removed from the admin dashboard. Still held by: ${waitingOn.join(" and ")}.`,
    });
  },
);

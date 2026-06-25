import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dualApprovalRequests } from "@/lib/db/schema";
import { getCurrentTenant, getCurrentNbfcRole } from "@/lib/nbfc/tenant";
import { BATTERY_IMMOBILISATION_ACTION_TYPE } from "@/lib/nbfc/actions/battery-immobilisation/service";
import RiskHeadShell from "@/components/risk-head/RiskHeadShell";

/**
 * Risk Head dashboard shell (/risk-head).
 *
 * Second surface of the two-person battery-immobilisation gate. Gated to the
 * NBFC `nbfc_risk_head` role (admin/ceo allowed for support); everyone else is
 * bounced to the NBFC partner dashboard. Both surfaces share the same tenant
 * context — the role distinction lives only in nbfc_users.role.
 */
export const dynamic = "force-dynamic";

export default async function RiskHeadLayout({
  children,
}: {
  children: ReactNode;
}) {
  const tenant = await getCurrentTenant();
  const role = await getCurrentNbfcRole(tenant.id);

  const allowed = role === "nbfc_risk_head" || role === "admin" || role === "ceo";
  if (!allowed) {
    redirect("/nbfc");
  }

  // Pending immobilisation approvals awaiting this Risk Head, for the nav badge.
  const pending = await db
    .select({ id: dualApprovalRequests.id })
    .from(dualApprovalRequests)
    .where(
      and(
        eq(dualApprovalRequests.tenant_id, tenant.id),
        eq(dualApprovalRequests.status, "pending_approval"),
        eq(dualApprovalRequests.required_approver_role, "nbfc_risk_head"),
        eq(dualApprovalRequests.action_type, BATTERY_IMMOBILISATION_ACTION_TYPE),
      ),
    );

  return (
    <RiskHeadShell tenantName={tenant.display_name} pendingCount={pending.length}>
      {children}
    </RiskHeadShell>
  );
}

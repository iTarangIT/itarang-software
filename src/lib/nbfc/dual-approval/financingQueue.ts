// The CEO's Financing approvals queue (/admin/nbfc/financing-offers/approvals):
// financing-offer deviations still waiting for the CEO. One predicate for the
// page's list and the menu count (ID 90).

import { and, eq, type SQL } from "drizzle-orm";

import { dualApprovalRequests } from "@/lib/db/schema";
import { FINANCING_OFFER_DEVIATION_ACTION } from "@/lib/nbfc/dual-approval/service";

export const pendingFinancingDeviationWhere: SQL = and(
    eq(dualApprovalRequests.action_type, FINANCING_OFFER_DEVIATION_ACTION),
    eq(dualApprovalRequests.status, "pending_approval"),
) as SQL;

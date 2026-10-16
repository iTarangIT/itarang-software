// The deal / order approval queues: Sales Head approves at level 1
// (/sales-head/approvals), Business Head at level 2 (/business-head/approvals).
// One predicate for each page's pending list and the menu count (ID 90).

import { and, eq, type SQL } from "drizzle-orm";

import { approvals } from "@/lib/db/schema";

export type ApprovalQueueRole = "sales_head" | "business_head";

const LEVEL: Record<ApprovalQueueRole, number> = { sales_head: 1, business_head: 2 };

/** Every approval waiting on this role's decision. */
export function pendingApprovalsWhere(role: ApprovalQueueRole): SQL {
    return and(
        eq(approvals.status, "pending"),
        eq(approvals.approver_role, role),
        eq(approvals.level, LEVEL[role]),
    ) as SQL;
}

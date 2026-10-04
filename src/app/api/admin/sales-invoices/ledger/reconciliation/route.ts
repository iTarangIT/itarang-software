/**
 * E-322 (tracker ID 71) — GET /api/admin/sales-invoices/ledger/reconciliation?month=YYYY-MM
 * CRM revenue for the month vs the filed GSTR-1 (imported via the ledger
 * import), with every difference listed. Defaults to last month.
 */
import { NextRequest } from "next/server";

import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { reconcileMonth } from "@/lib/sales/gstr1Reconcile";
import { requireLedger } from "../_auth";

export const dynamic = "force-dynamic";

function lastMonth(): string {
    const ist = new Date(Date.now() + 330 * 60_000);
    const y = ist.getUTCFullYear();
    const m = ist.getUTCMonth(); // 0-based → this is last month, 1-based
    return m === 0 ? `${y - 1}-12` : `${y}-${String(m).padStart(2, "0")}`;
}

export const GET = withErrorHandler(async (req: NextRequest) => {
    await requireLedger();
    const month = new URL(req.url).searchParams.get("month") ?? lastMonth();
    if (!/^\d{4}-\d{2}$/.test(month)) return errorResponse("month must be YYYY-MM", 400);
    return successResponse(await reconcileMonth(month));
});

/**
 * E-322 (tracker ID 39) — GET /api/admin/sales-invoices/ledger/sku?from&to
 * Units and amount before GST by SKU and month, from invoice lines.
 */
import { NextRequest } from "next/server";

import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { skuReport } from "@/lib/sales/skuReport";
import { requireLedger } from "../_auth";

export const dynamic = "force-dynamic";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const GET = withErrorHandler(async (req: NextRequest) => {
    await requireLedger();
    const url = new URL(req.url);
    const to = url.searchParams.get("to") ?? new Date().toISOString().slice(0, 10);
    const from = url.searchParams.get("from") ?? `${to.slice(0, 7)}-01`;
    if (!DAY.test(from) || !DAY.test(to)) return errorResponse("from / to must be YYYY-MM-DD", 400);
    return successResponse({ from, to, ...(await skuReport(from, to)) });
});

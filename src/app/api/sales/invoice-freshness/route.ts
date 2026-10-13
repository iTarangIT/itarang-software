// GET /api/sales/invoice-freshness — ID 171: how far the invoice data goes.
//
// { read_up_to, last_read_at, working_days_since_read, stale_after, stale }
// for the "Invoices read up to <date>" caption under revenue and battery
// numbers (CEO overview, Invoice Ledger, Sales Head). Everyone who sees those
// numbers may read it.

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { invoiceFreshness } from "@/lib/sales/invoiceFreshness";

export const dynamic = "force-dynamic";

const READ_ROLES = ["admin", "ceo", "finance_controller", "sales_head", "business_head", "partner"];

export const GET = withErrorHandler(async () => {
    await requireRole(READ_ROLES);
    return successResponse(await invoiceFreshness());
});

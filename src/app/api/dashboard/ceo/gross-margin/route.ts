/**
 * Gross margin by month and business type (tracker IDs 72, 147).
 *
 * GET ?from=YYYY-MM-DD&to=YYYY-MM-DD   the report (src/lib/dashboard/grossMargin.ts).
 *
 * Item → product mapping is NOT here any more (ID 147): there is one mapping,
 * Invoice Ledger › Item mapping (/api/admin/sales-invoices/ledger/items), used
 * by gross margin and By SKU alike.
 *
 * CEO and Admin, like the price books the cost side reads.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-utils";
import { errorMessage, isNextRedirectError } from "@/lib/api-utils";
import { grossMarginByMonth } from "@/lib/dashboard/grossMargin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["ceo", "admin"]);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const bad = (message: string, status = 400) =>
    NextResponse.json({ success: false, error: { message } }, { status });

export async function GET(req: NextRequest) {
    try {
        const user = await requireAuth();
        if (!ALLOWED_ROLES.has((user.role || "").toLowerCase())) return bad("Forbidden", 403);
        const p = new URL(req.url).searchParams;
        const from = p.get("from");
        const to = p.get("to");
        if ((from && !DAY_RE.test(from)) || (to && !DAY_RE.test(to))) return bad("Dates must be YYYY-MM-DD.");

        const report = await grossMarginByMonth({ from, to });
        return NextResponse.json({ success: true, data: { report } });
    } catch (err) {
        if (isNextRedirectError(err)) throw err;
        console.error("[gross-margin] GET failed:", err);
        return bad(errorMessage(err) || "Could not load gross margin", 500);
    }
}

/**
 * E-326 — gross margin by month and business type (tracker ID 72).
 *
 * GET   ?from=YYYY-MM-DD&to=YYYY-MM-DD   the report (src/lib/dashboard/grossMargin.ts).
 *       ?mappings=1                      also the invoice item → product mapping
 *                                        and the products an item can be mapped to.
 * POST  { item_key, product_id | null }  map an invoice item to a product.
 *
 * CEO and Admin, like the price books the cost side reads.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth-utils";
import { errorMessage, isNextRedirectError } from "@/lib/api-utils";
import {
    grossMarginByMonth,
    grossMarginTablesPresent,
    listItemMappings,
    listMarginProducts,
    setItemProduct,
} from "@/lib/dashboard/grossMargin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["ceo", "admin"]);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const BodySchema = z.object({
    item_key: z.string().min(1).max(500),
    product_id: z.string().uuid().nullable(),
});

const bad = (message: string, status = 400) =>
    NextResponse.json({ success: false, error: { message } }, { status });

async function authorised() {
    const user = await requireAuth();
    return ALLOWED_ROLES.has((user.role || "").toLowerCase()) ? user : null;
}

export async function GET(req: NextRequest) {
    try {
        if (!(await authorised())) return bad("Forbidden", 403);
        const p = new URL(req.url).searchParams;
        const from = p.get("from");
        const to = p.get("to");
        if ((from && !DAY_RE.test(from)) || (to && !DAY_RE.test(to))) return bad("Dates must be YYYY-MM-DD.");

        const report = await grossMarginByMonth({ from, to });
        if (p.get("mappings") !== "1" || !report.available) {
            return NextResponse.json({ success: true, data: { report } });
        }
        const [mappings, products] = await Promise.all([listItemMappings(), listMarginProducts()]);
        return NextResponse.json({ success: true, data: { report, mappings, products } });
    } catch (err) {
        if (isNextRedirectError(err)) throw err;
        console.error("[gross-margin] GET failed:", err);
        return bad(errorMessage(err) || "Could not load gross margin", 500);
    }
}

export async function POST(req: NextRequest) {
    try {
        const user = await authorised();
        if (!user) return bad("Forbidden", 403);
        const parsed = BodySchema.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return bad("Pick the item and a product.");
        if (!(await grossMarginTablesPresent())) return bad("Invoice lines are not set up on this database (E-326).", 503);

        const ok = await setItemProduct(parsed.data.item_key, parsed.data.product_id, user.id);
        if (!ok) return bad("That item or product no longer exists.", 404);
        return NextResponse.json({ success: true });
    } catch (err) {
        if (isNextRedirectError(err)) throw err;
        console.error("[gross-margin] POST failed:", err);
        return bad(errorMessage(err) || "Could not save the mapping", 500);
    }
}

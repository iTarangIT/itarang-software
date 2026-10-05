/**
 * E-323 — the product LIST price book (tracker IDs 4 and 47).
 *
 * GET     every active product with its OEM price, the list price in force and
 *         the next one scheduled. With ?asset_type=&product_id=: every line
 *         for that product, newest first, with who set it.
 * POST    add a list price line — a revision if it starts now, a scheduled
 *         successor if it starts later. Refused when it would sit below the
 *         OEM price on any date it covers.
 * DELETE  drop a scheduled line that has not started yet.
 *
 * Same roles and the same dated, append-only behaviour as the OEM price book
 * next door (../oem-prices). The list price is optional: a product without one
 * prints its OEM price as the list price on the quotation.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth-utils";
import { errorMessage, isNextRedirectError } from "@/lib/api-utils";
import { isOemAssetType, lookupMasterProduct, OEM_ASSET_TYPES } from "@/lib/leads/oemPrices";
import {
    deleteScheduledListPrice,
    listListPriceCatalogue,
    listListPriceHistory,
    ListPriceError,
    setListPrice,
} from "@/lib/leads/listPriceCatalogue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["ceo", "admin"]);

// A date-only string from the picker is the START of that day in IST — see the
// OEM price route for why UTC midnight would be wrong.
function istDay(day: string): Date {
    return new Date(`${day}T00:00:00+05:30`);
}

const DayString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

const BodySchema = z.object({
    asset_type: z.enum(OEM_ASSET_TYPES),
    product_id: z.string().min(1).max(200),
    list_price: z.number().positive().max(99_999_999.99),
    effective_from: DayString.nullable().optional(),
    valid_until: DayString.nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
});

const DeleteSchema = z.object({ price_id: z.string().uuid() });

const bad = (message: string, status = 400) =>
    NextResponse.json({ success: false, error: { message } }, { status });

async function authorised() {
    const user = await requireAuth();
    return ALLOWED_ROLES.has((user.role || "").toLowerCase()) ? user : null;
}

function failure(e: unknown) {
    if (isNextRedirectError(e)) throw e;
    if (e instanceof ListPriceError) return bad(e.message, 409);
    if (e instanceof z.ZodError) return bad(e.issues[0]?.message ?? "Invalid body");
    return NextResponse.json({ success: false, error: { message: errorMessage(e) } }, { status: 500 });
}

export async function GET(req: NextRequest) {
    try {
        if (!(await authorised())) return bad("FORBIDDEN", 403);

        // ?asset_type=&product_id= — every line for one product (the history).
        const params = req.nextUrl.searchParams;
        const assetType = params.get("asset_type");
        const productId = params.get("product_id");
        if (assetType || productId) {
            if (!assetType || !isOemAssetType(assetType) || !productId) return bad("Unknown product.");
            return NextResponse.json({ success: true, data: { revisions: await listListPriceHistory(assetType, productId) } });
        }

        const products = await listListPriceCatalogue();
        return NextResponse.json({
            success: true,
            data: { products, without_list_price: products.filter((p) => p.list_price == null).length },
        });
    } catch (e: unknown) {
        return failure(e);
    }
}

export async function POST(req: NextRequest) {
    try {
        const user = await authorised();
        if (!user) return bad("FORBIDDEN", 403);
        const body = BodySchema.parse(await req.json());

        const product = await lookupMasterProduct(body.asset_type, body.product_id);
        if (!product) return bad(`No active ${body.asset_type} product with that id.`, 404);

        const effectiveFrom = body.effective_from ? istDay(body.effective_from) : new Date();
        const validUntil = body.valid_until ? istDay(body.valid_until) : null;

        const priceId = await setListPrice({
            asset_type: body.asset_type,
            product_id: body.product_id,
            model_id: product.model_id || null,
            product_name: product.product_name || null,
            list_price: body.list_price,
            effective_from: effectiveFrom,
            valid_until: validUntil,
            note: body.note ?? null,
            created_by: user.id,
        });
        return NextResponse.json({
            success: true,
            data: { price_id: priceId, scheduled: effectiveFrom.getTime() > Date.now() },
        });
    } catch (e: unknown) {
        return failure(e);
    }
}

export async function DELETE(req: NextRequest) {
    try {
        if (!(await authorised())) return bad("FORBIDDEN", 403);
        const body = DeleteSchema.parse(await req.json());
        const result = await deleteScheduledListPrice(body.price_id);
        if (!result.deleted) return bad(result.reason ?? "Could not remove that line.", 409);
        return NextResponse.json({ success: true, data: { removed: body.price_id } });
    } catch (e: unknown) {
        return failure(e);
    }
}

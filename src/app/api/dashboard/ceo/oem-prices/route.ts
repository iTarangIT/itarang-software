/**
 * E-226 — the OEM reference price book.
 *
 * GET   every active product across the three product masters, with its live
 *       reference price where one has been set.
 * POST  revise one product's price.
 *
 * This is the "update without code changes" surface the auto-approval rule
 * depends on: prices move every two or three months and nothing here is
 * compiled in. A revision closes the live row and inserts a new one, so the
 * price a past quote was judged against survives the revision — see
 * src/lib/leads/oemPrices.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth-utils";
import { errorMessage, isNextRedirectError } from "@/lib/api-utils";
import {
    listOemCatalogue,
    lookupMasterProduct,
    setOemPrice,
    OEM_ASSET_TYPES,
} from "@/lib/leads/oemPrices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["ceo", "admin"]);

const BodySchema = z.object({
    asset_type: z.enum(OEM_ASSET_TYPES),
    product_id: z.string().min(1).max(200),
    // Non-negative rather than positive: a genuinely free item is a real price,
    // and refusing to record it would leave that product permanently unpriced
    // and so permanently blocking auto-approval.
    oem_price: z.number().nonnegative().max(99_999_999.99),
    note: z.string().trim().max(500).nullable().optional(),
});

function forbidden() {
    return NextResponse.json(
        { success: false, error: { message: "FORBIDDEN" } },
        { status: 403 },
    );
}

export async function GET() {
    try {
        const user = await requireAuth();
        if (!ALLOWED_ROLES.has((user.role || "").toLowerCase())) return forbidden();

        const products = await listOemCatalogue();
        return NextResponse.json({
            success: true,
            data: {
                products,
                // The count that matters operationally: every unpriced product
                // is one that still forces its quotes to the CEO.
                unpriced: products.filter((p) => p.oem_price == null).length,
                total: products.length,
            },
        });
    } catch (e: unknown) {
        if (isNextRedirectError(e)) throw e;
        return NextResponse.json(
            { success: false, error: { message: errorMessage(e) } },
            { status: 500 },
        );
    }
}

export async function POST(req: NextRequest) {
    try {
        const user = await requireAuth();
        if (!ALLOWED_ROLES.has((user.role || "").toLowerCase())) return forbidden();

        const body = BodySchema.parse(await req.json());

        // A price against a product that is in no master would sit in the table
        // forever and never match a quote line — an invisible no-op rather than
        // an error, which is the worst way for this to fail.
        const product = await lookupMasterProduct(body.asset_type, body.product_id);
        if (!product) {
            return NextResponse.json(
                {
                    success: false,
                    error: {
                        message: `No active ${body.asset_type} product with that id.`,
                    },
                },
                { status: 404 },
            );
        }

        // model_id and product_name are snapshotted from the master at this
        // moment so a later rename leaves the history readable.
        const priceId = await setOemPrice({
            asset_type: body.asset_type,
            product_id: body.product_id,
            model_id: product.model_id || null,
            product_name: product.product_name || null,
            oem_price: body.oem_price,
            note: body.note ?? null,
            created_by: user.id,
        });

        return NextResponse.json({ success: true, data: { price_id: priceId } });
    } catch (e: unknown) {
        if (isNextRedirectError(e)) throw e;
        if (e instanceof z.ZodError) {
            return NextResponse.json(
                {
                    success: false,
                    error: { message: e.issues[0]?.message ?? "Invalid body" },
                },
                { status: 400 },
            );
        }
        return NextResponse.json(
            { success: false, error: { message: errorMessage(e) } },
            { status: 500 },
        );
    }
}

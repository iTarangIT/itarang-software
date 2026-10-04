/**
 * E-321 — GET /api/dashboard/ceo/list-prices/:assetType/:productId/history
 *
 * Every list-price line for one product, newest first: history, the one in
 * force, and anything scheduled. Empty where E-321 is not applied.
 */
import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-utils";
import { errorMessage, isNextRedirectError } from "@/lib/api-utils";
import { isOemAssetType } from "@/lib/leads/oemPrices";
import { listListPriceHistory } from "@/lib/leads/listPrices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["ceo", "admin"]);

export async function GET(
    _req: Request,
    ctx: { params: Promise<{ assetType: string; productId: string }> },
) {
    try {
        const user = await requireAuth();
        if (!ALLOWED_ROLES.has((user.role || "").toLowerCase())) {
            return NextResponse.json(
                { success: false, error: { message: "FORBIDDEN" } },
                { status: 403 },
            );
        }

        const { assetType, productId } = await ctx.params;
        if (!isOemAssetType(assetType)) {
            return NextResponse.json(
                { success: false, error: { message: "Unknown asset type." } },
                { status: 400 },
            );
        }

        const revisions = await listListPriceHistory(assetType, productId);
        return NextResponse.json({ success: true, data: { revisions } });
    } catch (e: unknown) {
        if (isNextRedirectError(e)) throw e;
        return NextResponse.json(
            { success: false, error: { message: errorMessage(e) } },
            { status: 500 },
        );
    }
}

/**
 * E-226 — GET /api/dashboard/ceo/oem-prices/:assetType/:productId/history
 *
 * Every revision of one product's reference price, newest first.
 *
 * This is the audit surface the requirement asks for: the table is append-only,
 * so each row here is a price that was actually live for the window between its
 * effective_from and effective_to, and a quote approved in that window can be
 * checked against it.
 */
import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-utils";
import { errorMessage, isNextRedirectError } from "@/lib/api-utils";
import { isOemAssetType, listOemPriceHistory } from "@/lib/leads/oemPrices";

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

        const revisions = await listOemPriceHistory(assetType, productId);
        return NextResponse.json({ success: true, data: { revisions } });
    } catch (e: unknown) {
        if (isNextRedirectError(e)) throw e;
        return NextResponse.json(
            { success: false, error: { message: errorMessage(e) } },
            { status: 500 },
        );
    }
}

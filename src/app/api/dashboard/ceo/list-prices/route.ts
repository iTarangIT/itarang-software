/**
 * E-321 (tracker ID 4 / handover P1-14) — the optional quotation list price.
 *
 * GET     the live and next-scheduled list price for every product that has
 *         one. `available: false` where E-321 is not applied.
 * POST    add a list-price line — a revision if it starts now, a queued
 *         successor if it starts later. 422 if below an overlapping OEM price.
 * DELETE  drop a scheduled line that has not started yet.
 *
 * Roles ceo + admin, exactly like ../oem-prices. The OEM price stays internal
 * and decides approval; the list price only prints on the quotation. See
 * src/lib/leads/listPrices.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth-utils";
import { errorMessage, isNextRedirectError } from "@/lib/api-utils";
import { lookupMasterProduct, OEM_ASSET_TYPES } from "@/lib/leads/oemPrices";
import {
    deleteScheduledListPrice,
    listLiveListPrices,
    setListPrice,
    ListPriceBelowOemError,
    ListPriceOverlapError,
    ListPriceUnavailableError,
} from "@/lib/leads/listPrices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["ceo", "admin"]);

/** A date-only picker value read as the START of that day in IST (see oem-prices). */
const IST_OFFSET = "+05:30";
function istDay(day: string): Date {
    return new Date(`${day}T00:00:00${IST_OFFSET}`);
}

const DayString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

const BodySchema = z.object({
    asset_type: z.enum(OEM_ASSET_TYPES),
    product_id: z.string().min(1).max(200),
    list_price: z.number().nonnegative().max(99_999_999.99),
    /** Omitted = starts now, i.e. an ordinary revision. */
    effective_from: DayString.nullable().optional(),
    /** Omitted = open-ended. */
    valid_until: DayString.nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
});

const DeleteSchema = z.object({ price_id: z.string().uuid() });

function forbidden() {
    return NextResponse.json(
        { success: false, error: { message: "FORBIDDEN" } },
        { status: 403 },
    );
}

function bad(message: string, status = 400) {
    return NextResponse.json({ success: false, error: { message } }, { status });
}

export async function GET() {
    try {
        const user = await requireAuth();
        if (!ALLOWED_ROLES.has((user.role || "").toLowerCase())) return forbidden();

        const { available, rows } = await listLiveListPrices();
        return NextResponse.json({ success: true, data: { available, prices: rows } });
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

        const product = await lookupMasterProduct(body.asset_type, body.product_id);
        if (!product) {
            return bad(`No active ${body.asset_type} product with that id.`, 404);
        }

        const effectiveFrom = body.effective_from ? istDay(body.effective_from) : new Date();
        const validUntil = body.valid_until ? istDay(body.valid_until) : null;
        if (validUntil && validUntil <= effectiveFrom) {
            return bad("The validity end date must be after the start date.");
        }

        const priceId = await setListPrice({
            asset_type: body.asset_type,
            product_id: body.product_id,
            model_id: product.model_id || null,
            product_name: product.product_name || null,
            list_price: body.list_price,
            effective_from: effectiveFrom,
            valid_until: validUntil,
            note: body.note ?? null,
            actor: { id: user.id },
        });

        return NextResponse.json({
            success: true,
            data: { price_id: priceId, scheduled: effectiveFrom.getTime() > Date.now() },
        });
    } catch (e: unknown) {
        if (isNextRedirectError(e)) throw e;
        if (e instanceof ListPriceBelowOemError) return bad(e.message, 422);
        if (e instanceof ListPriceOverlapError) return bad(e.message, 409);
        if (e instanceof ListPriceUnavailableError) return bad(e.message, 503);
        if (e instanceof z.ZodError) {
            return bad(e.issues[0]?.message ?? "Invalid body");
        }
        return NextResponse.json(
            { success: false, error: { message: errorMessage(e) } },
            { status: 500 },
        );
    }
}

export async function DELETE(req: NextRequest) {
    try {
        const user = await requireAuth();
        if (!ALLOWED_ROLES.has((user.role || "").toLowerCase())) return forbidden();

        const body = DeleteSchema.parse(await req.json());
        const result = await deleteScheduledListPrice(body.price_id);
        if (!result.deleted) return bad(result.reason ?? "Could not remove that line.", 409);

        return NextResponse.json({ success: true, data: { removed: body.price_id } });
    } catch (e: unknown) {
        if (isNextRedirectError(e)) throw e;
        if (e instanceof z.ZodError) {
            return bad(e.issues[0]?.message ?? "Invalid body");
        }
        return NextResponse.json(
            { success: false, error: { message: errorMessage(e) } },
            { status: 500 },
        );
    }
}

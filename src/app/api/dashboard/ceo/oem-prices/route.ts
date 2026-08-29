/**
 * E-226 + E-230 — the OEM reference price book.
 *
 * GET     every active product across the three product masters, with the price
 *         in force and the next one scheduled behind it.
 * POST    add a price line — a revision if it starts now, a queued successor if
 *         it starts later.
 * DELETE  drop a scheduled line that has not started yet.
 *
 * This is the "update without code changes" surface the auto-approval rule
 * depends on: prices move every two or three months and nothing here is
 * compiled in. Lines are never edited in place, so the price a past quote was
 * judged against survives — see src/lib/leads/oemPrices.ts.
 *
 * PATH NOTE: this still lives under /dashboard/ceo because that is where E-226
 * put it, but the screen it serves is /oem-pricing and the roles are ceo AND
 * admin — the requirement names Admin alongside the CEO throughout. Renaming
 * the route would be churn with no behavioural change.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth-utils";
import { errorMessage, isNextRedirectError } from "@/lib/api-utils";
import {
    deleteScheduledOemPrice,
    listOemCatalogue,
    lookupMasterProduct,
    setOemPrice,
    OemPriceOverlapError,
    OEM_ASSET_TYPES,
} from "@/lib/leads/oemPrices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["ceo", "admin"]);

/**
 * A date-only string from the picker, read as the START of that day in IST.
 *
 * The requirement is stated in whole days — "valid until August 1st" — and the
 * people setting these prices work in IST. Parsing "2026-08-01" with `new Date`
 * would read it as UTC midnight, which is 05:30 IST, so a price would lapse
 * five and a half hours into the morning of the day it was supposed to cover.
 */
const IST_OFFSET = "+05:30";
function istDay(day: string): Date {
    return new Date(`${day}T00:00:00${IST_OFFSET}`);
}

const DayString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

const BodySchema = z.object({
    asset_type: z.enum(OEM_ASSET_TYPES),
    product_id: z.string().min(1).max(200),
    // Non-negative rather than positive: a genuinely free item is a real price,
    // and refusing to record it would leave that product permanently unpriced
    // and so permanently blocking auto-approval.
    oem_price: z.number().nonnegative().max(99_999_999.99),
    /** Omitted = starts now, i.e. an ordinary revision. */
    effective_from: DayString.nullable().optional(),
    /** Omitted = open-ended, which is E-226's behaviour. */
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

        const products = await listOemCatalogue();
        const now = Date.now();
        const soon = now + 14 * 24 * 60 * 60_000;

        return NextResponse.json({
            success: true,
            data: {
                products,
                // The counts that matter operationally. Unpriced products force
                // every quote containing them to the CEO; expiring ones are
                // about to join them.
                unpriced: products.filter((p) => p.oem_price == null).length,
                expiring: products.filter((p) => {
                    if (p.oem_price == null || !p.valid_until) return false;
                    if (p.next_price != null) return false;
                    const t = new Date(p.valid_until).getTime();
                    return t > now && t <= soon;
                }).length,
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
            return bad(`No active ${body.asset_type} product with that id.`, 404);
        }

        const effectiveFrom = body.effective_from
            ? istDay(body.effective_from)
            : new Date();
        const validUntil = body.valid_until ? istDay(body.valid_until) : null;

        if (validUntil && validUntil <= effectiveFrom) {
            return bad("The validity end date must be after the start date.");
        }

        // model_id and product_name are snapshotted from the master at this
        // moment so a later rename leaves the history readable.
        const priceId = await setOemPrice({
            asset_type: body.asset_type,
            product_id: body.product_id,
            model_id: product.model_id || null,
            product_name: product.product_name || null,
            oem_price: body.oem_price,
            effective_from: effectiveFrom,
            valid_until: validUntil,
            note: body.note ?? null,
            created_by: user.id,
        });

        return NextResponse.json({
            success: true,
            data: {
                price_id: priceId,
                scheduled: effectiveFrom.getTime() > Date.now(),
            },
        });
    } catch (e: unknown) {
        if (isNextRedirectError(e)) throw e;
        // 409, not 500: the window clashes with one already on the schedule.
        // That is a decision for the person at the screen, and the message
        // names the date they need to work around.
        if (e instanceof OemPriceOverlapError) return bad(e.message, 409);
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
        const result = await deleteScheduledOemPrice(body.price_id);
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

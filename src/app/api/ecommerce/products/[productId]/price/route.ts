// PATCH /api/ecommerce/products/:productId/price   (Phase 5)
//
// Price lives on the variant, not the product, so this goes through
// PATCH .../variants/batch. That endpoint was verified PARTIAL: a prices-only
// body leaves `inventory_quantity` untouched, so no read-modify-write is needed
// and a price edit cannot clobber stock.
//
// Inventory is deliberately NOT settable here — that is Phase 6, and mixing it
// in would reintroduce the lost-update race against concurrent purchases.

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireEcommerceAdmin } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { updateEcommerceProductPrice } from "@/lib/ecommerce/product-service";

export const dynamic = "force-dynamic";

const ParamsSchema = z.object({
    productId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "Invalid product id"),
});

const BodySchema = z.object({
    variantId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "Invalid variant id"),
    // Smallest currency unit. The client converts from rupees; this re-validates
    // independently, because a 100x error here is the worst failure available.
    amountMinor: z.number().int().min(1),
    currency: z.string().trim().length(3),
});

export const PATCH = withErrorHandler(
    async (req: NextRequest, ctx: { params: Promise<{ productId: string }> }) => {
        const user = await requireEcommerceAdmin();

        const { productId } = ParamsSchema.parse(await ctx.params);
        const body = BodySchema.parse(await req.json());

        await updateEcommerceProductPrice(
            productId,
            body.variantId,
            body.amountMinor,
            body.currency,
            { id: user.id, role: user.role },
        );

        return successResponse({ productId, ...body });
    },
);

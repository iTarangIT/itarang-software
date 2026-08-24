// PATCH /api/ecommerce/products/:productId/price   (Phase 5, extended in 8A)
//
// Covers a variant's price and discount price. The Phase 5 body (variantId +
// amountMinor + currency) still works unchanged; saleAmountMinor is an optional
// addition.
//
// SKU is NOT here: the batch endpoint silently ignores it (verified), so it can
// only be set when a variant is created. Accepting it would report success while
// changing nothing.
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
import { updateEcommerceVariantCommercial } from "@/lib/ecommerce/product-service";

export const dynamic = "force-dynamic";

const ParamsSchema = z.object({
    productId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "Invalid product id"),
});

const BodySchema = z
    .object({
        variantId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "Invalid variant id"),
        // Smallest currency unit. The client converts from rupees; this re-validates
        // independently, because a 100x error here is the worst failure available.
        amountMinor: z.number().int().min(1).optional(),
        // null CLEARS the discount. The API rejects sale_amount:null, so the service
        // clears it by omitting the key from the replacement price object instead.
        saleAmountMinor: z.number().int().min(0).nullable().optional(),
        currency: z.string().trim().length(3).optional(),
    })
    .refine(
        (v) =>
            v.amountMinor !== undefined || v.saleAmountMinor !== undefined,
        { message: "Provide at least one of amountMinor or saleAmountMinor" },
    )
    .refine(
        (v) =>
            v.saleAmountMinor === undefined ||
            v.saleAmountMinor === null ||
            v.amountMinor === undefined ||
            v.saleAmountMinor < v.amountMinor,
        {
            // A discount at or above list price is almost certainly a slip, and it
            // would publish to the storefront as a "discount" that costs more.
            message: "The discount price must be lower than the price",
        },
    );

export const PATCH = withErrorHandler(
    async (req: NextRequest, ctx: { params: Promise<{ productId: string }> }) => {
        const user = await requireEcommerceAdmin();

        const { productId } = ParamsSchema.parse(await ctx.params);
        const body = BodySchema.parse(await req.json());

        await updateEcommerceVariantCommercial(productId, body, {
            id: user.id,
            role: user.role,
        });

        return successResponse({ productId, ...body });
    },
);

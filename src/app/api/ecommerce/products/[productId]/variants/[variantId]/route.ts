// PATCH  /api/ecommerce/products/:productId/variants/:variantId   (Phase 8B)
// DELETE /api/ecommerce/products/:productId/variants/:variantId
//
// PATCH covers the fields the batch endpoint actually accepts — title, price and
// discount. It does NOT accept `options` (400 upstream) or `sku` (silently
// ignored upstream, which would let the CRM report a success that never
// happened). Stock has its own route so a price edit cannot disturb it.
//
// DELETE refuses to remove the product's last variant: Hostinger allows that and
// leaves a published product with no price and no stock.

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireEcommerceAdmin } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import {
    deleteEcommerceVariant,
    updateEcommerceVariantCommercial,
} from "@/lib/ecommerce/product-service";

export const dynamic = "force-dynamic";

const ParamsSchema = z.object({
    productId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "Invalid product id"),
    variantId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "Invalid variant id"),
});

const BodySchema = z
    .object({
        title: z.string().trim().min(1).max(255).optional(),
        amountMinor: z.number().int().min(0).optional(),
        // null CLEARS the discount — the API rejects sale_amount:null, so the
        // service clears it by omitting the key from the replacement price.
        saleAmountMinor: z.number().int().min(0).nullable().optional(),
        currency: z.string().trim().length(3).optional(),
    })
    .refine(
        (v) =>
            v.title !== undefined ||
            v.amountMinor !== undefined ||
            v.saleAmountMinor !== undefined,
        { message: "Provide at least one of title, amountMinor or saleAmountMinor" },
    )
    .refine(
        (v) =>
            v.saleAmountMinor === undefined ||
            v.saleAmountMinor === null ||
            v.amountMinor === undefined ||
            v.saleAmountMinor < v.amountMinor,
        { message: "The discount price must be lower than the price" },
    );

export const PATCH = withErrorHandler(
    async (req: NextRequest, ctx: { params: Promise<{ productId: string; variantId: string }> }) => {
        const user = await requireEcommerceAdmin();
        const { productId, variantId } = ParamsSchema.parse(await ctx.params);
        const body = BodySchema.parse(await req.json());

        await updateEcommerceVariantCommercial(
            productId,
            { variantId, ...body },
            { id: user.id, role: user.role },
        );

        return successResponse({ productId, variantId, ...body });
    },
);

export const DELETE = withErrorHandler(
    async (
        _req: NextRequest,
        ctx: { params: Promise<{ productId: string; variantId: string }> },
    ) => {
        const user = await requireEcommerceAdmin();
        const { productId, variantId } = ParamsSchema.parse(await ctx.params);

        const result = await deleteEcommerceVariant(productId, variantId, {
            id: user.id,
            role: user.role,
        });

        return successResponse({ productId, variantId, ...result });
    },
);

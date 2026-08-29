// PATCH /api/ecommerce/products/:productId/inventory   (Phase 6)
//
// Stock lives on the variant, so this goes through PATCH .../variants/batch —
// the same endpoint as price, but a strictly separate payload. `prices` is never
// sent: the docs state prices "replace the variant's existing prices in full",
// so a stock edit that carried them could drop a variant's other-currency prices.
//
// Writes are ABSOLUTE (the resulting quantity, not a delta) and idempotent, so a
// retry cannot double-count. What an absolute write CAN do is silently discard a
// change that landed in between, which is what `expectedQuantity` guards.
//
// This endpoint concerns the Hostinger Ecommerce catalog ONLY. It has no relation
// to the CRM's `inventory` / `product_master_*` tables and must never read or
// write them.

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireEcommerceAdmin } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { updateEcommerceVariantInventory } from "@/lib/ecommerce/product-service";

export const dynamic = "force-dynamic";

const ParamsSchema = z.object({
    productId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "Invalid product id"),
});

const BodySchema = z
    .object({
        variantId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "Invalid variant id"),
        // Documented as integer min 0. The server rejects negatives too (422),
        // but failing here gives a better message than a vendor error.
        quantity: z.number().int().min(0).optional(),
        manageInventory: z.boolean().optional(),
        expectedQuantity: z.number().int().min(0).optional(),
    })
    .refine((v) => v.quantity !== undefined || v.manageInventory !== undefined, {
        message: "Provide at least one of quantity or manageInventory",
    })
    .refine((v) => v.manageInventory !== true || v.quantity !== undefined, {
        // Hostinger defaults inventory_quantity to 0, so switching tracking on
        // without a figure would publish the product as out of stock.
        message: "Turning stock tracking on requires an initial quantity",
    });

export const PATCH = withErrorHandler(
    async (req: NextRequest, ctx: { params: Promise<{ productId: string }> }) => {
        const user = await requireEcommerceAdmin();

        const { productId } = ParamsSchema.parse(await ctx.params);
        const body = BodySchema.parse(await req.json());

        const result = await updateEcommerceVariantInventory(productId, body, {
            id: user.id,
            role: user.role,
        });

        return successResponse(result);
    },
);

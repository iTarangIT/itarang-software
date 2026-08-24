// POST /api/ecommerce/products/:productId/variants   (Phase 8B)
//
// Creates one variant. This endpoint is the ONLY opportunity to set a SKU and the
// ONLY place option values can ever be assigned — both are immutable afterwards
// (verified: the batch endpoint 400s on `options` and silently ignores `sku`).
//
// `options` is strictly required by Hostinger: an omitted key and an empty array
// both return 422. That is also why a product with no options can never carry a
// SKU, and why no SKU field is offered for such products.
//
// Concerns the Hostinger catalogue ONLY — no CRM table is read or written.

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireEcommerceAdmin } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { createEcommerceVariant } from "@/lib/ecommerce/product-service";

export const dynamic = "force-dynamic";

const ParamsSchema = z.object({
    productId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "Invalid product id"),
});

const BodySchema = z
    .object({
        // 1…10 per the documented schema.
        options: z
            .object({
                name: z.string().trim().min(1).max(255),
                value: z.string().trim().min(1).max(255),
            })
            .array()
            .min(1, "A variant needs at least one option")
            .max(10),
        sku: z.string().trim().min(1).max(255).optional(),
        amountMinor: z.number().int().min(0).optional(),
        saleAmountMinor: z.number().int().min(0).optional(),
        currency: z.string().trim().length(3).optional(),
        quantity: z.number().int().min(0).optional(),
        manageInventory: z.boolean().optional(),
    })
    .refine(
        (v) =>
            v.saleAmountMinor === undefined ||
            v.amountMinor === undefined ||
            v.saleAmountMinor < v.amountMinor,
        { message: "The discount price must be lower than the price" },
    )
    .refine((v) => v.manageInventory !== true || v.quantity !== undefined, {
        // Hostinger defaults inventory_quantity to 0, so enabling tracking without
        // a figure would publish the variant as out of stock.
        message: "Turning stock tracking on requires an initial quantity",
    })
    .refine(
        (v) => new Set(v.options.map((o) => o.name.toLowerCase())).size === v.options.length,
        { message: "Each option can only appear once" },
    );

export const POST = withErrorHandler(
    async (req: NextRequest, ctx: { params: Promise<{ productId: string }> }) => {
        const user = await requireEcommerceAdmin();
        const { productId } = ParamsSchema.parse(await ctx.params);
        const body = BodySchema.parse(await req.json());

        const variant = await createEcommerceVariant(productId, body, {
            id: user.id,
            role: user.role,
        });

        return successResponse(variant, 201);
    },
);

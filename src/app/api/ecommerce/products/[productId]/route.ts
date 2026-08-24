// GET    /api/ecommerce/products/:productId
// PATCH  /api/ecommerce/products/:productId   (Phase 5 — name / status)
// DELETE /api/ecommerce/products/:productId   (Phase 7 — permanent removal)
//
// Read-only product detail from Hostinger, including its variants and media.
// The documented API has no single-product GET (it answers 405); the documented
// substitute is the `product_ids` filter on the list endpoint, which the
// reference describes as doubling as a single-product lookup.

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireEcommerceAdmin } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import {
    deleteEcommerceProduct,
    getEcommerceProductDetail,
    updateEcommerceProduct,
} from "@/lib/ecommerce/product-service";

export const dynamic = "force-dynamic";

// Hostinger ids look like `prod_01M07WD4XP42SYQ1E1C1FTXYSM`. Validated loosely
// rather than by exact prefix so a future id format doesn't 400 here, but
// tightly enough to keep junk out of the outbound query.
const ParamsSchema = z.object({
    productId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "Invalid product id"),
});

export const GET = withErrorHandler(
    async (_req: NextRequest, ctx: { params: Promise<{ productId: string }> }) => {
        await requireEcommerceAdmin();

        const { productId } = ParamsSchema.parse(await ctx.params);
        const product = await getEcommerceProductDetail(productId);

        return successResponse(product);
    },
);

/**
 * `description` is deliberately NOT accepted here.
 *
 * The documented API can write a description but exposes no way to read one, so
 * an edit form would load blank and this route would overwrite the live text
 * with empty — silent data loss on a field nobody can see. Descriptions are set
 * at create time, or edited in the Hostinger dashboard.
 *
 * Note the API accepts only three statuses here, while the list filter can
 * return five (`proposed`, `rejected` are read-only states we cannot set).
 */
const UpdateSchema = z
    .object({
        name: z.string().trim().min(1).max(255).optional(),
        status: z.enum(["draft", "published", "archived"]).optional(),
    })
    .refine((v) => v.name !== undefined || v.status !== undefined, {
        message: "Provide at least one of name or status",
    });

export const PATCH = withErrorHandler(
    async (req: NextRequest, ctx: { params: Promise<{ productId: string }> }) => {
        const user = await requireEcommerceAdmin();

        const { productId } = ParamsSchema.parse(await ctx.params);
        const fields = UpdateSchema.parse(await req.json());

        await updateEcommerceProduct(productId, fields, { id: user.id, role: user.role });

        return successResponse({ productId, ...fields });
    },
);

/**
 * DELETE — permanent removal. Irreversible from the CRM.
 *
 * The service reads the product back afterwards, because a 200 does not prove it
 * is gone: Hostinger archives a subscription product with active subscribers
 * instead of deleting it. The response reports what actually happened
 * (`removed`), not what was requested.
 */
export const DELETE = withErrorHandler(
    async (_req: NextRequest, ctx: { params: Promise<{ productId: string }> }) => {
        const user = await requireEcommerceAdmin();

        const { productId } = ParamsSchema.parse(await ctx.params);
        const result = await deleteEcommerceProduct(productId, { id: user.id, role: user.role });

        return successResponse(result);
    },
);

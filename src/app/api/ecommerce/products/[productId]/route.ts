// GET /api/ecommerce/products/:productId
//
// Read-only product detail from Hostinger, including its embedded variants.
// Variants are NOT a separate Hostinger resource — they arrive on the product.

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireEcommerceAdmin } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { getEcommerceProductDetail } from "@/lib/ecommerce/product-service";

export const dynamic = "force-dynamic";

// Hostinger ids look like `prod_01M07WD4XP42SYQ1E1C1FTXYSM`. Validated loosely
// rather than by exact prefix so a future id format doesn't 400 here, but
// tightly enough to keep junk out of the outbound URL.
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

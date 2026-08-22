// GET /api/ecommerce/products?limit=&offset=
//
// Read-only proxy over the Hostinger Ecommerce catalog. Hostinger is the source
// of truth — nothing is cached or persisted in the CRM.
//
// This is a SEPARATE catalog from the CRM's physical `products` /
// `product_master_*` system. It shares no table, service, or route with it.

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireEcommerceAdmin } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { getEcommerceProductList } from "@/lib/ecommerce/product-service";
import { MAX_PAGE_SIZE } from "@/lib/hostinger/products";

export const dynamic = "force-dynamic";

const QuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(25),
    offset: z.coerce.number().int().min(0).default(0),
});

export const GET = withErrorHandler(async (req: NextRequest) => {
    // middleware.ts short-circuits /api/* before authorization, so this guard is
    // the only thing standing between this route and the public internet.
    await requireEcommerceAdmin();

    const url = new URL(req.url);
    const parsed = QuerySchema.parse({
        limit: url.searchParams.get("limit") ?? undefined,
        offset: url.searchParams.get("offset") ?? undefined,
    });

    const result = await getEcommerceProductList(parsed);

    return successResponse(result);
});

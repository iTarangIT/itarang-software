// GET /api/ecommerce/products?page=&q=&status=
//
// Read-only proxy over the Hostinger Ecommerce catalog (documented API v1).
// Hostinger is the source of truth — nothing is cached or persisted in the CRM.
//
// This is a SEPARATE catalog from the CRM's physical `products` /
// `product_master_*` system. It shares no table, service, or route with it.

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireEcommerceAdmin } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { getEcommerceProductList } from "@/lib/ecommerce/product-service";
import { HOSTINGER_PRODUCT_STATUSES } from "@/lib/hostinger/types";

export const dynamic = "force-dynamic";

// Page size is fixed by Hostinger at 50 and has no override, so there is no
// `limit` parameter to accept — the page number is the only paging control.
const QuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    q: z.string().trim().min(1).max(120).optional(),
    status: z.enum(HOSTINGER_PRODUCT_STATUSES).array().optional(),
});

export const GET = withErrorHandler(async (req: NextRequest) => {
    // middleware.ts short-circuits /api/* before authorization, so this guard is
    // the only thing standing between this route and the public internet.
    await requireEcommerceAdmin();

    const url = new URL(req.url);
    const statuses = url.searchParams.getAll("status");
    const parsed = QuerySchema.parse({
        page: url.searchParams.get("page") ?? undefined,
        q: url.searchParams.get("q") ?? undefined,
        status: statuses.length ? statuses : undefined,
    });

    const result = await getEcommerceProductList(parsed);

    return successResponse(result);
});

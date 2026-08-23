// GET  /api/ecommerce/products?page=&q=&status=
// POST /api/ecommerce/products   (Phase 5 — create)
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
import { createEcommerceProduct, getEcommerceProductList } from "@/lib/ecommerce/product-service";
import { dedupClaim } from "@/lib/queue/safeRedis";
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

// Mirrors the documented CreatePhysicalProductRequest / CreateDigitalProductRequest
// limits exactly. `price` is an integer in the smallest currency unit — the client
// converts rupees to paise, and this re-validates rather than trusting it.
const CreateSchema = z.object({
    kind: z.enum(["physical", "digital"]).default("physical"),
    name: z.string().trim().min(1).max(255),
    priceMinor: z.number().int().min(1),
    currency: z.string().trim().length(3).optional(),
    description: z.string().max(5000).optional(),
    downloadUrl: z.string().url().max(2048).optional(),
    publish: z.boolean().default(true),
});

export const POST = withErrorHandler(async (req: NextRequest) => {
    const user = await requireEcommerceAdmin();
    const input = CreateSchema.parse(await req.json());

    // Creates are not idempotent at Hostinger, and a double-submit would leave two
    // products with no way to tell which was intended. Keyed on actor + payload +
    // day; degrades to in-process dedup when Redis is down rather than blocking.
    const claim = await dedupClaim(
        `ecom:create:${user.id}:${input.name}:${input.priceMinor}:${new Date().toISOString().slice(0, 10)}`,
        60 * 60 * 25,
        "ecommerce-product-create",
    );
    if (!claim.claimed) {
        const err = new Error(
            "An identical product creation was just submitted. Refresh the list and check before trying again.",
        ) as Error & { status?: number };
        err.status = 409;
        throw err;
    }

    const result = await createEcommerceProduct(input, { id: user.id, role: user.role });

    return successResponse(result, 201);
});

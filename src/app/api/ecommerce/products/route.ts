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
//
// The fields below `publish` are NOT part of those requests — Hostinger discards
// every extra key there (verified). They are applied afterwards, against the
// variant, by applyCreationExtras in the service. Weight is deliberately absent:
// it appears nowhere in Hostinger's API, so there is nothing to send it to.
const CreateSchema = z
    .object({
        kind: z.enum(["physical", "digital"]).default("physical"),
        name: z.string().trim().min(1).max(255),
        priceMinor: z.number().int().min(1),
        currency: z.string().trim().length(3).optional(),
        description: z.string().max(5000).optional(),
        downloadUrl: z.string().url().max(2048).optional(),
        publish: z.boolean().default(true),

        saleAmountMinor: z.number().int().min(0).optional(),
        sku: z.string().trim().min(1).max(255).optional(),
        // 1…10 per the documented CreateVariantRequest. A real, operator-supplied
        // attribute — never a placeholder invented to unlock the SKU field.
        options: z
            .object({
                name: z.string().trim().min(1).max(255),
                value: z.string().trim().min(1).max(255),
            })
            .array()
            .min(1)
            .max(10)
            .optional(),
        trackQuantity: z.boolean().optional(),
        quantity: z.number().int().min(0).optional(),
    })
    .refine((v) => v.saleAmountMinor === undefined || v.saleAmountMinor < v.priceMinor, {
        // A "discount" at or above list price would publish to the storefront as
        // one that costs more.
        message: "The discount price must be lower than the price",
    })
    .refine((v) => v.trackQuantity !== true || v.quantity !== undefined, {
        // Hostinger defaults inventory_quantity to 0, so tracking without a figure
        // would publish the product as out of stock. Same rule as the inventory route.
        message: "Turning stock tracking on requires an initial quantity",
    })
    .refine((v) => v.sku === undefined || !!v.options?.length, {
        // Hostinger accepts a SKU only on variant creation, which requires an
        // option. Saying so beats echoing the vendor's 422 — and the CRM must not
        // fabricate an option to work around it.
        message:
            "A SKU can only be set on a variant with an option. Add a real option (for example Capacity: 150Ah) or leave the SKU empty and set it in the Hostinger dashboard.",
    })
    .refine(
        (v) =>
            !v.options ||
            new Set(v.options.map((o) => o.name.toLowerCase())).size === v.options.length,
        { message: "Each option can only appear once" },
    );

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

    // `trackQuantity` is the form's word for Hostinger's `manage_inventory`. When
    // it is off, no stock call is made at all: false IS Hostinger's default, and a
    // quantity on an untracked variant means nothing.
    const { trackQuantity, quantity, ...rest } = input;
    const result = await createEcommerceProduct(
        { ...rest, ...(trackQuantity ? { manageInventory: true, quantity } : {}) },
        { id: user.id, role: user.role },
    );

    return successResponse(result, 201);
});

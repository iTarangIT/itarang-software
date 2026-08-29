// POST /api/ecommerce/products/:productId/images   (Phase 8A)
//
// Adds product media. Two ways in:
//   · multipart/form-data with `file`  — the browser uploads to US, and this
//     route forwards the bytes to Hostinger's signed storage URL server-side.
//     Proxying avoids depending on the storage host's CORS policy accepting our
//     origin, and keeps the Hostinger token off the client entirely.
//   · JSON with `imageUrl`             — Hostinger fetches an already-public image.
//
// NOTE: the documented API has no delete-image or reorder-image endpoint, so the
// CRM can add media but not remove or reorder it. Do not add such a route — it
// does not exist upstream.

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireEcommerceAdmin } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { uploadEcommerceProductImage } from "@/lib/ecommerce/product-service";
import { HOSTINGER_IMAGE_MAX_BYTES } from "@/lib/hostinger/types";

export const dynamic = "force-dynamic";

// A 15MB body has to fit through this route, so the default parse limits matter.
export const maxDuration = 120;

const ParamsSchema = z.object({
    productId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "Invalid product id"),
});

const UrlBodySchema = z.object({
    imageUrl: z.string().url().max(2048),
    isThumbnail: z.boolean().optional(),
});

export const POST = withErrorHandler(
    async (req: NextRequest, ctx: { params: Promise<{ productId: string }> }) => {
        const user = await requireEcommerceAdmin();
        const { productId } = ParamsSchema.parse(await ctx.params);
        const actor = { id: user.id, role: user.role };

        const contentType = req.headers.get("content-type") ?? "";

        if (contentType.includes("multipart/form-data")) {
            const form = await req.formData();
            const file = form.get("file");
            if (!(file instanceof File)) {
                const err = new Error("No file was provided") as Error & { status?: number };
                err.status = 422;
                throw err;
            }
            // Cheap guard before buffering the whole thing into memory.
            if (file.size > HOSTINGER_IMAGE_MAX_BYTES) {
                const err = new Error(
                    `Image is too large — the maximum is ${HOSTINGER_IMAGE_MAX_BYTES / (1024 * 1024)} MB.`,
                ) as Error & { status?: number };
                err.status = 422;
                throw err;
            }

            await uploadEcommerceProductImage(
                productId,
                {
                    file: {
                        blob: file,
                        filename: file.name || "image",
                        mimeType: file.type,
                        size: file.size,
                    },
                    isThumbnail: form.get("isThumbnail") === "true" ? true : undefined,
                },
                actor,
            );
            return successResponse({ productId, via: "file" }, 201);
        }

        const body = UrlBodySchema.parse(await req.json());
        await uploadEcommerceProductImage(
            productId,
            { imageUrl: body.imageUrl, isThumbnail: body.isThumbnail },
            actor,
        );
        return successResponse({ productId, via: "url" }, 201);
    },
);

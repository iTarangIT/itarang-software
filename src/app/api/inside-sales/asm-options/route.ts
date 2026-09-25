// GET /api/inside-sales/asm-options?state=...&city=...&include_out_of_territory=true
// Drives the Transfer-to-ASM dropdown (BRD §0.8).
// Returns ASMs whose territory matches the dealer's state/city, plus an
// "in_territory" flag so the UI can label out-of-territory rows. The query lives
// in lib/inside-sales/asmOptions.ts, shared with the WhatsApp Assistant.

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { listAsmOptions } from "@/lib/inside-sales/asmOptions";

const READ_ROLES = [
    "inside_sales_rep",
    "admin",
    "ceo",
    "sales_manager",
    "sales_head",
    "business_head",
    "partner",
];

const QuerySchema = z.object({
    state: z.string().trim().min(1).max(100).optional(),
    city: z.string().trim().min(1).max(100).optional(),
    include_out_of_territory: z.coerce.boolean().default(false),
});

export const GET = withErrorHandler(async (req: NextRequest) => {
    await requireRole(READ_ROLES);
    const url = new URL(req.url);
    const parsed = QuerySchema.parse({
        state: url.searchParams.get("state") ?? undefined,
        city: url.searchParams.get("city") ?? undefined,
        include_out_of_territory: url.searchParams.get("include_out_of_territory") ?? undefined,
    });

    return successResponse(
        await listAsmOptions({
            state: parsed.state,
            city: parsed.city,
            includeOutOfTerritory: parsed.include_out_of_territory,
        }),
    );
});

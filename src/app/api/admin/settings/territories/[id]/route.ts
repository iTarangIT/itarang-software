// PATCH / DELETE /api/admin/settings/territories/[id] — edit or remove an ASM
// territory mapping (BRD §0.8).

import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import {
    errorResponse,
    successResponse,
    withErrorHandler,
} from "@/lib/api-utils";
import { canonicalTerritoryPlace } from "@/lib/ai-dialer/territoryRouting";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const BodySchema = z.object({
    state: z.string().trim().min(2).max(100),
    city: z.string().trim().min(1).max(100).optional().nullable(),
    active_from: z.string().regex(DATE).optional().nullable(),
    active_to: z.string().regex(DATE).optional().nullable(),
});

export const PATCH = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        await requireRole(["admin", "sales_head"]);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Territory id required.", 400);
        const b = BodySchema.parse(await req.json());
        // E-367 — same canonical place as POST (territories drive lead routing).
        const place = await canonicalTerritoryPlace({ state: b.state, city: b.city ?? null });
        if (place.unknownState) {
            return errorResponse(`"${b.state}" is not a state we know. Check the spelling.`, 400);
        }

        const res = await db.execute(sql`
            UPDATE asm_territories SET
                state = ${place.state},
                city = ${place.city},
                active_from = ${b.active_from ?? null},
                active_to = ${b.active_to ?? null},
                updated_at = NOW()
            WHERE territory_id = ${id}
            RETURNING territory_id
        `);
        if (res.length === 0) return errorResponse("Territory not found.", 404);

        return successResponse({ ok: true });
    },
);

export const DELETE = withErrorHandler(
    async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
        await requireRole(["admin", "sales_head"]);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Territory id required.", 400);

        const res = await db.execute(sql`
            DELETE FROM asm_territories WHERE territory_id = ${id}
            RETURNING territory_id
        `);
        if (res.length === 0) return errorResponse("Territory not found.", 404);

        return successResponse({ ok: true });
    },
);

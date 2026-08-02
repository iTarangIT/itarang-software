// PATCH /api/admin/settings/holidays/[id] — toggle a holiday's active flag
// (BRD §0.1 — soft delete via is_active).

import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import {
    errorResponse,
    successResponse,
    withErrorHandler,
} from "@/lib/api-utils";

import { holidayCalendar } from "@/lib/db/schema";

const BodySchema = z.object({ is_active: z.boolean() });

export const PATCH = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        await requireRole(["admin", "sales_head"]);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Holiday id required.", 400);
        const b = BodySchema.parse(await req.json());

        const res = await db.execute(sql`
            UPDATE ${holidayCalendar}
            SET is_active = ${b.is_active}, updated_at = NOW()
            WHERE holiday_id = ${id}
            RETURNING holiday_id
        `);
        if (res.length === 0) return errorResponse("Holiday not found.", 404);

        return successResponse({ ok: true });
    },
);

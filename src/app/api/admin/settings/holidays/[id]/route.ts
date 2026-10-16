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
import { forgetHolidays, logHolidayChange } from "@/lib/calendar/holidays";

const BodySchema = z.object({ is_active: z.boolean() });

export const PATCH = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(["admin", "sales_head"]);
        const { id } = await ctx.params;
        if (!id) return errorResponse("Holiday id required.", 400);
        const b = BodySchema.parse(await req.json());

        const res = (await db.execute(sql`
            UPDATE holiday_calendar h
            SET is_active = ${b.is_active}, updated_at = NOW()
            FROM (SELECT holiday_id, is_active IS NOT FALSE AS was_active FROM holiday_calendar WHERE holiday_id = ${id}) prev
            WHERE h.holiday_id = prev.holiday_id
            RETURNING h.holiday_id, h.holiday_date::text AS holiday_date, h.holiday_name, prev.was_active
        `)) as unknown as Array<{ holiday_date: string; holiday_name: string; was_active: boolean }>;
        if (res.length === 0) return errorResponse("Holiday not found.", 404);
        forgetHolidays();
        // Logged (E-350) only when the state really changed.
        if (res[0].was_active !== b.is_active) {
            await logHolidayChange({
                date: res[0].holiday_date,
                action: b.is_active ? "add" : "remove",
                name: res[0].holiday_name,
                by: user.id,
            });
        }

        return successResponse({ ok: true });
    },
);

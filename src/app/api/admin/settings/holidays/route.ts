// POST /api/admin/settings/holidays — add a working-day-calendar holiday
// (BRD §0.1). Idempotent on holiday_date (unique) — re-adding reactivates it.

import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";

const BodySchema = z.object({
    holiday_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
    holiday_name: z.string().trim().min(2).max(200),
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(["admin", "sales_head"]);
    const b = BodySchema.parse(await req.json());

    await db.execute(sql`
        INSERT INTO holiday_calendar (holiday_date, holiday_name, is_active, created_by)
        VALUES (${b.holiday_date}, ${b.holiday_name}, TRUE, ${user.id})
        ON CONFLICT (holiday_date) DO UPDATE SET
            holiday_name = EXCLUDED.holiday_name,
            is_active = TRUE,
            updated_at = NOW()
    `);

    return successResponse({ ok: true });
});

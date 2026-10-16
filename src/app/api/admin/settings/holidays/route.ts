// GET  /api/admin/settings/holidays — the office calendar and its change log
//      (E-343). Admin, Sales Head (edit) and the CEO (reads, via Time limits).
// POST /api/admin/settings/holidays — add a working-day-calendar holiday
// (BRD §0.1). Idempotent on holiday_date (unique) — re-adding reactivates it.

import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { forgetHolidays, holidayLog, logHolidayChange } from "@/lib/calendar/holidays";

const BodySchema = z.object({
    holiday_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
    holiday_name: z.string().trim().min(2).max(200),
});

const EDITOR_ROLES = ["admin", "sales_head"];

export const GET = withErrorHandler(async () => {
    const user = await requireRole([...EDITOR_ROLES, "ceo"]);
    const [holidays, log] = await Promise.all([
        db.execute(sql`
            SELECT holiday_id, holiday_date::text AS holiday_date, holiday_name, is_active
              FROM holiday_calendar ORDER BY holiday_date DESC LIMIT 200`),
        holidayLog(),
    ]);
    return successResponse({ holidays, log, can_edit: EDITOR_ROLES.includes(user.role) });
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(EDITOR_ROLES);
    const b = BodySchema.parse(await req.json());

    // Logged (E-343): a new or re-activated date is an "add", a new name on an
    // active date is a "rename". The clocks read the log, so a holiday added
    // today never moves a clock that had already stopped.
    const before = (await db.execute(sql`
        SELECT is_active IS NOT FALSE AS active, holiday_name FROM holiday_calendar WHERE holiday_date = ${b.holiday_date}
    `)) as unknown as Array<{ active: boolean; holiday_name: string }>;
    const prev = before[0];

    await db.execute(sql`
        INSERT INTO holiday_calendar (holiday_date, holiday_name, is_active, created_by)
        VALUES (${b.holiday_date}, ${b.holiday_name}, TRUE, ${user.id})
        ON CONFLICT (holiday_date) DO UPDATE SET
            holiday_name = EXCLUDED.holiday_name,
            is_active = TRUE,
            updated_at = NOW()
    `);
    forgetHolidays();
    if (!prev || !prev.active) {
        await logHolidayChange({ date: b.holiday_date, action: "add", name: b.holiday_name, by: user.id });
    } else if (prev.holiday_name !== b.holiday_name) {
        await logHolidayChange({ date: b.holiday_date, action: "rename", name: b.holiday_name, by: user.id });
    }

    return successResponse({ ok: true });
});

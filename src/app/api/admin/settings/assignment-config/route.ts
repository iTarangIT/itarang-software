// PUT /api/admin/settings/assignment-config — update the singleton assignment
// config (BRD §0.2, §0.1): AI intent threshold + working-hours window.

import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const BodySchema = z.object({
    intent_score_threshold: z.coerce.number().int().min(0).max(100),
    working_hours_start: z.string().regex(HHMM, "Use HH:MM"),
    working_hours_end: z.string().regex(HHMM, "Use HH:MM"),
    working_days: z
        .array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]))
        .min(1),
});

export const PUT = withErrorHandler(async (req: Request) => {
    const user = await requireRole(["admin", "sales_head"]);
    const b = BodySchema.parse(await req.json());
    const days = JSON.stringify(b.working_days);

    const existing = await db.execute<{ config_id: string }>(sql`
        SELECT config_id FROM assignment_config ORDER BY created_at ASC LIMIT 1
    `);

    if (existing[0]) {
        await db.execute(sql`
            UPDATE assignment_config SET
                intent_score_threshold = ${b.intent_score_threshold},
                working_hours_start = ${b.working_hours_start},
                working_hours_end = ${b.working_hours_end},
                working_days = ${days}::jsonb,
                updated_by = ${user.id},
                updated_at = NOW()
            WHERE config_id = ${existing[0].config_id}
        `);
    } else {
        await db.execute(sql`
            INSERT INTO assignment_config
                (intent_score_threshold, working_hours_start, working_hours_end,
                 working_days, updated_by)
            VALUES (${b.intent_score_threshold}, ${b.working_hours_start},
                ${b.working_hours_end}, ${days}::jsonb, ${user.id})
        `);
    }

    return successResponse({ ok: true });
});

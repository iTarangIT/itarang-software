// PUT /api/admin/settings/assignment-config — update the singleton assignment
// config (BRD §0.2, §0.1): AI intent threshold + working-hours window.
//
// ID 85 (30 Oct): a change of the hours or days needs a reason and is logged
// for the CEO (saveCallingHours, src/lib/ai-dialer/callingHoursLog.ts); a
// threshold-only change needs none.

import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { saveCallingHours } from "@/lib/ai-dialer/callingHoursLog";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const BodySchema = z.object({
    intent_score_threshold: z.coerce.number().int().min(0).max(100),
    working_hours_start: z.string().regex(HHMM, "Use HH:MM"),
    working_hours_end: z.string().regex(HHMM, "Use HH:MM"),
    working_days: z
        .array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]))
        .min(1),
    reason: z.string().max(500).optional(),
});

export const PUT = withErrorHandler(async (req: Request) => {
    const user = await requireRole(["admin", "sales_head"]);
    const b = BodySchema.parse(await req.json());
    const { logged } = await saveCallingHours({
        start: b.working_hours_start,
        end: b.working_hours_end,
        days: b.working_days,
        intentScoreThreshold: b.intent_score_threshold,
        reason: b.reason ?? null,
        actorId: user.id,
        source: "assignment_config",
    });
    return successResponse({ ok: true, logged });
});

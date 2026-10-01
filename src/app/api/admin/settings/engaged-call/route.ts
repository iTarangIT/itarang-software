/**
 * GET / PUT the engaged-call rule (tracker ID 59; reporting spec M06).
 *
 * What an "engaged call" is, for every report at once — the daily Sales email,
 * the Sales dashboard, the CEO control tower, the Admin KPI, the exports:
 *   min_seconds       connected and at least this many measured seconds
 *   duration_source   "neodove" = only NeoDove's recorded duration counts;
 *                     "reported" = a duration a rep typed counts too
 *
 * Stored under `engaged_call_rule` in app_settings (src/lib/reports/
 * engagedCallRule.ts). The reports read the row inline, so a save takes effect
 * on the next query — no deploy, no restart.
 *
 * The Sales Head owns the definition (the spec makes the threshold theirs);
 * admin and CEO can change it too.
 */

import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import {
    ENGAGED_CALL_MIN_SECONDS,
    ENGAGED_CALL_MIN_SECONDS_CEILING,
    ENGAGED_CALL_MIN_SECONDS_FLOOR,
} from "@/lib/lifecycle/touchpointTypes";
import { getEngagedCallRuleSettings, setEngagedCallRule } from "@/lib/reports/engagedCallRule";

export const dynamic = "force-dynamic";

const ROLES = ["admin", "ceo", "sales_head"];

const BodySchema = z.object({
    min_seconds: z.coerce
        .number()
        .int("Use a whole number of seconds.")
        .min(ENGAGED_CALL_MIN_SECONDS_FLOOR, `At least ${ENGAGED_CALL_MIN_SECONDS_FLOOR} seconds.`)
        .max(ENGAGED_CALL_MIN_SECONDS_CEILING, `At most ${ENGAGED_CALL_MIN_SECONDS_CEILING} seconds.`),
    duration_source: z.enum(["neodove", "reported"]),
});

const bounds = {
    floor: ENGAGED_CALL_MIN_SECONDS_FLOOR,
    ceiling: ENGAGED_CALL_MIN_SECONDS_CEILING,
    default_seconds: ENGAGED_CALL_MIN_SECONDS,
};

export const GET = withErrorHandler(async () => {
    await requireRole(ROLES);
    return successResponse({ settings: await getEngagedCallRuleSettings(), bounds, can_edit: true });
});

export const PUT = withErrorHandler(async (req: Request) => {
    const user = await requireRole(ROLES);
    const body = BodySchema.parse(await req.json());
    const settings = await setEngagedCallRule(body, user.id);
    return successResponse({ settings, bounds, can_edit: true });
});

// /api/admin/targets — the sales target register (E-303, review R-17).
//
//   GET  ?month=YYYY-MM          register + actual vs target, working-day
//                                context, the people who can be given targets,
//                                and what the caller may do
//   POST { action, ... }         add_person | add_metric | remove | update |
//                                set_actual | send_for_review (= submit) |
//                                send_to_member (= approve_push)
//
// Per-action permissions live in src/lib/targets/service.ts (CEO creates and
// sends to the Sales Head; CEO / Sales Head edit and add metrics; Sales Head
// sends to the member) and are enforced there, not just here.

import { sql } from "drizzle-orm";
import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import {
    addMetric,
    addPersonToMonth,
    listTargets,
    removeTarget,
    sendForReview,
    sendToMember,
    setManualActual,
    TARGET_ADD_PERSON_ROLES,
    TARGET_ADDON_ROLES,
    TARGET_APPROVER_ROLES,
    TARGET_CEO_ROLES,
    TARGET_METRIC_ROLES,
    TARGET_SALES_HEAD_ROLES,
    TARGET_VIEW_ROLES,
    TargetError,
    updateTarget,
    workingDayContext,
} from "@/lib/targets/service";

export const dynamic = "force-dynamic";

const MONTH = /^\d{4}-\d{2}$/;

const BodySchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("add_person"), month: z.string().regex(MONTH), user_id: z.string().min(1).max(64) }),
    z.object({
        action: z.literal("update"),
        id: z.string().uuid(),
        ceo_target: z.number().optional(),
        sales_head_target: z.number().nullable().optional(),
        admin_addon: z.number().optional(),
    }),
    z.object({ action: z.enum(["submit", "send_for_review"]), ids: z.array(z.string().uuid()).max(500) }),
    z.object({ action: z.enum(["approve_push", "send_to_member"]), ids: z.array(z.string().uuid()).max(500) }),
    z.object({
        action: z.literal("add_metric"),
        month: z.string().regex(MONTH),
        user_id: z.string().min(1).max(64),
        metric: z.string().max(40).optional(),
        custom: z.object({ label: z.string().max(80), unit: z.string().max(20).nullish() }).optional(),
        target: z.number().optional(),
    }),
    z.object({ action: z.literal("remove"), id: z.string().uuid() }),
    z.object({ action: z.literal("set_actual"), id: z.string().uuid(), value: z.number().nullable() }),
]);

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireRole(TARGET_VIEW_ROLES);
    const m = new URL(req.url).searchParams.get("month") ?? "";
    const month = MONTH.test(m) ? m : new Date().toISOString().slice(0, 7);
    const [rows, context, people] = await Promise.all([
        listTargets({ month }),
        workingDayContext(month),
        db.execute(sql`
            SELECT id::text AS user_id, name, role FROM users
             WHERE is_active = TRUE AND LOWER(role) IN ('asm', 'inside_sales_rep')
             ORDER BY name NULLS LAST
        `),
    ]);
    const r = (user.role ?? "").toLowerCase();
    return successResponse({
        month,
        rows,
        context,
        people,
        can: {
            add_person: TARGET_ADD_PERSON_ROLES.includes(r),
            set_ceo_target: TARGET_CEO_ROLES.includes(r),
            // E-341 — the Sales Head's own number (empty = the CEO's goes).
            set_sales_head_target: TARGET_SALES_HEAD_ROLES.includes(r),
            set_addon: TARGET_ADDON_ROLES.includes(r),
            approve: TARGET_APPROVER_ROLES.includes(r),
            // Item 3: CEO / Sales Head add or remove metrics; CEO sends to review.
            edit_metrics: TARGET_METRIC_ROLES.includes(r),
            send_for_review: TARGET_ADD_PERSON_ROLES.includes(r),
            send_to_member: TARGET_APPROVER_ROLES.includes(r),
        },
    });
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(TARGET_VIEW_ROLES);
    const actor = { id: user.id, role: String(user.role ?? "") };
    const body = BodySchema.parse(await req.json());
    try {
        switch (body.action) {
            case "add_person":
                return successResponse(await addPersonToMonth(body.month, body.user_id, actor));
            case "update":
                await updateTarget(
                    body.id,
                    { ceo_target: body.ceo_target, sales_head_target: body.sales_head_target, admin_addon: body.admin_addon },
                    actor,
                );
                return successResponse({ ok: true });
            case "submit":
            case "send_for_review":
                return successResponse(await sendForReview(body.ids, actor));
            case "approve_push":
            case "send_to_member":
                return successResponse(await sendToMember(body.ids, actor));
            case "add_metric":
                return successResponse(
                    await addMetric(
                        { month: body.month, userId: body.user_id, metric: body.metric, custom: body.custom, target: body.target },
                        actor,
                    ),
                );
            case "remove":
                return successResponse(await removeTarget(body.id, actor));
            case "set_actual":
                return successResponse(await setManualActual(body.id, body.value, actor));
        }
    } catch (e) {
        if (e instanceof TargetError) return errorResponse(e.message, 400);
        throw e;
    }
});

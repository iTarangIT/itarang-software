// /api/admin/targets — the sales target register (E-303, review R-17).
//
//   GET  ?month=YYYY-MM          register + actual vs target, working-day
//                                context, the people who can be given targets,
//                                and what the caller may do
//   GET  ?awaiting=1             ID 189: "Targets waiting for your approval"
//                                (posted, not pushed yet) for the Sales dashboard
//   GET  ?history=<user>&month=  ID 189: every version of a person's targets
//   POST { action, ... }         add_person | add_metric | remove | update |
//                                set_actual | post (= send_for_review, submit) |
//                                send_to_member (= approve_push)
//
// Per-action permissions live in src/lib/targets/service.ts (ID 189: only the
// CEO adds people and metrics, posts, and removes his targets; the Sales Head /
// Admin add the stretch and push posted targets) and are enforced there, not
// just here. "remove" is soft: the row is kept with its history. The CEO's unposted
// drafts are left out of every answer to anyone but the CEO.

import { sql } from "drizzle-orm";
import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import {
    addMetric,
    addPersonToMonth,
    awaitingPush,
    listTargets,
    postTargets,
    removeTarget,
    sendToMember,
    setManualActual,
    TARGET_ADD_PERSON_ROLES,
    TARGET_APPROVER_ROLES,
    TARGET_CEO_ROLES,
    TARGET_METRIC_ROLES,
    TARGET_POST_ROLES,
    TARGET_PROGRESS_ROLES,
    TARGET_REMOVE_ROLES,
    TARGET_STRETCH_ROLES,
    TARGET_VIEW_ROLES,
    TargetError,
    targetHistory,
    targetViewerFor,
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
        stretch: z.number().optional(),
        stretch_note: z.string().max(1000).nullable().optional(),
        // Old clients: the add-on is the stretch; the E-342 number is refused by the service.
        admin_addon: z.number().optional(),
        sales_head_target: z.number().nullable().optional(),
    }),
    z.object({ action: z.enum(["post", "submit", "send_for_review"]), ids: z.array(z.string().uuid()).max(500) }),
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
    const sp = new URL(req.url).searchParams;
    const r = (user.role ?? "").toLowerCase();
    const viewer = targetViewerFor(r);
    if (sp.get("awaiting")) return successResponse(await awaitingPush());
    const m = sp.get("month") ?? "";
    const month = MONTH.test(m) ? m : new Date().toISOString().slice(0, 7);
    const historyOf = sp.get("history");
    if (historyOf) return successResponse({ month, rows: await targetHistory({ month, userId: historyOf, viewer }) });
    const [rows, context, people] = await Promise.all([
        listTargets({ month, viewer }),
        workingDayContext(month),
        db.execute(sql`
            SELECT id::text AS user_id, name, role FROM users
             WHERE is_active = TRUE AND LOWER(role) IN ('asm', 'inside_sales_rep')
             ORDER BY name NULLS LAST
        `),
    ]);
    return successResponse({
        month,
        rows,
        context,
        people,
        can: {
            add_person: TARGET_ADD_PERSON_ROLES.includes(r),
            set_ceo_target: TARGET_CEO_ROLES.includes(r),
            // ID 189 — the Sales Head's add-only stretch (Admin too).
            set_stretch: TARGET_STRETCH_ROLES.includes(r),
            approve: TARGET_APPROVER_ROLES.includes(r),
            // ID 189 (16 Oct) — add a metric: the CEO (lands as his draft) and
            // the Sales Head for an ISR / ASM (lands in his queue, ready to push).
            edit_metrics: TARGET_METRIC_ROLES.includes(r),
            // Remove: the CEO any target; Sales Head / Admin only a row with
            // `ceo_owned` false (the service re-checks).
            remove_any: TARGET_CEO_ROLES.includes(r),
            remove_own: TARGET_REMOVE_ROLES.includes(r),
            // A custom metric's progress, typed in for someone else.
            enter_progress: TARGET_PROGRESS_ROLES.includes(r),
            // ID 189 — "Post to Sales Head" is the CEO's alone.
            post: TARGET_POST_ROLES.includes(r),
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
                    {
                        ceo_target: body.ceo_target,
                        stretch: body.stretch,
                        stretch_note: body.stretch_note,
                        admin_addon: body.admin_addon,
                        sales_head_target: body.sales_head_target,
                    },
                    actor,
                );
                return successResponse({ ok: true });
            case "post":
            case "submit":
            case "send_for_review":
                return successResponse(await postTargets(body.ids, actor));
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

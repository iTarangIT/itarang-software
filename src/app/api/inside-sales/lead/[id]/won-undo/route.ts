// /api/inside-sales/lead/[id]/won-undo — Undo Mark Won (tracker ID 134).
//
// GET   → { available, eligible, reason?, restore_status?, pending, can_request, can_approve }
// POST  { action: "request", reason }          the lead's owner asks
//       { action: "approve" }                  Sales Head / admin approves the waiting request
//       { action: "reject", note }             … or refuses it, saying why
//       { action: "undo", reason }             Sales Head / admin undoes directly
//
// Rules and writes live in src/lib/leads/wonUndo.ts.

import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { LEAD_WORKSPACE_ROLES } from "@/lib/leads/access";
import { assertOwner, ForbiddenLeadAccessError } from "@/lib/leads/ownership";
import {
    WON_UNDO_APPROVER_ROLES,
    decideWonUndo,
    getWonUndoState,
    requestWonUndo,
    undoWonDirect,
} from "@/lib/leads/wonUndo";

const isApprover = (role: string) => (WON_UNDO_APPROVER_ROLES as readonly string[]).includes(role);

const BodySchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("request"), reason: z.string().trim().min(5).max(2000) }),
    z.object({ action: z.literal("approve") }),
    z.object({ action: z.literal("reject"), note: z.string().trim().min(5).max(2000) }),
    z.object({ action: z.literal("undo"), reason: z.string().trim().min(5).max(2000) }),
]);

export const GET = withErrorHandler(
    async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole([...LEAD_WORKSPACE_ROLES]);
        const { id } = await ctx.params;
        const state = await getWonUndoState(id);
        let isOwner = false;
        try {
            await assertOwner(id, user.id);
            isOwner = true;
        } catch (e) {
            if (!(e instanceof ForbiddenLeadAccessError)) throw e;
        }
        return successResponse({
            available: state.available,
            eligible: state.verdict.ok,
            reason: state.verdict.ok ? null : state.verdict.reason,
            restore_status: state.verdict.ok ? state.verdict.restoreStatus : null,
            pending: state.pending,
            can_request: isOwner && !isApprover(user.role),
            can_approve: isApprover(user.role),
        });
    },
);

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole([...LEAD_WORKSPACE_ROLES]);
        const { id } = await ctx.params;
        const body = BodySchema.parse(await req.json());
        const actor = { id: user.id, name: user.name ?? "A rep" };

        if (body.action === "request") {
            try {
                await assertOwner(id, user.id);
            } catch (e) {
                if (e instanceof ForbiddenLeadAccessError) {
                    return errorResponse("Only the lead's owner can ask to undo its Mark Won.", 403);
                }
                throw e;
            }
            return successResponse(await requestWonUndo({ leadId: id, actor, reason: body.reason }));
        }

        if (!isApprover(user.role)) {
            return errorResponse("Only the Sales Head approves an undo of Mark Won.", 403);
        }
        if (body.action === "undo") {
            return successResponse(await undoWonDirect({ leadId: id, actor, reason: body.reason }));
        }
        return successResponse(
            await decideWonUndo({
                leadId: id,
                actor,
                approve: body.action === "approve",
                note: body.action === "reject" ? body.note : null,
            }),
        );
    },
);

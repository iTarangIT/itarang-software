// reassign_lead — hand a lead the user owns to another rep (BRD §0.3 Path C),
// with a reason of at least 20 characters. PROPOSES only. Candidates are active
// Inside Sales reps and ASMs other than the user — deliberately narrower than
// the reassign route (any active user id): the screen has no picker yet, and a
// name slip must not hand a lead to finance or admin. No match or several
// matches come back as a question. On Confirm, reassignLeadApplier runs
// reassignLead() (lib/leads/reassign.ts, the route's own writer) on the
// executor's transaction.

import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { REASSIGN_REASON_MIN, ReassignError, reassignLead as reassignLeadWrite } from "@/lib/leads/reassign";
import { isWorkedTouchpoint } from "@/lib/lifecycle/touchpointTypes";
import { createPending } from "../../actions";
import { ROLE_LABEL, type AssistantRole, type Preview, type ToolResult } from "../../types";
import { defineTool, LeadId, ownedLeadOr, type ToolFactory } from "../spec";
import { leadUrl } from "../leads";
import { ActionRejected, defineApplier } from "../../applierSpec";
import { notifyLeadsReassigned } from "@/lib/leads/newOwnerNotice";
import { matchPeople, nameList } from "./people";
import { handBackRefusal, isHandBack } from "@/lib/leads/asmHandBack";
import { statusBeforeTransfer } from "@/lib/leads/assignOwner";
import { statusLabel } from "../../format";

export const ReassignLeadPlan = z.object({
    lead_id: z.string().min(1),
    target_user_id: z.string().min(1),
    target_name: z.string(),
    target_role: z.string(),
    reason: z.string().min(REASSIGN_REASON_MIN),
});
export type ReassignLeadPlan = z.infer<typeof ReassignLeadPlan>;

const ask = (question: string): ToolResult => ({ kind: "question", question });

type Colleague = { id: string; name: string | null; role: AssistantRole };

/** Active ISRs and ASMs, the user excluded. */
async function colleagues(selfId: string): Promise<Colleague[]> {
    return db.execute<Colleague>(sql`
        SELECT id::text AS id, name, LOWER(role) AS role
          FROM users
         WHERE is_active = TRUE
           AND LOWER(role) IN ('inside_sales_rep', 'asm')
           AND id::text <> ${selfId}
         ORDER BY name
    `);
}

export const reassignLead: ToolFactory = () =>
    defineTool({
        name: "reassign_lead",
        kind: "write",
        description:
            "Propose reassigning a lead the user owns to another Inside Sales rep or ASM, by name. Needs a reason of at " +
            `least ${REASSIGN_REASON_MIN} characters in the user's own words — never pad it. The follow-up carries over. ` +
            "After this the lead belongs to that person. Nothing is saved until Confirm.",
        schema: z.object({
            lead_id: LeadId,
            to: z.string().trim().min(2).max(80).describe("The person's name (or user id) as the user gave it"),
            reason: z.string().trim().max(5000),
        }),
        run: async (ctx, input): Promise<ToolResult> => {
            const owned = await ownedLeadOr(ctx, input.lead_id);
            if (owned.result) return owned.result;
            const lead = owned.lead;

            const matches = matchPeople(await colleagues(ctx.user.id), input.to);
            if (matches.length === 0) {
                return ask(`I couldn't find an active Inside Sales rep or ASM called "${input.to}". Who should get it?`);
            }
            if (matches.length > 1) return ask(`Who do you mean: ${nameList(matches)}?`);
            const target = matches[0]!;
            const targetName = target.name?.trim() || target.id;

            // ID 121: say so now rather than after Confirm.
            const status = await db.execute<{ lead_status: string | null; pre_transfer_status: string | null }>(sql`
                SELECT lead_status, pre_transfer_status FROM dealer_leads WHERE id = ${lead.id} LIMIT 1
            `);
            const handBack = isHandBack(status[0]?.lead_status, target.role);
            if (handBack) {
                const refusal = await handBackRefusal(db, lead.id);
                if (refusal) return { kind: "declined", reason: refusal };
            }

            const reason = input.reason.trim();
            if (reason.length < REASSIGN_REASON_MIN) {
                return ask(`Why are you reassigning it to ${targetName}? I need a reason of at least ${REASSIGN_REASON_MIN} characters.`);
            }

            const plan: ReassignLeadPlan = {
                lead_id: lead.id,
                target_user_id: target.id,
                target_name: targetName,
                target_role: target.role,
                reason,
            };
            const lines: Preview["lines"] = [
                { label: "Owner", value: `you → ${targetName} (${ROLE_LABEL[target.role] ?? target.role})` },
            ];
            // ID 121: what reassignLead() does on a hand-back — the lead goes
            // back to its pre-transfer stage, the ASM is unlinked and the open
            // visits are cancelled (asmHandBack.releaseAsm).
            if (handBack) {
                const backTo = statusBeforeTransfer(status[0]?.pre_transfer_status ?? null);
                const open = await db.execute<{ n: number }>(sql`
                    SELECT count(*)::int AS n FROM lead_visits
                     WHERE dealer_lead_id = ${lead.id} AND visit_status IN ('scheduled', 'pending_scheduling')
                `);
                const n = Number(open[0]?.n ?? 0);
                lines.push({ label: "Status", value: `${statusLabel("Transferred_to_ASM")} → ${statusLabel(backTo)}` });
                lines.push({ label: "Field ASM", value: "unlinked" });
                if (n > 0) lines.push({ label: "Open visits", value: `${n} cancelled` });
            }
            lines.push({ label: "Reason", value: reason });
            const preview: Preview = {
                title: `Reassign ${lead.shop_name || lead.dealer_name || lead.id} → ${targetName}`,
                lines,
                // An ownership change is not work; nor is the hand-back's status restore (a correction).
                resets_idle_clock: isWorkedTouchpoint("ownership_transfer", handBack, handBack ? "correction" : null),
                warning: `After this the lead belongs to ${targetName} and is read-only for you.`,
                needs_second_confirm: false,
                crm_url: leadUrl(ctx.user, lead.id),
            };
            const { id } = await createPending({
                userId: ctx.user.id,
                tool: "reassign_lead",
                leadId: lead.id,
                leadVersion: lead.updated_at,
                plan,
                preview,
                before: { current_owner_id: lead.current_owner_id },
                sourceMessageId: ctx.messageId,
            });
            return { kind: "preview", action_id: id, preview };
        },
    });

export const reassignLeadApplier = defineApplier<ReassignLeadPlan>({
    schema: ReassignLeadPlan,
    apply: async ({ tx, user }, p) => {
        try {
            await reassignLeadWrite(
                { leadId: p.lead_id, actorId: user.id, targetUserId: p.target_user_id, reason: p.reason },
                { tx },
            );
        } catch (err) {
            // The person was deactivated (or removed) after the preview — or,
            // ID 121, the ASM booked a visit after it.
            if (err instanceof ReassignError) {
                // A booked visit carries the writer's sentence (who, which day).
                throw err.code === "visit_booked"
                    ? new ActionRejected("visit_booked", err.message)
                    : new ActionRejected("target_unavailable");
            }
            throw err;
        }
        return {
            new_owner_id: p.target_user_id,
            // The new owner's bell, once the reassignment has committed.
            afterCommit: async () => {
                await notifyLeadsReassigned({
                    leadIds: [p.lead_id],
                    targetUserId: p.target_user_id,
                    actorId: user.id,
                    reason: p.reason,
                });
            },
        };
    },
});

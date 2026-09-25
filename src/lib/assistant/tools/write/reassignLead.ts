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
import { matchPeople, nameList } from "./people";

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
            const preview: Preview = {
                title: `Reassign ${lead.shop_name || lead.dealer_name || lead.id} → ${targetName}`,
                lines: [
                    { label: "Owner", value: `you → ${targetName} (${ROLE_LABEL[target.role] ?? target.role})` },
                    { label: "Reason", value: reason },
                ],
                resets_idle_clock: isWorkedTouchpoint("ownership_transfer", false),
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
            // The person was deactivated (or removed) after the preview.
            if (err instanceof ReassignError) throw new ActionRejected("target_unavailable");
            throw err;
        }
        return { new_owner_id: p.target_user_id };
    },
});

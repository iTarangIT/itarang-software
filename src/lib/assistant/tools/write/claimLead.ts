// claim_lead — take one lead from the pool (BRD §9.2, UC-05). ISR: the global
// unassigned pool; ASM: unowned AND in their territory (the Territory Feed's
// "or unowned anywhere" is for reading, not claiming). A pool lead has no owner,
// so claim eligibility replaces the ownership check — here, and again on the
// locked row in the executor (assertClaimable).
//
// Input is a lead id OR the dealer's exact phone number(s) (ID 45: reps cannot
// browse the pool, so there is NO name search in it — "Sharma" must not list
// every unowned Sharma). A phone list ("98…, 97…") is matched on the last 10
// digits, inside the pool only; two matches come back as candidates — the tool
// never picks. On Confirm, claimLeadApplier runs claimLead() (the claim route's
// own writer) on the executor's transaction.

import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { claimLead as claimLeadWrite } from "@/lib/inside-sales/claimLead";
import { parseMobileList } from "@/lib/leads/claimScope";
import { claimPoolPredicate, findClaimState, scopeJoin } from "../../scope";
import { createPending } from "../../actions";
import { statusLabel } from "../../format";
import { MAX_TOOL_ROWS, type AssistantUser, type Preview, type ToolResult } from "../../types";
import { defineTool, LeadId, NOT_FOUND, WRITES_OFF, type ToolFactory } from "../spec";
import { leadUrl, toLeadSummary } from "../leads";
import { ActionRejected, defineApplier, type Tx } from "../../applierSpec";

export const ClaimLeadPlan = z.object({ lead_id: z.string().min(1) });
export type ClaimLeadPlan = z.infer<typeof ClaimLeadPlan>;

type PoolRow = {
    id: string;
    shop_name: string | null;
    dealer_name: string | null;
    city: string | null;
    lead_status: string | null;
    interest_level: string | null;
    updated_at: string | Date | null;
    total: number;
};

/** Pool leads matching an id or exact mobile numbers (last 10 digits) — at most MAX_TOOL_ROWS. */
async function findInPool(user: AssistantUser, by: { id: string } | { mobiles: string[] }): Promise<PoolRow[]> {
    const match =
        "id" in by
            ? sql`AND dl.id = ${by.id}`
            : sql`AND right(regexp_replace(dl.phone, '[^0-9]', '', 'g'), 10) IN (SELECT jsonb_array_elements_text(${JSON.stringify(by.mobiles)}::jsonb))`;
    return db.execute<PoolRow>(sql`
        SELECT dl.id, dl.shop_name, dl.dealer_name, dl.city, dl.lead_status, dl.interest_level, dl.updated_at,
               count(*) OVER ()::int AS total
          FROM dealer_leads dl
          ${scopeJoin(user)}
         WHERE ${claimPoolPredicate(user)} ${match}
         ORDER BY dl.created_at DESC, dl.id
         LIMIT ${MAX_TOOL_ROWS}
    `);
}

/**
 * Why a lead on the user's queue screens is not in their claim pool (anything
 * unseen stays NOT_FOUND). ID 45: findClaimState returns only booleans, so
 * this explains claimability without revealing the lead's details; the CRM
 * link is given only when the lead is in the READ scope.
 */
async function whyNotClaimable(user: AssistantUser, leadId: string): Promise<ToolResult> {
    const st = await findClaimState(user, leadId);
    if (!st) return NOT_FOUND;
    const crm_url = st.readable ? leadUrl(user, leadId.trim()) : null;
    if (st.owned) return { kind: "declined", reason: "You already own this lead.", crm_url };
    if (st.has_owner) return { kind: "declined", reason: "This lead already has an owner, so it can't be claimed.", crm_url };
    return { kind: "declined", reason: "This lead can't be claimed.", crm_url };
}

export const claimLead: ToolFactory = () =>
    defineTool({
        name: "claim_lead",
        kind: "write",
        description:
            "Propose claiming ONE unowned lead from the user's claim pool (any unowned, open lead; an ASM may claim outside their territory — it is flagged for the Sales Head). " +
            "Pass lead_id when you have it, otherwise the dealer's exact 10-digit mobile number (several comma-separated are allowed). " +
            "Names are NOT searched: the unowned pool cannot be browsed — ask the user for the number. " +
            "Nothing is saved until Confirm.",
        schema: z
            .object({
                lead_id: LeadId.optional(),
                phone: z
                    .string()
                    .trim()
                    .min(10)
                    .max(200)
                    .optional()
                    .describe("The dealer's exact mobile number(s), as the user wrote them; comma-separated for several"),
            })
            .refine((v) => !!v.lead_id || !!v.phone, { message: "lead_id or phone is required", path: ["phone"] }),
        run: async (ctx, input): Promise<ToolResult> => {
            if (!ctx.writesEnabled) return WRITES_OFF;
            let rows: PoolRow[];
            if (input.lead_id) {
                rows = await findInPool(ctx.user, { id: input.lead_id });
            } else {
                const { mobiles } = parseMobileList(input.phone!);
                if (mobiles.length === 0) {
                    return { kind: "question", question: "Which number? I need the dealer's exact 10-digit mobile number to find the lead in the pool." };
                }
                rows = await findInPool(ctx.user, { mobiles });
            }

            if (rows.length === 0) return input.lead_id ? whyNotClaimable(ctx.user, input.lead_id) : NOT_FOUND;
            if (rows.length > 1) {
                return {
                    kind: "candidates",
                    question: `${rows[0]!.total} leads in your claim pool match "${input.phone ?? input.lead_id}". Which one do you mean?`,
                    rows: rows.map((r) => toLeadSummary(r, ctx.user)),
                };
            }

            const lead = rows[0]!;
            const lines: Preview["lines"] = [
                { label: "Status", value: `${statusLabel(lead.lead_status ?? "New_Unassigned")} → Assigned Not Contacted` },
                { label: "Owner", value: "you" },
            ];
            if (ctx.user.role === "asm") lines.push({ label: "Field ASM", value: "you (visits go to your Today's Schedule)" });
            if (lead.city) lines.push({ label: "City", value: lead.city });
            const preview: Preview = {
                title: `Claim — ${lead.shop_name || lead.dealer_name || lead.id}`,
                lines,
                // A claim is not work on the lead (isWorkedTouchpoint): the idle clock starts from here.
                resets_idle_clock: false,
                warning: null,
                needs_second_confirm: false,
                crm_url: leadUrl(ctx.user, lead.id),
            };
            const { id } = await createPending({
                userId: ctx.user.id,
                tool: "claim_lead",
                leadId: lead.id,
                leadVersion: lead.updated_at ? new Date(lead.updated_at) : null,
                plan: { lead_id: lead.id } satisfies ClaimLeadPlan,
                preview,
                before: { current_owner_id: null, lead_status: lead.lead_status },
                sourceMessageId: ctx.messageId,
            });
            return { kind: "preview", action_id: id, preview };
        },
    });

/** Is the (locked) lead still in this user's pool? Runs on the executor's tx. */
async function assertClaimable(tx: Tx, leadId: string, user: AssistantUser): Promise<boolean> {
    const rows = await tx.execute<{ id: string }>(sql`
        SELECT dl.id FROM dealer_leads dl ${scopeJoin(user)}
         WHERE dl.id = ${leadId} AND ${claimPoolPredicate(user)}
         LIMIT 1
    `);
    return rows.length > 0;
}

export const claimLeadApplier = defineApplier<ClaimLeadPlan>({
    schema: ClaimLeadPlan,
    ownership: "claim",
    assertClaimable,
    apply: async ({ tx, user }, p) => {
        const out = await claimLeadWrite(p.lead_id, user.id, { tx, actorRole: user.role });
        // The pool re-check already ran on the locked row, so this is belt and braces.
        if (!out.ok) throw new ActionRejected("not_claimable");
        return {};
    },
});

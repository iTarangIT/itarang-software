// ID 137 — a rep asks the Assistant to add a dealer whose number is already in
// the CRM. Nothing is recorded straight away: the Assistant replies "Already in
// CRM, with <owner>. Did the dealer contact us again?" with Yes / No.
//   Yes — the Re-inquiry goes on the existing lead's timeline, and the owner
//         and the Sales Head are alerted (ID 81's notifyLeadReinquiry).
//   No, or no answer — the card is cancelled / expires: nothing is recorded,
//         nobody is alerted.
// No daily limit, same as a single add.
//
// Proposed only by create_lead (proposeReinquiry below). The tool is not in
// ROLE_TOOLS, so the model can never call it with a lead id of its choosing.

import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { notifyReinquiry, writeReinquiry } from "@/lib/leads/leadSource";
import { isWorkedTouchpoint } from "@/lib/lifecycle/touchpointTypes";
import { createPending } from "../../actions";
import { defineApplier } from "../../applierSpec";
import { findLeadInScope } from "../../scope";
import type { AssistantUser, Preview, ToolResult } from "../../types";
import { leadUrl, queueUrl } from "../leads";
import { defineTool, type ToolFactory } from "../spec";

export const RecordReinquiryPlan = z.object({
    lead_id: z.string().min(1),
    /** The name the rep gave the dealer this time — kept on the timeline line. */
    note: z.string().nullable(),
});
export type RecordReinquiryPlan = z.infer<typeof RecordReinquiryPlan>;

/** The Yes / No card create_lead returns instead of declining. */
export async function proposeReinquiry(
    ctx: { user: AssistantUser; messageId?: string | null },
    leadId: string,
    note: string | null,
    extraHint: string | null,
): Promise<ToolResult> {
    const rows = (await db.execute(sql`
        SELECT COALESCE(NULLIF(dl.shop_name, ''), NULLIF(dl.dealer_name, '')) AS dealer, o.name AS owner_name,
               dl.current_owner_id AS owner_id
          FROM dealer_leads dl
          LEFT JOIN users o ON o.id::text = dl.current_owner_id
         WHERE dl.id = ${leadId}
         LIMIT 1
    `)) as unknown as Array<{ dealer: string | null; owner_name: string | null; owner_id: string | null }>;
    // The rep's own lead: they are not "alerted", and the card doesn't name them to themselves.
    const mine = !!rows[0]?.owner_id && rows[0].owner_id === ctx.user.id;
    const owner = mine ? null : rows[0]?.owner_name?.trim() || (rows[0]?.owner_id ? "its owner" : null);
    // The dealer's name only when this rep may see the lead (Invariant 1).
    const visible = await findLeadInScope(ctx.user, leadId);

    const plan: RecordReinquiryPlan = { lead_id: leadId, note };
    const lines: Preview["lines"] = [];
    if (visible) lines.push({ label: "Lead", value: rows[0]?.dealer || leadId });
    lines.push({ label: "Yes", value: `records a Re-inquiry and alerts ${owner ?? "the Sales Head"}${owner ? " and the Sales Head" : ""}` });
    lines.push({ label: "No", value: "nothing is recorded" });
    if (extraHint) lines.push({ label: "Note", value: extraHint });
    const preview: Preview = {
        title: `Already in CRM, ${mine ? "it's your lead" : owner ? `with ${owner}` : "with no owner"}. Did the dealer contact us again?`,
        lines,
        resets_idle_clock: isWorkedTouchpoint("lead_reinquiry", false),
        warning: null,
        needs_second_confirm: false,
        crm_url: visible ? leadUrl(ctx.user, leadId) : queueUrl(ctx.user),
        answers: { confirm: "Yes", cancel: "No" },
    };
    const { id } = await createPending({
        userId: ctx.user.id,
        tool: "record_reinquiry",
        leadId,
        leadVersion: null,
        plan,
        preview,
        before: {},
        sourceMessageId: ctx.messageId ?? null,
    });
    return { kind: "preview", action_id: id, preview };
}

/** Registered for completeness; never offered to the model (see header). */
export const recordReinquiryTool: ToolFactory = () =>
    defineTool({
        name: "record_reinquiry",
        kind: "write",
        description: "Internal: proposed by create_lead when the dealer's number is already in the CRM.",
        schema: z.object({}),
        run: async (): Promise<ToolResult> => ({
            kind: "declined",
            reason: "Use create_lead with the dealer's number; it asks whether the dealer contacted us again.",
        }),
    });

export const recordReinquiryApplier = defineApplier<RecordReinquiryPlan>({
    schema: RecordReinquiryPlan,
    // A returning dealer is usually on someone else's lead — no owner check.
    ownership: "none",
    apply: async ({ tx, user }, p) => {
        const input = { leadId: p.lead_id, door: "whatsapp_assistant" as const, actorId: user.id, note: p.note };
        await writeReinquiry(input, { tx });
        // For the reply: the rep's own lead is not "told" to its owner.
        const owner = (await tx.execute(sql`
            SELECT current_owner_id FROM dealer_leads WHERE id = ${p.lead_id} LIMIT 1
        `)) as unknown as Array<{ current_owner_id: string | null }>;
        return {
            lead_id: p.lead_id,
            owner_is_actor: owner[0]?.current_owner_id === user.id,
            afterCommit: () => notifyReinquiry(input),
        };
    },
});

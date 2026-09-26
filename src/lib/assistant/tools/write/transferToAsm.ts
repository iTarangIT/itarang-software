// transfer_to_asm — hand a lead the ISR owns to a field ASM (BRD §0.8). ISR
// only, as on the screen. PROPOSES only: the ASM is resolved by name from the
// same list the Transfer modal shows (listAsmOptions, territory-flagged for the
// dealer's state/city); an out-of-territory ASM needs a reason, and no match or
// several matches come back as a question — the tool never picks. On Confirm,
// transferToAsmApplier runs transferLeadToAsm() — the route's own writer — on
// the executor's transaction.

import { z } from "zod";
import { listAsmOptions } from "@/lib/inside-sales/asmOptions";
import {
    TRANSFER_REASONS,
    VISIT_TYPES,
    transferLeadToAsm,
    type TransferReason,
    type VisitType,
} from "@/lib/leads/transferToAsm";
import { isWorkedTouchpoint } from "@/lib/lifecycle/touchpointTypes";
import { createPending } from "../../actions";
import { fmtDate, reasonLabel, statusLabel } from "../../format";
import type { Preview, ToolResult } from "../../types";
import { defineTool, LeadId, ownedLeadOr, type ToolFactory } from "../spec";
import { leadUrl } from "../leads";
import { defineApplier } from "../../applierSpec";
import { IsoDate, Remarks } from "./vocabSchemas";
import { futureDay } from "./when";
import { matchPeople, nameList } from "./people";

export const TransferToAsmPlan = z.object({
    lead_id: z.string().min(1),
    asm_id: z.string().min(1),
    asm_name: z.string(),
    reason: z.enum(TRANSFER_REASONS),
    visit_type: z.enum(VISIT_TYPES),
    suggested_visit_date: z.string().nullable(),
    dealer_preferred_time: z.string().nullable(),
    handoff_notes: z.string(),
    pending_items: z.array(z.string()).max(10),
    out_of_territory_reason: z.string().nullable(),
});
export type TransferToAsmPlan = z.infer<typeof TransferToAsmPlan>;

const ask = (question: string): ToolResult => ({ kind: "question", question });

export const transferToAsm: ToolFactory = () =>
    defineTool({
        name: "transfer_to_asm",
        kind: "write",
        description:
            "Propose handing a lead the user owns to a field ASM (Transfer to ASM). Pass the ASM's name as the user said it. " +
            "Needs a transfer reason and a visit type; a suggested visit date, the dealer's preferred time, handoff notes and " +
            "pending items are optional. After the transfer the lead belongs to the ASM. Nothing is saved until Confirm.",
        schema: z.object({
            lead_id: LeadId,
            asm: z.string().trim().min(2).max(80).describe("The ASM's name (or user id) as the user gave it"),
            reason: z.enum(TRANSFER_REASONS),
            visit_type: z.enum(VISIT_TYPES),
            suggested_visit_date: IsoDate.optional().describe("Visit day, YYYY-MM-DD (IST). Omit if not said."),
            dealer_preferred_time: z.string().trim().max(200).optional(),
            handoff_notes: Remarks.optional(),
            pending_items: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
            out_of_territory_reason: z.string().trim().max(1000).optional(),
        }),
        run: async (ctx, input): Promise<ToolResult> => {
            const owned = await ownedLeadOr(ctx, input.lead_id);
            if (owned.result) return owned.result;
            const lead = owned.lead;
            const crmUrl = leadUrl(ctx.user, lead.id);

            const { asms } = await listAsmOptions({ state: lead.state, city: lead.city, includeOutOfTerritory: true });
            const people = asms.map((a) => ({ ...a, id: a.user_id }));
            const matches = matchPeople(people, input.asm);
            if (matches.length === 0) {
                const inTerritory = people.filter((a) => a.in_territory);
                return ask(
                    `I couldn't find an active ASM called "${input.asm}".` +
                        (inTerritory.length ? ` ASMs for this dealer's area: ${nameList(inTerritory)}. Which one?` : " Which ASM?"),
                );
            }
            if (matches.length > 1) return ask(`Which ASM do you mean: ${nameList(matches)}?`);
            const asm = matches[0]!;
            const asmName = asm.name?.trim() || asm.email;

            const outReason = input.out_of_territory_reason?.trim() || null;
            if (!asm.in_territory && !outReason) {
                const area = [lead.city, lead.state].filter(Boolean).join(", ") || "this dealer's area";
                return ask(`${asmName} doesn't cover ${area}. Why transfer to them? I need a short reason.`);
            }

            let visitDate: string | null = null;
            if (input.suggested_visit_date) {
                const day = futureDay(input.suggested_visit_date, ctx.now);
                if (!day.ok) return ask(day.question);
                visitDate = day.value;
            }

            const plan: TransferToAsmPlan = {
                lead_id: lead.id,
                asm_id: asm.user_id,
                asm_name: asmName,
                reason: input.reason as TransferReason,
                visit_type: input.visit_type as VisitType,
                suggested_visit_date: visitDate,
                dealer_preferred_time: input.dealer_preferred_time?.trim() || null,
                handoff_notes: input.handoff_notes?.trim() ?? "",
                pending_items: input.pending_items ?? [],
                out_of_territory_reason: asm.in_territory ? null : outReason,
            };

            const lines: Preview["lines"] = [
                { label: "ASM", value: `${asmName}${asm.in_territory ? "" : " (out of territory)"}` },
                { label: "Status", value: `${statusLabel(lead.lead_status)} → Transferred to ASM` },
                { label: "Reason", value: reasonLabel(plan.reason) },
                {
                    label: "Visit",
                    value: `${reasonLabel(plan.visit_type)} · ${fmtDate(plan.suggested_visit_date) ?? "date to be scheduled"}` +
                        (plan.dealer_preferred_time ? ` (${plan.dealer_preferred_time})` : ""),
                },
            ];
            if (plan.handoff_notes) lines.push({ label: "Notes", value: plan.handoff_notes });
            if (plan.pending_items.length) lines.push({ label: "Pending", value: plan.pending_items.join(", ") });
            if (plan.out_of_territory_reason) lines.push({ label: "Out of territory", value: plan.out_of_territory_reason });

            const preview: Preview = {
                title: `Transfer ${lead.shop_name || lead.dealer_name || lead.id} → ${asmName}`,
                lines,
                resets_idle_clock: isWorkedTouchpoint("asm_transfer", true),
                warning: `After this the lead belongs to ${asmName} and is read-only for you.`,
                needs_second_confirm: false,
                crm_url: crmUrl,
            };
            const { id } = await createPending({
                userId: ctx.user.id,
                tool: "transfer_to_asm",
                leadId: lead.id,
                leadVersion: lead.updated_at,
                plan,
                preview,
                before: { lead_status: lead.lead_status, current_owner_id: lead.current_owner_id, asm_id: lead.asm_id },
                sourceMessageId: ctx.messageId,
            });
            return { kind: "preview", action_id: id, preview };
        },
    });

export const transferToAsmApplier = defineApplier<TransferToAsmPlan>({
    schema: TransferToAsmPlan,
    apply: async ({ tx, user }, p) => {
        await transferLeadToAsm(
            {
                leadId: p.lead_id,
                actorId: user.id,
                asmId: p.asm_id,
                reason: p.reason,
                visitType: p.visit_type,
                suggestedVisitDate: p.suggested_visit_date,
                dealerPreferredTime: p.dealer_preferred_time,
                handoffNotes: p.handoff_notes,
                pendingItems: p.pending_items,
                outOfTerritoryReason: p.out_of_territory_reason,
            },
            { tx },
        );
        return { new_owner_id: p.asm_id };
    },
});

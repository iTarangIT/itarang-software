// set_follow_up — the next action and date without a call (BRD §9.2, UC-07).
// Role-aware (BRD §2.3-2):
//   ISR  → a note + next_follow_up_at               (logLeadTouchpoint)
//   ASM  → a SCHEDULED lead_visits row + a note     (scheduleVisit + logLeadTouchpoint)
//          so it appears in Today's Schedule on that day.
// PROPOSES only; setFollowUpApplier writes, from the executor, in one tx.
//
// When the rep actually spoke to the dealer (spoke_with_dealer), the shared
// auto rule (lib/leads/autoProgress.ts) moves the status forward to Under
// Discussion — on the same note touchpoint, marked "(auto)" on the preview.
// A bare reminder moves nothing.

import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { leadVisits } from "@/lib/db/schema";
import { logLeadTouchpoint } from "@/lib/inside-sales/logTouchpoint";
import { autoProgressForFollowUp } from "@/lib/leads/autoProgress";
import { LEAD_STATUS } from "@/lib/lifecycle/transitions";
import { scheduleVisit } from "@/lib/asm/recordVisit";
import { createPending } from "../../actions";
import { fmtDate, statusLabel } from "../../format";
import type { Preview, ToolContext, ToolResult } from "../../types";
import { defineTool, LeadId, ownedLeadOr, type ToolFactory } from "../spec";
import { leadUrl } from "../leads";
import { defineApplier } from "../../applierSpec";
import { dayToInstant, futureDay, futureInstant } from "./when";
import { IsoDate, IsoDateTime, Remarks } from "./vocabSchemas";

/** Auto status change (spoke with the dealer → Under Discussion), recorded on the note touchpoint. */
const StatusTo = z.enum(LEAD_STATUS).nullable().default(null);

export const SetFollowUpPlan = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("isr_follow_up"), lead_id: z.string().min(1), follow_up_at: z.string(), note: z.string(), status_to: StatusTo }),
    z.object({ kind: z.literal("asm_visit"), lead_id: z.string().min(1), visit_date: z.string(), note: z.string(), status_to: StatusTo }),
]);
export type SetFollowUpPlan = z.infer<typeof SetFollowUpPlan>;

const ask = (question: string): ToolResult => ({ kind: "question", question });

const SpokeWithDealer = z
    .boolean()
    .optional()
    .describe("true ONLY if the user says they actually spoke to the dealer (not just a reminder)");

async function propose(
    ctx: ToolContext,
    leadId: string,
    plan: SetFollowUpPlan,
    lines: Preview["lines"],
    warning: string | null,
    spokeWithDealer: boolean,
) {
    const owned = await ownedLeadOr(ctx, leadId);
    if (owned.result) return owned.result;
    const lead = owned.lead;
    const name = lead.shop_name || lead.dealer_name || lead.id;
    const { statusTo } = autoProgressForFollowUp({ spokeWithDealer, currentStatus: lead.lead_status });
    plan = { ...plan, status_to: statusTo };
    if (statusTo) lines = [...lines, { label: "Status", value: `${statusLabel(lead.lead_status)} → ${statusLabel(statusTo)} (auto)` }];
    const preview: Preview = {
        title: `${plan.kind === "asm_visit" ? "Schedule visit" : "Set follow-up"} — ${name}`,
        lines,
        // A note is not work (isWorkedTouchpoint) — unless it carries a status change.
        resets_idle_clock: !!statusTo,
        warning,
        needs_second_confirm: false,
        crm_url: leadUrl(ctx.user, lead.id),
    };
    const { id } = await createPending({
        userId: ctx.user.id,
        tool: "set_follow_up",
        leadId: lead.id,
        leadVersion: lead.updated_at,
        plan: { ...plan, lead_id: lead.id },
        preview,
        before: { next_follow_up_at: lead.next_follow_up_at?.toISOString() ?? null, asm_id: lead.asm_id, lead_status: lead.lead_status },
        sourceMessageId: ctx.messageId,
    });
    return { kind: "preview", action_id: id, preview } satisfies ToolResult;
}

export const setFollowUp: ToolFactory = (role) =>
    role === "asm"
        ? defineTool({
              name: "set_follow_up",
              kind: "write",
              description:
                  "Propose scheduling the next visit to a lead the ASM owns (it appears in Today's Schedule on that day). " +
                  "Nothing is saved until Confirm.",
              schema: z.object({ lead_id: LeadId, visit_date: IsoDate, note: Remarks.min(1), spoke_with_dealer: SpokeWithDealer }),
              run: async (ctx, input): Promise<ToolResult> => {
                  // Pilot flag, scope and ownership BEFORE reading anything about the lead.
                  const scoped = await ownedLeadOr(ctx, input.lead_id);
                  if (scoped.result) return scoped.result;
                  const day = futureDay(input.visit_date, ctx.now);
                  if (!day.ok) return ask(day.question);
                  // Idempotent like scheduleVisit: an open visit that day already covers it.
                  const existing = await db
                      .select({ id: leadVisits.visit_id })
                      .from(leadVisits)
                      .where(
                          and(
                              eq(leadVisits.dealer_lead_id, input.lead_id),
                              eq(leadVisits.asm_id, ctx.user.id),
                              eq(leadVisits.scheduled_date, day.value),
                              inArray(leadVisits.visit_status, ["scheduled", "pending_scheduling"]),
                          ),
                      )
                      .limit(1);
                  if (existing.length > 0) {
                      return { kind: "declined", reason: `That visit is already on your schedule for ${fmtDate(day.value)}.` };
                  }
                  const warning =
                      scoped.lead.asm_id !== ctx.user.id
                          ? "This lead's field ASM isn't set to you, so the visit won't show in your Today's Schedule."
                          : null;
                  return propose(
                      ctx,
                      input.lead_id,
                      { kind: "asm_visit", lead_id: input.lead_id, visit_date: day.value, note: input.note.trim(), status_to: null },
                      [
                          { label: "Visit", value: `${fmtDate(day.value)} (goes to Today's Schedule)` },
                          { label: "Note", value: input.note.trim() },
                      ],
                      warning,
                      input.spoke_with_dealer === true,
                  );
              },
          })
        : defineTool({
              name: "set_follow_up",
              kind: "write",
              description:
                  "Propose setting the next follow-up date and time on a lead the user owns. Nothing is saved until Confirm.",
              schema: z.object({ lead_id: LeadId, follow_up_at: IsoDateTime, note: Remarks.min(1), spoke_with_dealer: SpokeWithDealer }),
              run: async (ctx, input): Promise<ToolResult> => {
                  const when = futureInstant(input.follow_up_at, ctx.now);
                  if (!when.ok) return ask(when.question);
                  return propose(
                      ctx,
                      input.lead_id,
                      { kind: "isr_follow_up", lead_id: input.lead_id, follow_up_at: when.value, note: input.note.trim(), status_to: null },
                      [
                          { label: "Follow-up", value: fmtDate(when.value)! },
                          { label: "Note", value: input.note.trim() },
                      ],
                      null,
                      input.spoke_with_dealer === true,
                  );
              },
          });

export const setFollowUpApplier = defineApplier<SetFollowUpPlan>({
    schema: SetFollowUpPlan,
    apply: async ({ tx, user }, p) => {
        // A plan is bound to the role that proposed it.
        if ((p.kind === "asm_visit") !== (user.role === "asm")) throw new Error("follow-up plan does not match the user's role");
        if (p.kind === "asm_visit") {
            const visit = await scheduleVisit({ leadId: p.lead_id, asmId: user.id, date: p.visit_date, remarks: p.note }, { tx });
            const tp = await logLeadTouchpoint(
                {
                    leadId: p.lead_id,
                    actorId: user.id,
                    body: {
                        touchpoint_type: "status_change_note",
                        remarks: `Visit scheduled for ${p.visit_date}: ${p.note}`,
                        next_action: "follow_up",
                        next_action_at: dayToInstant(p.visit_date),
                        status_change: p.status_to ? { to: p.status_to } : undefined,
                    },
                },
                { tx },
            );
            return { scheduled_visit_id: visit.visitId, touchpoint_id: tp.touchpointId };
        }
        const tp = await logLeadTouchpoint(
            {
                leadId: p.lead_id,
                actorId: user.id,
                body: {
                    touchpoint_type: "status_change_note",
                    remarks: `Follow-up: ${p.note}`,
                    next_action: "follow_up",
                    next_action_at: p.follow_up_at,
                    follow_up_at: p.follow_up_at,
                    status_change: p.status_to ? { to: p.status_to } : undefined,
                },
            },
            { tx },
        );
        return { touchpoint_id: tp.touchpointId };
    },
});

// set_follow_up — the next action and date without a call (BRD §9.2, UC-07).
// Role-aware (BRD §2.3-2), and each path is the screen's own writer:
//   ISR              → a note + next_follow_up_at      (logLeadTouchpoint — the log
//                                                       form's "Set next follow-up")
//   ASM, kind call   → the same: "call back kal 4 baje" keeps its time, on the
//                      same form the ASM's lead page uses (decided 15 Oct)
//   ASM, kind visit  → a SCHEDULED visit, exactly as the visit form books one
//                      (recordVisit — POST /api/asm/lead/[id]/visit): the
//                      lead_visits row + a `visit` touchpoint, which is work and
//                      resets the idle clock (decided 15 Oct); it appears in
//                      Today's Schedule on that day, and whoever transferred the
//                      lead gets the route's "Field visit booked" notice.
// PROPOSES only; setFollowUpApplier writes, from the executor, in one tx.
//
// A follow-up is a note and a date. It NEVER moves the lead's status
// (tracker ID 80): "I spoke to the dealer" on a reminder is not an event. If
// the rep did speak to the dealer, that is a call — log_call records it with
// its outcome, and the outcome moves the status. A booked visit moves nothing
// either: only a DONE visit does (the visit route applies status for visited).

import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { leadVisits } from "@/lib/db/schema";
import { logLeadTouchpoint } from "@/lib/inside-sales/logTouchpoint";
import { recordVisit } from "@/lib/asm/recordVisit";
import { isWorkedTouchpoint } from "@/lib/lifecycle/touchpointTypes";
import { createPending } from "../../actions";
import { fmtDate } from "../../format";
import type { Preview, ToolContext, ToolResult } from "../../types";
import { defineTool, LeadId, ownedLeadOr, type ToolFactory } from "../spec";
import { leadUrl } from "../leads";
import { defineApplier } from "../../applierSpec";
import { futureDay, futureInstant } from "./when";
import { IsoDate, IsoDateTime, Remarks } from "./vocabSchemas";
import { notifyVisitUpdate } from "./logVisit";

// No status_to: a plan stored before ID 80 may still carry one — zod drops
// the unknown key, so an old card confirmed after the deploy moves nothing.
// "isr_follow_up" is the CALL follow-up for either role (the name predates
// the ASM's call follow-up; stored plans keep it).
export const SetFollowUpPlan = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("isr_follow_up"), lead_id: z.string().min(1), follow_up_at: z.string(), note: z.string() }),
    z.object({ kind: z.literal("asm_visit"), lead_id: z.string().min(1), visit_date: z.string(), note: z.string() }),
]);
export type SetFollowUpPlan = z.infer<typeof SetFollowUpPlan>;

const ask = (question: string): ToolResult => ({ kind: "question", question });

/** A booked visit's `visit` touchpoint is work (isWorkedTouchpoint); a follow-up note is not. */
export function followUpResetsIdleClock(kind: SetFollowUpPlan["kind"]): boolean {
    return kind === "asm_visit" ? isWorkedTouchpoint("visit", false) : isWorkedTouchpoint("status_change_note", false);
}

async function propose(
    ctx: ToolContext,
    leadId: string,
    plan: SetFollowUpPlan,
    lines: Preview["lines"],
    warning: string | null,
) {
    const owned = await ownedLeadOr(ctx, leadId);
    if (owned.result) return owned.result;
    const lead = owned.lead;
    const name = lead.shop_name || lead.dealer_name || lead.id;
    const preview: Preview = {
        title: `${plan.kind === "asm_visit" ? "Schedule visit" : "Set follow-up"} — ${name}`,
        lines,
        resets_idle_clock: followUpResetsIdleClock(plan.kind),
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

/** A call follow-up (ISR, or an ASM's kind "call"): a future instant, time kept. */
async function proposeCallFollowUp(ctx: ToolContext, leadId: string, at: string, note: string): Promise<ToolResult> {
    const when = futureInstant(at, ctx.now);
    if (!when.ok) return ask(when.question);
    return propose(
        ctx,
        leadId,
        { kind: "isr_follow_up", lead_id: leadId, follow_up_at: when.value, note: note.trim() },
        [
            { label: "Follow-up", value: fmtDate(when.value)! },
            { label: "Note", value: note.trim() },
        ],
        null,
    );
}

export const setFollowUp: ToolFactory = (role) =>
    role === "asm"
        ? defineTool({
              name: "set_follow_up",
              kind: "write",
              description:
                  "Propose the next step on a lead the ASM owns. kind \"call\": a call follow-up at a date AND time " +
                  "(follow_up_at) — e.g. 'call back kal 4 baje'. kind \"visit\": book a field visit on a day (visit_date) — " +
                  "it appears in Today's Schedule that day. It never changes the lead's status — a visit that happened is " +
                  "logged with log_visit. Nothing is saved until Confirm.",
              schema: z.object({
                  lead_id: LeadId,
                  kind: z.enum(["call", "visit"]).describe("call = a call follow-up (date + time); visit = book a field visit (a day)"),
                  follow_up_at: IsoDateTime.optional().describe("kind call: the date and time, with offset (IST)"),
                  visit_date: IsoDate.optional().describe("kind visit: the day, YYYY-MM-DD (IST)"),
                  note: Remarks.min(1),
              }),
              run: async (ctx, input): Promise<ToolResult> => {
                  // Pilot flag, scope and ownership BEFORE reading anything about the lead.
                  const scoped = await ownedLeadOr(ctx, input.lead_id);
                  if (scoped.result) return scoped.result;
                  if (input.kind === "call") {
                      if (!input.follow_up_at) return ask("When should the follow-up call be — which day and time?");
                      return proposeCallFollowUp(ctx, input.lead_id, input.follow_up_at, input.note);
                  }
                  if (!input.visit_date) return ask("Which day should the visit be?");
                  const day = futureDay(input.visit_date, ctx.now);
                  if (!day.ok) return ask(day.question);
                  // An open visit that day already covers it.
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
                      { kind: "asm_visit", lead_id: input.lead_id, visit_date: day.value, note: input.note.trim() },
                      [
                          { label: "Visit", value: `${fmtDate(day.value)} (goes to Today's Schedule)` },
                          { label: "Note", value: input.note.trim() },
                      ],
                      warning,
                  );
              },
          })
        : defineTool({
              name: "set_follow_up",
              kind: "write",
              description:
                  "Propose setting the next follow-up date and time on a lead the user owns. It never changes the lead's " +
                  "status — if the user spoke to the dealer, log that call with log_call instead. Nothing is saved until Confirm.",
              schema: z.object({ lead_id: LeadId, follow_up_at: IsoDateTime, note: Remarks.min(1) }),
              run: async (ctx, input): Promise<ToolResult> => proposeCallFollowUp(ctx, input.lead_id, input.follow_up_at, input.note),
          });

/** What the visit form sends to book a visit (VisitFields: status scheduled, the day, next visit that day). */
export function bookedVisitInput(p: Extract<SetFollowUpPlan, { kind: "asm_visit" }>, asmId: string) {
    return {
        leadId: p.lead_id,
        asmId,
        visit_status: "scheduled" as const,
        scheduled_date: p.visit_date,
        visit_remarks: p.note,
        next_action: "next_visit" as const,
        next_visit_date: p.visit_date,
    };
}

export const setFollowUpApplier = defineApplier<SetFollowUpPlan>({
    schema: SetFollowUpPlan,
    apply: async ({ tx, user }, p) => {
        if (p.kind === "asm_visit") {
            // A booked visit is an ASM's; the plan is bound to the role that proposed it.
            if (user.role !== "asm") throw new Error("visit plan does not match the user's role");
            // The visit route's own writer: the scheduled row + its `visit` touchpoint.
            const visit = await recordVisit(bookedVisitInput(p, user.id), { tx });
            return {
                scheduled_visit_id: visit.visitId,
                afterCommit: () =>
                    notifyVisitUpdate({
                        leadId: p.lead_id,
                        actorId: user.id,
                        visited: false,
                        outcome: null,
                        remarks: p.note,
                        scheduledDate: p.visit_date,
                    }),
            };
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
                },
            },
            { tx },
        );
        return { touchpoint_id: tp.touchpointId };
    },
});

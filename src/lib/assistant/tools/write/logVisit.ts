// log_visit — an ASM's field visit and what comes next (BRD §9.2, UC-01).
// PROPOSES only: resolves the visit against the frozen §9.3 visit rows, stores
// the plan as a pending action with a preview, returns the preview. On Confirm,
// logVisitApplier writes ALL of it in the executor's one transaction:
//   visit row + visit touchpoint + scheduled next visit   recordVisit (the visit route's writer)
//   interest change                                       setInterestLevel
//   status change (commercials explained / finalised)     logLeadTouchpoint (status_change_note)
//
// Status and temperature the ASM did NOT state are filled by the shared auto
// rule (lib/leads/autoProgress.ts) and marked "(auto)" on the preview.
//   Lost with its reason                                  markLeadLost
// so a failure anywhere leaves none of it (BRD §8.4).
//
// Mirrors the visit screen: an outcome only for a completed visit, a date only
// for a completed visit, a next-visit date only with next_action next_visit.
// The screen chains "convert" into the conversion flow; that needs a GSTIN and
// starts onboarding, so it is declined here with the lead's link (BRD UC-11).

import { z } from "zod";
import { LEAD_STATUS, LOST_REASON, isHighImpactLostReason } from "@/lib/lifecycle/transitions";
import { INTEREST_LEVELS } from "@/lib/admin/salesDashboardTypes";
import { VISIT_NEXT_ACTION, VISIT_OUTCOME } from "@/lib/asm/types";
import { recordVisit } from "@/lib/asm/recordVisit";
import { logLeadTouchpoint } from "@/lib/inside-sales/logTouchpoint";
import { markLeadLost } from "@/lib/leads/markLost";
import { setInterestLevel } from "@/lib/leads/interestLevel";
import { autoProgressForVisit } from "@/lib/leads/autoProgress";
import { checkVisitProposal, NO_CHANGE, type StatusChoice } from "../../vocab";
import { createPending } from "../../actions";
import { istNow } from "../../prompt";
import { fmtDate, reasonLabel, statusLabel } from "../../format";
import type { Preview, ToolResult } from "../../types";
import { defineTool, LeadId, ownedLeadOr, type ToolFactory } from "../spec";
import { leadUrl } from "../leads";
import { defineApplier } from "../../applierSpec";
import { highImpactConsequence, highImpactWarning } from "./logCall";
import { futureDay, MAX_DAYS_AHEAD } from "./when";
import {
    Interest,
    IsoDate,
    LostReason,
    Remarks,
    StatusChoice as StatusChoiceEnum,
    VisitNextAction,
    VisitOutcome,
} from "./vocabSchemas";

/** What a rep reports AFTER the fact. Scheduling a visit is set_follow_up's job. */
export const LOGGED_VISIT_STATUS = ["visited", "postponed", "cancelled", "no_show"] as const;

export const LogVisitPlan = z.object({
    lead_id: z.string().min(1),
    visit_status: z.enum(LOGGED_VISIT_STATUS),
    visit_outcome: z.enum(VISIT_OUTCOME).nullable(),
    /** IST calendar day of a completed visit; null otherwise (as the screen sends it). */
    visit_date: z.string().nullable(),
    remarks: z.string().min(1),
    next_action: z.enum(VISIT_NEXT_ACTION).exclude(["convert"]),
    next_visit_date: z.string().nullable(),
    interest: z.enum(INTEREST_LEVELS).nullable(),
    /** A non-Lost status change, from the §9.3 visit rows. */
    status_to: z.enum(LEAD_STATUS).nullable(),
    lost: z.object({ reason: z.enum(LOST_REASON), notes: z.string().nullable() }).nullable(),
    /** Which of status_to / interest came from the auto rule (audit + preview). */
    auto: z.object({ status: z.boolean(), interest: z.boolean() }).default({ status: false, interest: false }),
});
export type LogVisitPlan = z.infer<typeof LogVisitPlan>;

const ask = (question: string): ToolResult => ({ kind: "question", question });

/** A completed visit's day: not in the future, not older than the window. */
function pastDay(date: string, today: string): { ok: true } | { ok: false; question: string } {
    if (date > today) return { ok: false, question: "That date is in the future. When was the visit?" };
    const floor = new Date(`${today}T00:00:00Z`);
    floor.setUTCDate(floor.getUTCDate() - MAX_DAYS_AHEAD);
    if (date < floor.toISOString().slice(0, 10)) {
        return { ok: false, question: `That's more than ${MAX_DAYS_AHEAD} days ago. Which date was the visit?` };
    }
    return { ok: true };
}

export const logVisit: ToolFactory = () =>
    defineTool({
        name: "log_visit",
        kind: "write",
        description:
            "Propose logging a field visit on a lead the ASM owns: visit status, outcome, remarks, next action and next-visit date, " +
            "with optional interest or status change. 'Convert' is not done here — send the CRM link. " +
            "To only schedule a visit, use set_follow_up. Nothing is saved until Confirm.",
        schema: z
            .object({
                lead_id: LeadId,
                visit_status: z.enum(LOGGED_VISIT_STATUS),
                outcome: VisitOutcome.optional(),
                visit_date: IsoDate.optional().describe("Day of the visit if not today (IST), e.g. 'kal mila tha'"),
                remarks: Remarks.min(1),
                next_action: VisitNextAction,
                next_visit_date: IsoDate.optional(),
                interest: Interest.optional(),
                status: StatusChoiceEnum.optional(),
                lost_reason: LostReason.optional(),
            })
            .refine((v) => v.visit_status !== "visited" || !!v.outcome, {
                message: "outcome is required when visit_status is visited",
                path: ["outcome"],
            })
            .refine((v) => v.next_action !== "next_visit" || !!v.next_visit_date, {
                message: "next_visit_date is required when next_action is next_visit",
                path: ["next_visit_date"],
            }),
        run: async (ctx, input): Promise<ToolResult> => {
            const owned = await ownedLeadOr(ctx, input.lead_id);
            if (owned.result) return owned.result;
            const lead = owned.lead;
            const crmUrl = leadUrl(ctx.user, lead.id);

            if (input.next_action === "convert") {
                return {
                    kind: "declined",
                    reason:
                        "Converting needs the GSTIN and starts onboarding, so it's done on the CRM screen. " +
                        "I can still log the visit — tell me the next step (a next visit, Lost, or escalate).",
                    crm_url: crmUrl,
                };
            }

            const today = istNow(ctx.now).isoDate;
            const visited = input.visit_status === "visited";
            const remarks = input.remarks.trim();

            let visitDate: string | null = null;
            let status: StatusChoice = NO_CHANGE;
            let lost: LogVisitPlan["lost"] = null;
            if (visited) {
                visitDate = input.visit_date ?? today;
                const day = pastDay(visitDate, today);
                if (!day.ok) return ask(day.question);
                const check = checkVisitProposal({
                    outcome: input.outcome!,
                    status: input.status as StatusChoice | undefined,
                    lostReason: input.lost_reason ?? null,
                });
                if (!check.ok) return ask(check.question);
                status = check.status;
                if (status === "Lost") lost = { reason: check.lostReason!, notes: remarks };
            } else if ((input.status && input.status !== NO_CHANGE) || input.lost_reason) {
                return ask("The visit didn't happen, so I can't change the lead's status from it. Did you meet the dealer?");
            }

            // next_action and Lost must agree — the screen chains "lost" into Mark Lost.
            if (lost && input.next_action !== "lost") {
                return ask("A lost lead has no next step. Should I mark it Lost, or keep it open?");
            }
            if (!lost && input.next_action === "lost") {
                return ask(visited ? "Should I mark this lead Lost? Tell me why." : "The visit didn't happen — did you meet the dealer?");
            }

            let nextVisit: string | null = null;
            if (input.next_action === "next_visit") {
                const day = futureDay(input.next_visit_date!, ctx.now);
                if (!day.ok) return ask(day.question);
                // recordVisit schedules only STRICTLY after the visit day (today for a
                // visit that didn't happen); ask rather than preview a row it won't write.
                if (day.value <= (visitDate ?? today)) {
                    return ask(`The next visit has to be after ${visitDate ? "this visit" : "today"}. Which day should it be?`);
                }
                nextVisit = day.value;
            }

            let statusTo = !lost && status !== NO_CHANGE && status !== lead.lead_status ? status : null;
            let interest = input.interest && input.interest !== lead.interest_level ? input.interest : null;
            const auto = { status: false, interest: false };
            if (!lost) {
                const derived = autoProgressForVisit({
                    visited,
                    outcome: visited ? input.outcome! : null,
                    currentStatus: lead.lead_status,
                    currentInterest: lead.interest_level,
                });
                if (input.status === undefined && !statusTo && derived.statusTo) {
                    statusTo = derived.statusTo;
                    auto.status = true;
                }
                if (!input.interest && derived.interestTo) {
                    interest = derived.interestTo;
                    auto.interest = true;
                }
            }

            const plan: LogVisitPlan = {
                lead_id: lead.id,
                visit_status: input.visit_status,
                visit_outcome: visited ? input.outcome! : null,
                visit_date: visitDate,
                remarks,
                next_action: input.next_action,
                next_visit_date: nextVisit,
                interest,
                status_to: statusTo,
                lost,
                auto,
            };

            const lines: Preview["lines"] = [
                {
                    label: "Visit",
                    value: `${reasonLabel(plan.visit_status)}${plan.visit_outcome ? ` · ${reasonLabel(plan.visit_outcome)}` : ""}` +
                        (visitDate && visitDate !== today ? ` (${fmtDate(visitDate)})` : ""),
                },
                {
                    label: "Status",
                    value: lost
                        ? `${statusLabel(lead.lead_status)} → Lost (${reasonLabel(lost.reason)})`
                        : statusTo
                          ? `${statusLabel(lead.lead_status)} → ${statusLabel(statusTo)}${auto.status ? " (auto)" : ""}`
                          : "no change",
                },
            ];
            if (interest) {
                lines.push({ label: "Temperature", value: `${lead.interest_level ?? "none"} → ${interest}${auto.interest ? " (auto)" : ""}` });
            }
            if (nextVisit) lines.push({ label: "Next visit", value: `${fmtDate(nextVisit)} (goes to Today's Schedule)` });
            if (plan.next_action === "escalate") lines.push({ label: "Next step", value: "escalate" });
            lines.push({ label: "Remarks", value: remarks });

            const warnings: string[] = [];
            const secondConfirm = !!lost && isHighImpactLostReason(lost.reason);
            if (secondConfirm) warnings.push(highImpactConsequence(lost!.reason));
            if (nextVisit && lead.asm_id !== ctx.user.id) {
                warnings.push("This lead's field ASM isn't set to you, so the next visit won't show in your Today's Schedule.");
            }
            if (plan.next_action === "escalate") warnings.push("Raise the escalation itself on the CRM screen.");

            const preview: Preview = {
                title: `Log visit — ${lead.shop_name || lead.dealer_name || lead.id}`,
                lines,
                // A visit touchpoint is work (isWorkedTouchpoint), whatever its status.
                resets_idle_clock: true,
                warning: warnings.length ? warnings.join(" ") : null,
                needs_second_confirm: secondConfirm,
                crm_url: crmUrl,
            };
            const { id } = await createPending({
                userId: ctx.user.id,
                tool: "log_visit",
                leadId: lead.id,
                leadVersion: lead.updated_at,
                plan,
                preview,
                before: { lead_status: lead.lead_status, interest_level: lead.interest_level, asm_id: lead.asm_id },
                sourceMessageId: ctx.messageId,
            });
            return { kind: "preview", action_id: id, preview };
        },
    });

export const logVisitApplier = defineApplier<LogVisitPlan>({
    schema: LogVisitPlan,
    needsSecondConfirm: (p) => !!p.lost && isHighImpactLostReason(p.lost.reason),
    secondConfirmWarning: (p) => highImpactWarning(p.lost!.reason),
    apply: async ({ tx, user, step }, p) => {
        // A visit is an ASM's; the plan is bound to the role that proposed it.
        if (user.role !== "asm") throw new Error("visit plan does not match the user's role");
        const visit = await recordVisit(
            {
                leadId: p.lead_id,
                asmId: user.id,
                visit_status: p.visit_status,
                visit_outcome: p.visit_outcome,
                // Passed explicitly: recordVisit's own default is the UTC date.
                actual_visit_date: p.visit_date,
                visit_remarks: p.remarks,
                next_action: p.next_action,
                next_visit_date: p.next_visit_date,
            },
            { tx },
        );
        if (p.interest) {
            await setInterestLevel(
                {
                    leadId: p.lead_id,
                    actorId: user.id,
                    level: p.interest,
                    reason: p.auto.interest ? "Auto: from visit outcome (WhatsApp Assistant)" : "Logged from the WhatsApp Assistant",
                },
                { tx },
            );
        }
        let statusHistoryId: string | null = null;
        if (p.status_to) {
            const tp = await logLeadTouchpoint(
                {
                    leadId: p.lead_id,
                    actorId: user.id,
                    body: {
                        touchpoint_type: "status_change_note",
                        remarks: `After the visit on ${p.visit_date}: ${p.remarks}`,
                        status_change: { to: p.status_to },
                    },
                },
                { tx },
            );
            statusHistoryId = tp.historyId;
        }
        if (p.lost) {
            await markLeadLost(
                {
                    leadId: p.lead_id,
                    actor: { id: user.id, role: user.role },
                    reason: p.lost.reason,
                    notes: p.lost.notes,
                    // Only a step-2 action carries the second Confirm.
                    confirmedHighImpact: step === 2,
                },
                { tx },
            );
        }
        return { visit_id: visit.visitId, scheduled_visit_id: visit.scheduledVisitId, status_history_id: statusHistoryId };
    },
});

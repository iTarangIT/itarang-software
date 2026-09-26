// log_call — a call, WhatsApp chat or note with its outcome (BRD §9.2,
// UC-02 / UC-03). PROPOSES only: resolves the rep's words against the frozen
// §9.3 map, stores the resolved plan as a pending action with a preview, and
// returns the preview. logCallApplier does the writes, from the executor,
// after a Confirm tap — all in one transaction:
//   touchpoint (+ non-Lost status change + next_follow_up_at)   logLeadTouchpoint
//   Lost with its reason (second Confirm if high-impact)         markLeadLost
//   interest change                                              setInterestLevel
//
// Status and temperature the rep did NOT state are filled by the shared auto
// rule (lib/leads/autoProgress.ts — the same one the CRM modal pre-fills
// with) and marked "(auto)" on the preview, where the rep can Edit them.

import { z } from "zod";
import { CONNECT_STATUS, DISPOSITION_BUCKETS } from "@/lib/leads/dispositions";
import { LEAD_STATUS, LOST_REASON, isHighImpactLostReason, type LostReason } from "@/lib/lifecycle/transitions";
import { isWorkedTouchpoint } from "@/lib/lifecycle/touchpointTypes";
import { INTEREST_LEVELS } from "@/lib/admin/salesDashboardTypes";
import { logLeadTouchpoint } from "@/lib/inside-sales/logTouchpoint";
import { markLeadLost } from "@/lib/leads/markLost";
import { setInterestLevel } from "@/lib/leads/interestLevel";
import { autoProgressForCall } from "@/lib/leads/autoProgress";
import { checkCallProposal, NO_CHANGE, type StatusChoice } from "../../vocab";
import { createPending } from "../../actions";
import { fmtDate, reasonLabel, statusLabel } from "../../format";
import type { Preview, ToolResult } from "../../types";
import { defineTool, LeadId, ownedLeadOr, type ToolFactory } from "../spec";
import { leadUrl } from "../leads";
import { defineApplier } from "../../applierSpec";
import { futureInstant } from "./when";
import {
    Bucket,
    ConnectStatus,
    DispositionLabel,
    Interest,
    IsoDateTime,
    LostReason as LostReasonEnum,
    Remarks,
    StatusChoice as StatusChoiceEnum,
} from "./vocabSchemas";

/** What the executor applies — resolved, validated again at execute time. */
export const LogCallPlan = z.object({
    lead_id: z.string().min(1),
    channel: z.enum(["call", "whatsapp", "note"]),
    touchpoint_type: z.enum(["inside_sales_call", "whatsapp", "status_change_note"]),
    disposition: z
        .object({
            connect_status: z.enum(CONNECT_STATUS),
            label: z.string().min(1),
            bucket: z.enum(DISPOSITION_BUCKETS).nullable(),
        })
        .nullable(),
    call_duration_sec: z.number().int().min(0).nullable(),
    remarks: z.string().nullable(),
    /** A non-Lost status change, recorded on the call touchpoint. */
    status_to: z.enum(LEAD_STATUS).nullable(),
    lost: z.object({ reason: z.enum(LOST_REASON), notes: z.string().nullable() }).nullable(),
    /** UTC ISO instant. */
    follow_up_at: z.string().nullable(),
    interest: z.enum(INTEREST_LEVELS).nullable(),
    /** Which of status_to / interest came from the auto rule (audit + preview). */
    auto: z.object({ status: z.boolean(), interest: z.boolean() }).default({ status: false, interest: false }),
});
export type LogCallPlan = z.infer<typeof LogCallPlan>;

const ask = (question: string): ToolResult => ({ kind: "question", question });

const HIGH_IMPACT_CONSEQUENCE: Partial<Record<LostReason, string>> = {
    business_closed: "the dealer is permanently excluded from the AI dialer",
    duplicate_lead: "the lead is closed as a duplicate",
    rejected_by_us_credit: "the lead is closed as rejected by iTarang (credit)",
    rejected_by_us_geography: "the lead is closed as rejected by iTarang (geography)",
};

/** What a high-impact Lost reason does — shown on the first preview. */
export function highImpactConsequence(reason: LostReason): string {
    return `⚠ High-impact: Lost as "${reasonLabel(reason)}" — ${HIGH_IMPACT_CONSEQUENCE[reason] ?? "this closes the lead"}.`;
}

/** The second (final) confirmation's warning. */
export function highImpactWarning(reason: LostReason): string {
    return `${highImpactConsequence(reason)} Tap Confirm again to save it.`;
}

export const logCall: ToolFactory = () =>
    defineTool({
        name: "log_call",
        kind: "write",
        description:
            "Propose logging a call, WhatsApp chat or note on a lead the user owns, with its disposition and any status, " +
            "follow-up or interest change. Nothing is saved until the user taps Confirm on the preview.",
        schema: z
            .object({
                lead_id: LeadId,
                channel: z.enum(["call", "whatsapp", "note"]),
                connect_status: ConnectStatus.optional(),
                disposition: DispositionLabel.optional(),
                bucket: Bucket.optional(),
                status: StatusChoiceEnum.optional(),
                lost_reason: LostReasonEnum.optional(),
                follow_up_at: IsoDateTime.optional(),
                interest: Interest.optional(),
                duration_minutes: z.number().int().min(0).max(600).optional(),
                remarks: Remarks.optional(),
            })
            .refine((v) => v.channel !== "call" || (!!v.connect_status && !!v.disposition), {
                message: "a call needs connect_status and disposition",
                path: ["disposition"],
            }),
        run: async (ctx, input): Promise<ToolResult> => {
            const owned = await ownedLeadOr(ctx, input.lead_id);
            if (owned.result) return owned.result;
            const lead = owned.lead;
            const remarks = input.remarks?.trim() || null;

            let touchpointType: LogCallPlan["touchpoint_type"];
            let disposition: LogCallPlan["disposition"] = null;
            let statusTo: LogCallPlan["status_to"] = null;
            let lost: LogCallPlan["lost"] = null;
            let interest = input.interest ?? null;
            const auto = { status: false, interest: false };

            if (input.channel === "call") {
                touchpointType = "inside_sales_call";
                const check = checkCallProposal({
                    label: input.disposition!,
                    connect: input.connect_status!,
                    bucket: input.bucket ?? null,
                    status: input.status as StatusChoice | undefined,
                    lostReason: input.lost_reason ?? null,
                });
                if (!check.ok) return ask(check.question);
                disposition = { connect_status: input.connect_status!, label: input.disposition!, bucket: input.bucket ?? null };
                if (check.status === "Lost") {
                    lost = { reason: check.lostReason!, notes: remarks };
                } else if (check.status !== NO_CHANGE && check.status !== lead.lead_status) {
                    statusTo = check.status;
                }
                // Fill what the rep did not say from the shared auto rule. An
                // explicit "no change" from the rep is respected.
                if (!lost) {
                    const derived = autoProgressForCall({
                        connected: input.connect_status === "connected",
                        label: input.disposition!,
                        bucket: input.bucket ?? null,
                        currentStatus: lead.lead_status,
                        currentInterest: lead.interest_level,
                    });
                    if (input.status === undefined && !statusTo && derived.statusTo) {
                        statusTo = derived.statusTo;
                        auto.status = true;
                    }
                    if (!interest && derived.interestTo) {
                        interest = derived.interestTo;
                        auto.interest = true;
                    }
                }
            } else {
                if (input.status || input.lost_reason || input.disposition) {
                    return ask(
                        "For a WhatsApp chat or a note I can save remarks, a follow-up and interest, not a status or call outcome. Was this a call?",
                    );
                }
                touchpointType = input.channel === "whatsapp" ? "whatsapp" : "status_change_note";
                if (!remarks && !input.follow_up_at && !input.interest) return ask("What should I note down?");
            }

            if (lost?.reason === "other" && !lost.notes) return ask("Why was it lost? I need a short note for 'other'.");
            if (lost && input.follow_up_at) {
                return ask("A lost lead can't have a follow-up. Should I mark it Lost, or keep it open with the follow-up?");
            }
            if (interest === lead.interest_level) interest = null;

            let followUpAt: string | null = null;
            if (input.follow_up_at) {
                const when = futureInstant(input.follow_up_at, ctx.now);
                if (!when.ok) return ask(when.question);
                followUpAt = when.value;
            }

            const plan: LogCallPlan = {
                lead_id: lead.id,
                channel: input.channel,
                touchpoint_type: touchpointType,
                disposition,
                call_duration_sec: input.duration_minutes != null ? input.duration_minutes * 60 : null,
                remarks,
                status_to: statusTo,
                lost,
                follow_up_at: followUpAt,
                interest,
                auto,
            };

            const name = lead.shop_name || lead.dealer_name || lead.id;
            const lines: Preview["lines"] = [];
            if (disposition) {
                lines.push({
                    label: "Call",
                    value:
                        `${disposition.connect_status === "connected" ? "connected" : "not connected"} · ${disposition.label}` +
                        (disposition.bucket ? ` (${disposition.bucket})` : ""),
                });
            }
            lines.push({
                label: "Status",
                value: lost
                    ? `${statusLabel(lead.lead_status)} → Lost (${reasonLabel(lost.reason)})`
                    : statusTo
                      ? `${statusLabel(lead.lead_status)} → ${statusLabel(statusTo)}${auto.status ? " (auto)" : ""}`
                      : "no change",
            });
            if (followUpAt) lines.push({ label: "Follow-up", value: fmtDate(followUpAt)! });
            if (interest) {
                lines.push({ label: "Temperature", value: `${lead.interest_level ?? "none"} → ${interest}${auto.interest ? " (auto)" : ""}` });
            }
            if (plan.call_duration_sec) lines.push({ label: "Duration", value: `${input.duration_minutes} min` });
            if (remarks) lines.push({ label: "Remarks", value: remarks });

            const secondConfirm = !!lost && isHighImpactLostReason(lost.reason);
            const preview: Preview = {
                title: `Log ${input.channel === "call" ? "call" : input.channel === "whatsapp" ? "WhatsApp" : "note"} — ${name}`,
                lines,
                resets_idle_clock: isWorkedTouchpoint(touchpointType, !!statusTo) || !!lost,
                warning: secondConfirm ? highImpactConsequence(lost!.reason) : null,
                needs_second_confirm: secondConfirm,
                crm_url: leadUrl(ctx.user, lead.id),
            };

            const { id } = await createPending({
                userId: ctx.user.id,
                tool: "log_call",
                leadId: lead.id,
                leadVersion: lead.updated_at,
                plan,
                preview,
                before: {
                    lead_status: lead.lead_status,
                    interest_level: lead.interest_level,
                    next_follow_up_at: lead.next_follow_up_at?.toISOString() ?? null,
                },
                sourceMessageId: ctx.messageId,
            });
            return { kind: "preview", action_id: id, preview };
        },
    });

export const logCallApplier = defineApplier<LogCallPlan>({
    schema: LogCallPlan,
    ownership: "owner",
    needsSecondConfirm: (p) => !!p.lost && isHighImpactLostReason(p.lost.reason),
    secondConfirmWarning: (p) => highImpactWarning(p.lost!.reason),
    apply: async ({ tx, user, step }, p) => {
        const tp = await logLeadTouchpoint(
            {
                leadId: p.lead_id,
                actorId: user.id,
                body: {
                    touchpoint_type: p.touchpoint_type,
                    disposition: p.disposition,
                    call_duration_sec: p.call_duration_sec,
                    remarks: p.remarks ?? undefined,
                    next_action: p.follow_up_at ? "follow_up" : null,
                    next_action_at: p.follow_up_at,
                    status_change: p.status_to ? { to: p.status_to } : undefined,
                    ...(p.follow_up_at ? { follow_up_at: p.follow_up_at } : {}),
                },
            },
            { tx },
        );
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
        if (p.interest) {
            await setInterestLevel(
                {
                    leadId: p.lead_id,
                    actorId: user.id,
                    level: p.interest,
                    reason: p.auto.interest ? "Auto: from call outcome (WhatsApp Assistant)" : "Logged from the WhatsApp Assistant",
                },
                { tx },
            );
        }
        return { touchpoint_id: tp.touchpointId, status_history_id: tp.historyId };
    },
});

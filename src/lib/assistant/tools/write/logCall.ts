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
//
// A WHATSAPP chat (tracker ID 79) counts as contact only with a screenshot of
// it: "dealer replied" + a screenshot the rep sent in this conversation moves
// the lead to Under discussion and resets the idle clock; without one — or
// with an image already used on another entry — it is saved as a note. The
// channel writes through recordWhatsappContact, the same writer the CRM's Log
// Touchpoint uses, so both surfaces count a chat by one rule.

import { sql } from "drizzle-orm";
import { z } from "zod";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealerLeadCommercials } from "@/lib/db/schema";
import { CONNECT_STATUS, DISPOSITION_BUCKETS } from "@/lib/leads/dispositions";
import { LEAD_STATUS, LOST_REASON, isHighImpactLostReason, type LostReason } from "@/lib/lifecycle/transitions";
import { isWorkedTouchpoint } from "@/lib/lifecycle/touchpointTypes";
import { INTEREST_LEVELS } from "@/lib/admin/salesDashboardTypes";
import { logLeadTouchpoint } from "@/lib/inside-sales/logTouchpoint";
import { markLeadLost } from "@/lib/leads/markLost";
import { setInterestLevel } from "@/lib/leads/interestLevel";
import { autoProgressForCall, COMMERCIALS_CALL_LABELS } from "@/lib/leads/autoProgress";
import {
    recordWhatsappContact,
    screenshotAlreadyUsed,
    screenshotHash,
    whatsappCounts,
} from "@/lib/leads/whatsappContact";
import { isForward } from "@/lib/lifecycle/statusRules";
import { consumeMedia, mediaBytes, mediaUrl } from "../../media";
import { AttachmentId, PlannedFile, plannedFile, resolveAttachments } from "../attachments";
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
    lost: z
        .object({
            reason: z.enum(LOST_REASON),
            notes: z.string().nullable(),
            /** ID 76: required for lost_to_competition. Optional so older pending plans still parse. */
            competitor_name: z.string().nullable().optional(),
        })
        .nullable(),
    /** UTC ISO instant. */
    follow_up_at: z.string().nullable(),
    interest: z.enum(INTEREST_LEVELS).nullable(),
    /** Which of status_to / interest came from the auto rule (audit + preview). */
    auto: z.object({ status: z.boolean(), interest: z.boolean() }).default({ status: false, interest: false }),
    /**
     * ID 79 — channel "whatsapp" only: did the dealer reply, and the screenshot
     * of the chat (with its sha256, hashed when the card was built). Optional so
     * a pending plan from before this field still parses — it is then a note.
     */
    whatsapp: z
        .object({
            dealer_replied: z.boolean(),
            screenshot: PlannedFile.extend({ sha256: z.string().length(64) }).nullable(),
        })
        .nullable()
        .optional(),
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

/**
 * ID 75.3: the hint on a commercials-type call outcome when the lead has no
 * live quote — the stage moves only with a quote, so point the rep at
 * create_quote instead of letting them think the call moved it.
 */
export const NO_QUOTE_HINT =
    "No quote in the system — this call does not move the commercials stage. " +
    "To raise one, ask me to create a quote (create_quote).";

/** Does the lead have a live (not withdrawn) quote? Errs towards "yes" — a hint, never a block. */
async function hasLiveQuote(leadId: string): Promise<boolean> {
    try {
        const rows = await db
            .select({ id: dealerLeadCommercials.commercial_id })
            .from(dealerLeadCommercials)
            .where(
                and(
                    eq(dealerLeadCommercials.dealer_lead_id, leadId),
                    inArray(dealerLeadCommercials.event_type, ["quote_issue", "quote_revision"]),
                    isNull(dealerLeadCommercials.withdrawn_at),
                ),
            )
            .limit(1);
        return rows.length > 0;
    } catch {
        return true;
    }
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
            "follow-up or interest change. A WhatsApp chat counts as contact only with a screenshot of the chat: pass the " +
            "screenshot's attachment id and whether the dealer replied; without a screenshot it is saved as a note. " +
            "Nothing is saved until the user taps Confirm on the preview.",
        schema: z
            .object({
                lead_id: LeadId,
                channel: z.enum(["call", "whatsapp", "note"]),
                connect_status: ConnectStatus.optional(),
                disposition: DispositionLabel.optional(),
                bucket: Bucket.optional(),
                status: StatusChoiceEnum.optional(),
                lost_reason: LostReasonEnum.optional(),
                competitor_name: z.string().trim().max(200).optional(),
                follow_up_at: IsoDateTime.optional(),
                interest: Interest.optional(),
                duration_minutes: z.number().int().min(0).max(600).optional(),
                remarks: Remarks.optional(),
                screenshot_attachment_id: AttachmentId.optional().describe(
                    "channel whatsapp only: the attachment id of the chat screenshot the user sent. Never invent one.",
                ),
                dealer_replied: z
                    .boolean()
                    .optional()
                    .describe("channel whatsapp only: true when the dealer replied in the chat"),
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
            // ID 79 — set for channel "whatsapp" only.
            let whatsapp: NonNullable<LogCallPlan["whatsapp"]> | null = null;
            let screenshotRef: string | null = null;
            let screenshotReused = false;

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
                    const competitor = input.competitor_name?.trim() || null;
                    if (check.lostReason === "lost_to_competition" && !competitor) {
                        return ask("Which competitor did the dealer go with?");
                    }
                    lost = { reason: check.lostReason!, notes: remarks, competitor_name: competitor };
                } else if (check.status !== NO_CHANGE && check.status !== lead.lead_status) {
                    statusTo = check.status;
                }
                // ID 80 / 114: the status on the card is what the writer will
                // do — the shared rule's, from the call outcome. A status the rep
                // stated (or "no change") cannot hold or move it; a temperature
                // they stated still wins.
                if (!lost) {
                    const derived = autoProgressForCall({
                        connected: input.connect_status === "connected",
                        label: input.disposition!,
                        bucket: input.bucket ?? null,
                        currentStatus: lead.lead_status,
                        currentInterest: lead.interest_level,
                    });
                    const stated = statusTo;
                    statusTo = derived.statusTo;
                    auto.status = !!statusTo && statusTo !== stated;
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
                if (input.channel === "note" && input.screenshot_attachment_id) {
                    return ask("A screenshot goes with a WhatsApp chat. Was this a WhatsApp chat with the dealer?");
                }
                if (input.channel === "whatsapp") {
                    let screenshot: NonNullable<LogCallPlan["whatsapp"]>["screenshot"] = null;
                    if (input.screenshot_attachment_id) {
                        const found = await resolveAttachments(ctx, [input.screenshot_attachment_id], {
                            kinds: ["image"],
                            forWrite: true,
                        });
                        if (found.result) return found.result;
                        const m = found.rows[0];
                        // What decides whether the chat counts — never assumed.
                        if (input.dealer_replied === undefined) return ask("Did the dealer reply in this chat?");
                        const bytes = await mediaBytes(m);
                        if (!bytes) return ask(`I couldn't open ${m.ref}. Could you send the screenshot again?`);
                        const sha256 = screenshotHash(bytes);
                        screenshot = { ...plannedFile(m), sha256 };
                        screenshotRef = m.ref;
                        // Checked again by the writer at Confirm — this is for the card.
                        screenshotReused = await screenshotAlreadyUsed(sha256);
                    }
                    whatsapp = { dealer_replied: input.dealer_replied ?? false, screenshot };
                }
                if (!remarks && !input.follow_up_at && !input.interest && !whatsapp?.screenshot) {
                    return ask("What should I note down?");
                }
            }

            // ID 115.4: Won → Lost only through the admin onboarding drop-out review.
            if (lost && lead.lead_status === "Won") {
                return {
                    kind: "declined",
                    reason: "This lead is Won. Only an admin can close a Won lead (onboarding drop-out review). I can log the call without closing it.",
                };
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
                whatsapp,
            };

            // ID 79 — what the WhatsApp entry will do, by the writer's own rule.
            const counts =
                !!whatsapp &&
                whatsappCounts({
                    dealerReplied: whatsapp.dealer_replied,
                    hasScreenshot: !!whatsapp.screenshot,
                    reused: screenshotReused,
                });
            const contactStatus =
                counts && lead.lead_status !== "Transferred_to_ASM" && isForward(lead.lead_status, "Under_Discussion")
                    ? "Under_Discussion"
                    : null;
            const whatsappWarning = !whatsapp
                ? null
                : screenshotReused
                  ? "This screenshot was already used on another entry. It will be saved and flagged, but NOT counted as contact."
                  : !whatsapp.screenshot
                    ? "No screenshot — this is saved as a note and does not count as contact. Send a screenshot of the chat to count it."
                    : null;

            const name = lead.shop_name || lead.dealer_name || lead.id;
            const lines: Preview["lines"] = [];
            if (whatsapp) {
                lines.push({
                    label: "WhatsApp",
                    value: counts
                        ? `dealer replied · screenshot ${screenshotRef} — counts as contact`
                        : screenshotReused
                          ? `screenshot ${screenshotRef} was used before — not counted`
                          : whatsapp.screenshot
                            ? `screenshot ${screenshotRef} · no reply from the dealer — a note`
                            : "note only (no screenshot)",
                });
            }
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
                      : contactStatus
                        ? `${statusLabel(lead.lead_status)} → ${statusLabel(contactStatus)} (auto)`
                        : "no change",
            });
            if (followUpAt) lines.push({ label: "Follow-up", value: fmtDate(followUpAt)! });
            if (interest) {
                lines.push({ label: "Temperature", value: `${lead.interest_level ?? "none"} → ${interest}${auto.interest ? " (auto)" : ""}` });
            }
            if (plan.call_duration_sec) lines.push({ label: "Duration", value: `${input.duration_minutes} min` });
            if (remarks) lines.push({ label: "Remarks", value: remarks });

            const secondConfirm = !!lost && isHighImpactLostReason(lost.reason);
            const noQuote =
                !lost &&
                !!disposition &&
                COMMERCIALS_CALL_LABELS.includes(disposition.label) &&
                !(await hasLiveQuote(lead.id));
            const preview: Preview = {
                title: `Log ${input.channel === "call" ? "call" : input.channel === "whatsapp" ? "WhatsApp" : "note"} — ${name}`,
                lines,
                resets_idle_clock: isWorkedTouchpoint(touchpointType, !!statusTo) || !!lost || counts,
                warning: secondConfirm ? highImpactConsequence(lost!.reason) : noQuote ? NO_QUOTE_HINT : whatsappWarning,
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
    apply: async ({ tx, user, step, actionId }, p) => {
        let tp: { touchpointId: string; historyId: string | null };
        let whatsappOutcome: { counted_as_contact: boolean; screenshot_reused: boolean } | null = null;
        if (p.channel === "whatsapp") {
            // ID 79 — the CRM's own WhatsApp writer: it decides (again, against
            // the rows as they are now) whether the chat counts.
            const shot = p.whatsapp?.screenshot ?? null;
            // A screenshot files once: taken by another confirmed card meanwhile
            // → the whole action is rejected, nothing written.
            if (shot) await consumeMedia(tx, [shot.media_id], actionId);
            const res = await recordWhatsappContact(tx, {
                leadId: p.lead_id,
                actorId: user.id,
                remarks: p.remarks ?? "",
                dealerReplied: p.whatsapp?.dealer_replied ?? false,
                screenshot: shot ? { url: mediaUrl(shot.storage_bucket, shot.storage_key), sha256: shot.sha256 } : null,
                nextActionAt: p.follow_up_at ? new Date(p.follow_up_at) : null,
            });
            // The follow-up the queue reads — what logLeadTouchpoint sets for a call.
            if (p.follow_up_at) {
                await tx.execute(sql`
                    UPDATE dealer_leads SET next_follow_up_at = ${p.follow_up_at}, updated_at = NOW()
                     WHERE id = ${p.lead_id}
                `);
            }
            tp = { touchpointId: res.touchpointId, historyId: null };
            whatsappOutcome = { counted_as_contact: res.countedAsContact, screenshot_reused: res.reused };
        } else {
            tp = await logLeadTouchpoint(
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
                        // No status_change (ID 80): the call's outcome moves the
                        // status in the writer, by the same rule the preview used.
                        // The temperature is whatever the rep CONFIRMED on the
                        // preview (p.interest, written below) — null here stops the
                        // writer deriving one the preview never showed.
                        interest_level: null,
                        ...(p.follow_up_at ? { follow_up_at: p.follow_up_at } : {}),
                    },
                },
                { tx },
            );
        }
        if (p.lost) {
            await markLeadLost(
                {
                    leadId: p.lead_id,
                    actor: { id: user.id, role: user.role },
                    reason: p.lost.reason,
                    notes: p.lost.notes,
                    competitorName: p.lost.competitor_name ?? null,
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
        return { touchpoint_id: tp.touchpointId, status_history_id: tp.historyId, ...(whatsappOutcome ?? {}) };
    },
});

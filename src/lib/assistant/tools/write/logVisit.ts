// log_visit — an ASM's field visit and what comes next (BRD §9.2, UC-01).
// PROPOSES only: resolves the visit against the frozen §9.3 visit rows, stores
// the plan as a pending action with a preview, returns the preview. On Confirm,
// logVisitApplier writes ALL of it in the executor's one transaction:
//   visit row + visit touchpoint + scheduled next visit   recordVisit (the visit route's writer)
//   interest change                                       setInterestLevel
//   status after a done visit (ends Awaiting field visit)  applyVisitStatus (ID 77)
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
import { applyVisitStatus } from "@/lib/asm/visitStatus";
import { markLeadLost } from "@/lib/leads/markLost";
import { setInterestLevel } from "@/lib/leads/interestLevel";
import { autoProgressForVisit } from "@/lib/leads/autoProgress";
import { statusAfterVisit } from "@/lib/leads/outcomeRule";
import { checkVisitProposal, NO_CHANGE, type StatusChoice } from "../../vocab";
import { createPending } from "../../actions";
import { istNow } from "../../prompt";
import { fmtDate, reasonLabel, statusLabel } from "../../format";
import type { Preview, ToolResult } from "../../types";
import { defineTool, LeadId, ownedLeadOr, type ToolFactory } from "../spec";
import { leadUrl } from "../leads";
import { defineApplier } from "../../applierSpec";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { consumeMedia, mediaUrl } from "../../media";
import { checkPinAgainstShop, fmtDistance } from "../../geo";
import { AttachmentId, PlannedFile, plannedFile, resolveAttachments } from "../attachments";
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
    /** E-311 — photos the ASM sent, filed on the visit (lead_visits.photos + the visit touchpoint). */
    photos: z.array(PlannedFile).default([]),
    /** E-311 — the ASM's location pin as the visit's GPS check-in, and how far it was from the shop. */
    gps: z
        .object({
            media_id: z.string().uuid(),
            lat: z.number(),
            lng: z.number(),
            /** The line added to the visit remarks, e.g. "📍 WhatsApp location: 3.2 km from the shop address". */
            note: z.string(),
        })
        .nullable()
        .default(null),
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
            "To only schedule a visit, use set_follow_up. Photos (photo_ids) and a location pin (location_id) the ASM sent " +
            "are filed on a completed visit as proof. Nothing is saved until Confirm.",
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
                photo_ids: z.array(AttachmentId).max(10).optional(),
                location_id: AttachmentId.optional(),
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
                // ID 80: the card shows what the writer will do — the rule's
                // status, whatever the rep asked for ("no change" included).
                // statusAfterVisit is the writer's own function: a done visit
                // on a lead Awaiting field visit ends that status whatever the
                // outcome (ID 77), going back to the stage it had before the
                // transfer when that is further along — so the card needs the
                // pre-transfer stage, read only in that case.
                //
                // A stated status the rule does not produce is dropped, not
                // shown: the visit route sends no status to the writer, so a
                // card saying "Commercials explained → Under discussion" would
                // promise a move that never happens.
                statusTo = null;
                if (visited) {
                    let preTransfer: string | null = null;
                    if (lead.lead_status === "Transferred_to_ASM") {
                        const [row] = await db.execute<{ pre_transfer_status: string | null }>(
                            sql`SELECT pre_transfer_status FROM dealer_leads WHERE id = ${lead.id}`,
                        );
                        preTransfer = row?.pre_transfer_status ?? null;
                    }
                    const after = statusAfterVisit({
                        current: lead.lead_status,
                        preTransfer,
                        requested: derived.statusTo,
                    });
                    if (after) {
                        statusTo = after;
                        auto.status = true;
                    }
                }
                if (!input.interest && derived.interestTo) {
                    interest = derived.interestTo;
                    auto.interest = true;
                }
            }

            // Photos and the pin are proof of a visit that happened.
            const photoRefs = input.photo_ids ?? [];
            if ((photoRefs.length || input.location_id) && !visited) {
                return ask("Photos and location are saved on a visit that happened. Did you meet the dealer?");
            }
            let photos: LogVisitPlan["photos"] = [];
            if (photoRefs.length) {
                const found = await resolveAttachments(ctx, photoRefs, { kinds: ["image"], forWrite: true });
                if (found.result) return found.result;
                photos = found.rows.map(plannedFile);
            }
            let gps: LogVisitPlan["gps"] = null;
            let gpsLine: string | null = null;
            let gpsWarning: string | null = null;
            if (input.location_id) {
                const found = await resolveAttachments(ctx, [input.location_id], { kinds: ["location"], forWrite: true });
                if (found.result) return found.result;
                const pin = found.rows[0];
                const [addr] = await db.execute<{ area: string | null; pincode: string | null }>(
                    sql`SELECT area, pincode FROM dealer_leads WHERE id = ${lead.id}`,
                );
                const check = await checkPinAgainstShop(
                    { lat: pin.latitude!, lng: pin.longitude! },
                    { area: addr?.area, city: lead.city, state: lead.state, pincode: addr?.pincode },
                );
                gpsLine =
                    check.kind === "unmapped"
                        ? "saved (shop address not mapped)"
                        : check.kind === "near"
                          ? `at the shop (${fmtDistance(check.meters)})`
                          : `⚠ ${fmtDistance(check.meters)} from the shop address`;
                if (check.kind === "far") gpsWarning = `The location is ${fmtDistance(check.meters)} from the shop's address.`;
                gps = { media_id: pin.id, lat: pin.latitude!, lng: pin.longitude!, note: `📍 WhatsApp location: ${gpsLine}` };
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
                photos,
                gps,
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
            if (photos.length) lines.push({ label: "📷 Photos", value: String(photos.length) });
            if (gpsLine) lines.push({ label: "📍 Location", value: gpsLine });

            const warnings: string[] = [];
            const secondConfirm = !!lost && isHighImpactLostReason(lost.reason);
            if (secondConfirm) warnings.push(highImpactConsequence(lost!.reason));
            if (nextVisit && lead.asm_id !== ctx.user.id) {
                warnings.push("This lead's field ASM isn't set to you, so the next visit won't show in your Today's Schedule.");
            }
            if (plan.next_action === "escalate") warnings.push("Raise the escalation itself on the CRM screen.");
            if (gpsWarning) warnings.push(gpsWarning);

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
    apply: async ({ tx, user, step, actionId }, p) => {
        // A visit is an ASM's; the plan is bound to the role that proposed it.
        if (user.role !== "asm") throw new Error("visit plan does not match the user's role");
        await consumeMedia(tx, [...p.photos.map((f) => f.media_id), ...(p.gps ? [p.gps.media_id] : [])], actionId);
        const visit = await recordVisit(
            {
                leadId: p.lead_id,
                asmId: user.id,
                visit_status: p.visit_status,
                visit_outcome: p.visit_outcome,
                // Passed explicitly: recordVisit's own default is the UTC date.
                actual_visit_date: p.visit_date,
                visit_remarks: p.gps ? `${p.remarks}\n${p.gps.note}` : p.remarks,
                next_action: p.next_action,
                next_visit_date: p.next_visit_date,
                ...(p.photos.length ? { photos: p.photos.map((f) => mediaUrl(f.storage_bucket, f.storage_key)) } : {}),
                ...(p.gps ? { gps_check_in_lat: p.gps.lat, gps_check_in_lng: p.gps.lng } : {}),
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
        // ID 77: a DONE visit ends Awaiting field visit (restoring the
        // pre-transfer stage when further along); otherwise the visit OUTCOME
        // moves the lead, by the shared rule, derived on the server exactly as
        // the visit route does (ID 80 / 114) — p.status_to is what the card
        // previewed, not an instruction. The temperature was written above
        // from what the rep confirmed, so the rule is told to leave it.
        if (p.visit_status === "visited" && !p.lost) {
            const r = await applyVisitStatus(tx, {
                leadId: p.lead_id,
                actorId: user.id,
                requested: null,
                outcome: p.visit_outcome,
                interest: null,
                remarks: `After the visit on ${p.visit_date}: ${p.remarks}`,
            });
            statusHistoryId = r.historyId;
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

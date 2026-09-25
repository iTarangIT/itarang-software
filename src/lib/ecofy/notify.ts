// Ecofy workspace notifications (E-307) — every event, bell + email via emit().
//
// Recipients:
//   owner     the ASM / ISR the lead is assigned to (href under their prefix)
//   managers  every active Sales Head (href under /sales-head/ecofy)
// The person who acted is never notified about their own action.
// Types are registered in src/lib/notifications/{catalog,registry}.ts.
//
// Best-effort by contract: nothing here may fail the action that triggered it.

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { ecofyLeads, users } from "@/lib/db/schema";
import { errorMessage } from "@/lib/api-utils";
import { emit, type Recipient } from "@/lib/notifications/emit";
import { adminParty, SYSTEM_PARTY, type Party } from "@/lib/notifications/provenance";
import { ECOFY_NOTIFY_MANAGER_ROLES, ECOFY_STAGE_LABELS, ecofyLeadHref } from "./access";
import type { EcofyActionInput } from "./actionSchemas";

const STAGE = "Ecofy";

export interface EcofyNotifyLead {
    id: string;
    case_no: string | null;
    customer_name: string | null;
    temperature: string | null;
    stage: string | null;
    assigned_to_user_id: string | null;
    assigned_role: string | null;
}

export interface EcofyNotifyActor {
    id: string;
    name: string | null;
    role: string | null;
}

const ecofyParty: Party = { party: "system", label: "Ecofy" };

function leadName(l: EcofyNotifyLead): string {
    const who = l.customer_name || "Customer";
    return l.case_no ? `${who} (${l.case_no})` : who;
}

function stageName(s: string | null | undefined): string {
    if (!s) return "—";
    return ECOFY_STAGE_LABELS[s] ? `${s} ${ECOFY_STAGE_LABELS[s]}` : s;
}

async function loadLead(leadId: string): Promise<EcofyNotifyLead | null> {
    const [row] = await db
        .select({
            id: ecofyLeads.id,
            case_no: ecofyLeads.case_no,
            customer_name: ecofyLeads.customer_name,
            temperature: ecofyLeads.temperature,
            stage: ecofyLeads.stage,
            assigned_to_user_id: ecofyLeads.assigned_to_user_id,
            assigned_role: ecofyLeads.assigned_role,
        })
        .from(ecofyLeads)
        .where(eq(ecofyLeads.id, leadId))
        .limit(1);
    return row ?? null;
}

/** Active Sales Heads as individual audiences, so the actor can be left out. */
async function managerRecipients(lead: EcofyNotifyLead, exceptUserId?: string | null): Promise<Recipient[]> {
    const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(
            and(
                inArray(sql`LOWER(${users.role})`, [...ECOFY_NOTIFY_MANAGER_ROLES]),
                eq(users.is_active, true),
            ),
        );
    return rows
        .filter((r) => r.id !== exceptUserId)
        .map((r) => ({
            audience: { kind: "user" as const, userId: r.id },
            as: adminParty(),
            href: ecofyLeadHref("sales_head", lead.id),
        }));
}

function ownerRecipient(lead: EcofyNotifyLead, exceptUserId?: string | null): Recipient[] {
    if (!lead.assigned_to_user_id || lead.assigned_to_user_id === exceptUserId) return [];
    return [
        {
            audience: { kind: "user", userId: lead.assigned_to_user_id },
            as: adminParty(),
            href: ecofyLeadHref(lead.assigned_role, lead.id),
        },
    ];
}

async function send(p: {
    type: string;
    title: string;
    message: string;
    lead: EcofyNotifyLead;
    from: Party;
    toOwner: boolean;
    toManagers: boolean;
    exceptUserId?: string | null;
    data?: Record<string, unknown>;
}): Promise<void> {
    try {
        const to: Recipient[] = [
            ...(p.toOwner ? ownerRecipient(p.lead, p.exceptUserId) : []),
            ...(p.toManagers ? await managerRecipients(p.lead, p.exceptUserId) : []),
        ];
        if (to.length === 0) return;
        await emit({
            type: p.type,
            title: p.title,
            message: p.message,
            leadId: p.lead.id,
            stage: STAGE,
            from: p.from,
            to,
            data: { ecofy_lead_id: p.lead.id, case_no: p.lead.case_no, stage: p.lead.stage, ...p.data },
        });
    } catch (err) {
        console.error(`[Ecofy/notify] ${p.type} failed:`, errorMessage(err));
    }
}

const actorParty = (a: EcofyNotifyActor): Party => adminParty(a.name ? `${a.name}` : null);

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

export async function notifyEcofyAssigned(p: {
    leadId: string;
    fromUserId: string | null;
    reason?: string | null;
    actor: EcofyNotifyActor;
}): Promise<void> {
    const lead = await loadLead(p.leadId);
    if (!lead) return;
    const hot = lead.temperature === "HOT";
    await send({
        type: "ecofy.lead_assigned",
        title: hot ? "Hot Ecofy lead assigned to you" : "Ecofy lead assigned to you",
        message: `${leadName(lead)} — ${stageName(lead.stage)}. Call the customer and log it on the lead.`,
        lead,
        from: actorParty(p.actor),
        toOwner: true,
        toManagers: false,
        exceptUserId: p.actor.id,
        data: { reason: p.reason ?? null },
    });
    if (p.fromUserId && p.fromUserId !== lead.assigned_to_user_id && p.fromUserId !== p.actor.id) {
        try {
            await emit({
                type: "ecofy.lead_unassigned",
                title: "Ecofy lead moved to someone else",
                message: `${leadName(lead)} was reassigned${p.reason ? `: ${p.reason}` : "."}`,
                leadId: lead.id,
                stage: STAGE,
                from: actorParty(p.actor),
                to: [{ audience: { kind: "user", userId: p.fromUserId }, as: adminParty() }],
            });
        } catch (err) {
            console.error("[Ecofy/notify] unassigned failed:", errorMessage(err));
        }
    }
}

// ---------------------------------------------------------------------------
// CRM actions (after a successful Ecofy call)
// ---------------------------------------------------------------------------

type Spec = { type: string; title: string; toOwner: boolean; toManagers: boolean };

function specFor(input: EcofyActionInput): Spec {
    switch (input.action) {
        case "log_activity":
            return {
                type: "ecofy.activity_logged",
                title: input.type === "CALL" ? `Call logged — ${input.callOutcome}` : `${input.type.replace("_", "-").toLowerCase()} logged`,
                toOwner: true,
                toManagers: true,
            };
        case "book_appointment":
            return { type: "ecofy.appointment_updated", title: `Meeting booked (${input.meetingType.replace("_", " ").toLowerCase()})`, toOwner: true, toManagers: true };
        case "update_appointment":
            return { type: "ecofy.appointment_updated", title: `Meeting ${input.op.replace("_", "-").toLowerCase()}`, toOwner: true, toManagers: true };
        case "advance":
            return { type: "ecofy.stage_changed", title: "Moved to assessment", toOwner: true, toManagers: true };
        case "save_assessment":
            return { type: "ecofy.assessment_updated", title: "Assessment saved", toOwner: true, toManagers: true };
        case "confirm_assessment":
            return { type: "ecofy.assessment_updated", title: "Assessment confirmed — at offer stage", toOwner: true, toManagers: true };
        case "request_eligibility":
            return { type: "ecofy.eligibility_requested", title: "Eligibility check requested", toOwner: true, toManagers: true };
        case "eligibility_decision":
            return { type: "ecofy.eligibility_decided", title: `Eligibility: ${input.status.replace("_", " ").toLowerCase()}`, toOwner: true, toManagers: true };
        case "quote_request":
        case "update_quote_request":
            return { type: "ecofy.quote_updated", title: "EPC quote request updated", toOwner: true, toManagers: true };
        case "compose_offer":
            return { type: "ecofy.offer_sent", title: "Offer composed", toOwner: true, toManagers: true };
        case "send_otp":
            return { type: "ecofy.offer_sent", title: "Offer sent — OTP with the customer", toOwner: true, toManagers: true };
        case "verify_otp":
            return { type: "ecofy.file_locked", title: "Customer accepted — File locked", toOwner: true, toManagers: true };
        case "create_installation":
        case "update_installation":
            return { type: "ecofy.installation_updated", title: "Installation updated", toOwner: true, toManagers: true };
        case "request_withdrawal":
            return { type: "ecofy.withdrawal_requested", title: "Withdrawal requested", toOwner: true, toManagers: true };
        case "withdrawal_confirm":
            return { type: "ecofy.withdrawal_decided", title: "Withdrawal confirmed", toOwner: true, toManagers: true };
        case "withdrawal_reject":
            return { type: "ecofy.withdrawal_decided", title: "Withdrawal rejected", toOwner: true, toManagers: true };
        case "withdrawal_epc_informed":
            return { type: "ecofy.withdrawal_decided", title: "Withdrawal — EPC informed", toOwner: true, toManagers: true };
        case "close":
            return { type: "ecofy.lead_closed", title: `Lead closed (${input.closureReason.replace(/_/g, " ").toLowerCase()})`, toOwner: true, toManagers: true };
        case "return":
            return { type: "ecofy.lead_returned", title: `Returned to Ecofy (${input.reasonCode.replace(/_/g, " ").toLowerCase()})`, toOwner: true, toManagers: true };
        case "reopen":
            return { type: "ecofy.lead_reopened", title: "Lead reopened", toOwner: true, toManagers: true };
        case "route_financier":
            return { type: "ecofy.financing_updated", title: "Routed to the next financier", toOwner: true, toManagers: true };
        case "financing_decision":
            return { type: "ecofy.financing_updated", title: `Financing ${input.status.toLowerCase()}`, toOwner: true, toManagers: true };
        case "down_payment":
            return { type: "ecofy.financing_updated", title: "Down payment recorded", toOwner: true, toManagers: true };
        case "disbursement":
            return { type: "ecofy.financing_updated", title: "Disbursement recorded — asset active", toOwner: true, toManagers: true };
        case "delete_document":
            return { type: "ecofy.document_updated", title: "Document deleted", toOwner: true, toManagers: true };
    }
}

export async function notifyEcofyAction(p: {
    leadId: string;
    input: EcofyActionInput;
    actor: EcofyNotifyActor;
    fromStage: string | null;
    toStage: string | null;
}): Promise<void> {
    const lead = await loadLead(p.leadId);
    if (!lead) return;
    const spec = specFor(p.input);
    const moved = p.fromStage && p.toStage && p.fromStage !== p.toStage ? ` Stage ${p.fromStage} → ${stageName(p.toStage)}.` : "";
    const note = "note" in p.input && typeof p.input.note === "string" && p.input.note ? ` "${p.input.note.slice(0, 140)}"` : "";
    await send({
        type: spec.type,
        title: spec.title,
        message: `${leadName(lead)} — by ${p.actor.name ?? "someone"}.${moved}${note}`,
        lead,
        from: actorParty(p.actor),
        toOwner: spec.toOwner,
        toManagers: spec.toManagers,
        exceptUserId: p.actor.id,
        data: { action: p.input.action, from_stage: p.fromStage, to_stage: p.toStage },
    });
}

export async function notifyEcofyUpload(p: {
    leadId: string;
    actor: EcofyNotifyActor;
    kind: "document" | "quote";
    fileName: string;
}): Promise<void> {
    const lead = await loadLead(p.leadId);
    if (!lead) return;
    await send({
        type: p.kind === "quote" ? "ecofy.quote_updated" : "ecofy.document_updated",
        title: p.kind === "quote" ? "EPC quote uploaded" : "Document uploaded",
        message: `${leadName(lead)} — ${p.fileName}, by ${p.actor.name ?? "someone"}.`,
        lead,
        from: actorParty(p.actor),
        toOwner: true,
        toManagers: true,
        exceptUserId: p.actor.id,
    });
}

// ---------------------------------------------------------------------------
// Events pushed by Ecofy
// ---------------------------------------------------------------------------

export async function notifyEcofyInbound(p: {
    leadId: string;
    eventType: string;
    previousStage: string | null;
    stage: string | null;
    created: boolean;
    reason?: string | null;
}): Promise<void> {
    const lead = await loadLead(p.leadId);
    if (!lead) return;

    if (p.eventType === "lead.pushed") {
        const hot = lead.temperature === "HOT";
        await send({
            type: "ecofy.lead_received",
            title: hot ? "New HOT lead from Ecofy" : "New lead from Ecofy",
            message: `${leadName(lead)} is in the Ecofy pickup queue — assign it to an ASM or ISR.`,
            lead,
            from: ecofyParty,
            toOwner: false,
            toManagers: true,
            data: { href_list: "/sales-head/ecofy/queue" },
        });
        return;
    }

    // Stage changes the CRM caused are echoed back by Ecofy; by then the local
    // row already carries the new stage (refreshLeadFromEcofy), so nothing moved.
    if (p.previousStage === p.stage) return;

    const to = p.stage;
    const spec =
        to === "CLOSED"
            ? { type: "ecofy.lead_closed", title: `Ecofy closed the lead${p.reason ? ` (${p.reason})` : ""}` }
            : to === "S0"
              ? { type: "ecofy.lead_returned", title: `Lead went back to Ecofy${p.reason ? ` (${p.reason})` : ""}` }
              : to === "S6" || to === "S7" || to === "S8"
                ? { type: "ecofy.financing_updated", title: `Ecofy moved the lead to ${stageName(to)}` }
                : { type: "ecofy.stage_changed", title: `Lead moved to ${stageName(to)}` };
    await send({
        type: spec.type,
        title: spec.title,
        message: `${leadName(lead)} — ${stageName(p.previousStage)} → ${stageName(to)}.`,
        lead,
        from: ecofyParty,
        toOwner: true,
        toManagers: true,
        data: { from_stage: p.previousStage, to_stage: to },
    });
}

// ---------------------------------------------------------------------------
// Reminders (ticker) and integration health
// ---------------------------------------------------------------------------

export async function notifyEcofyReminder(p: {
    leadId: string;
    kind: "follow_up" | "appointment";
    at: Date;
}): Promise<void> {
    const lead = await loadLead(p.leadId);
    if (!lead) return;
    const when = p.at.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
    await send({
        type: p.kind === "follow_up" ? "ecofy.follow_up_due" : "ecofy.appointment_reminder",
        title: p.kind === "follow_up" ? "Ecofy follow-up due" : "Ecofy meeting within the hour",
        message: `${leadName(lead)} — ${p.kind === "follow_up" ? "follow-up" : "meeting"} at ${when}.`,
        lead,
        from: SYSTEM_PARTY,
        // No owner yet → the Sales Head is the one who has to act on it.
        toOwner: true,
        toManagers: !lead.assigned_to_user_id,
    });
}

const recentFailures = new Map<string, number>();
const FAILURE_DEDUPE_MS = 10 * 60 * 1000;

/** Ecofy unreachable / 5xx. De-duplicated per (kind) for 10 minutes. */
export async function notifyEcofySyncFailed(p: { kind: string; detail: string; leadId?: string | null }): Promise<void> {
    const key = p.kind;
    const now = Date.now();
    if ((recentFailures.get(key) ?? 0) > now - FAILURE_DEDUPE_MS) return;
    recentFailures.set(key, now);
    try {
        await emit({
            type: "ecofy.sync_failed",
            title: "Ecofy sync problem",
            message: `${p.kind}: ${p.detail.slice(0, 300)}`,
            leadId: p.leadId ?? null,
            stage: STAGE,
            from: SYSTEM_PARTY,
            to: [
                {
                    audience: { kind: "roles", roles: ["admin", ...ECOFY_NOTIFY_MANAGER_ROLES] },
                    as: adminParty(),
                    href: p.leadId ? ecofyLeadHref("sales_head", p.leadId) : "/sales-head/ecofy",
                },
            ],
        });
    } catch (err) {
        console.error("[Ecofy/notify] sync_failed failed:", errorMessage(err));
    }
}

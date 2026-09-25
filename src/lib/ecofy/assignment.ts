// Sales Head → ASM / ISR assignment of Ecofy leads (E-307).
//
// The Sales Head decides who handles an Ecofy lead, in the CRM alone:
// ecofy_leads.assigned_to_user_id is written and the ASM / ISR is notified
// whatever Ecofy says. Ecofy cannot assign to CRM people anyway.
//
// AFTERWARDS, best-effort, Ecofy is told through the §4 `lead.assigned` event
// (assigns the case to the integration user and moves S1 → S2; later on it just
// records a remark). Ecofy is never told WHO in the CRM got the lead — the
// event says "iTarang team" (access.ts ECOFY_OUTBOUND_ASSIGNEE). If Ecofy
// refuses or is down, the assignment stands, the refusal is reported back as
// `ecofyNotUpdated`, and the reminder ticker retries every 5 minutes.

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { ecofyLeadAssignments, ecofyLeads, users } from "@/lib/db/schema";
import { errorMessage } from "@/lib/api-utils";
import { ECOFY_OUTBOUND_ASSIGNEE, ECOFY_WORKER_ROLES } from "./access";
import { sendEcofyEvent } from "./outbound";
import { refreshLeadFromEcofy } from "./service";
import { notifyEcofyAssigned, type EcofyNotifyActor } from "./notify";

export interface EcofyAssignee {
    id: string;
    name: string;
    email: string | null;
    role: string;
}

/** Active ASMs and ISRs, for the assign picker. */
export async function listEcofyAssignees(): Promise<EcofyAssignee[]> {
    const rows = await db
        .select({ id: users.id, name: users.name, email: users.email, role: users.role })
        .from(users)
        .where(and(inArray(sql`LOWER(${users.role})`, [...ECOFY_WORKER_ROLES]), eq(users.is_active, true)))
        .orderBy(users.name);
    return rows.map((r) => ({ ...r, role: r.role.toLowerCase() }));
}

export class EcofyAssignError extends Error {
    constructor(message: string, public status = 400) {
        super(message);
        this.name = "EcofyAssignError";
    }
}

export interface AssignResult {
    assigned: string[];
    skipped: Array<{ leadId: string; caseNo: string | null; reason: string }>;
    /** Assigned in the CRM, but Ecofy did not accept the `lead.assigned` event. */
    ecofyNotUpdated: Array<{ leadId: string; caseNo: string | null; reason: string }>;
}

export async function assignEcofyLeads(p: {
    leadIds: string[];
    targetUserId: string;
    reason?: string | null;
    actor: EcofyNotifyActor;
}): Promise<AssignResult> {
    const [target] = await db
        .select({ id: users.id, name: users.name, role: users.role, is_active: users.is_active })
        .from(users)
        .where(eq(users.id, p.targetUserId))
        .limit(1);
    const targetRole = target?.role?.toLowerCase() ?? "";
    if (!target || !target.is_active || !(ECOFY_WORKER_ROLES as readonly string[]).includes(targetRole)) {
        throw new EcofyAssignError("Pick an active ASM or ISR");
    }

    const leads = await db
        .select({
            id: ecofyLeads.id,
            ecofy_case_id: ecofyLeads.ecofy_case_id,
            case_no: ecofyLeads.case_no,
            stage: ecofyLeads.stage,
            assigned_to_user_id: ecofyLeads.assigned_to_user_id,
        })
        .from(ecofyLeads)
        .where(inArray(ecofyLeads.id, p.leadIds));

    const result: AssignResult = { assigned: [], skipped: [], ecofyNotUpdated: [] };
    const found = new Set(leads.map((l) => l.id));
    for (const id of p.leadIds) {
        if (!found.has(id)) result.skipped.push({ leadId: id, caseNo: null, reason: "Lead not found" });
    }

    for (const lead of leads) {
        const skip = (reason: string) => result.skipped.push({ leadId: lead.id, caseNo: lead.case_no, reason });
        if (!lead.stage || lead.stage === "S0" || lead.stage === "CLOSED") {
            skip(lead.stage === "CLOSED" ? "Lead is closed" : "Lead is back with Ecofy");
            continue;
        }
        if (lead.assigned_to_user_id === target.id) {
            skip(`Already with ${target.name}`);
            continue;
        }
        const reassign = Boolean(lead.assigned_to_user_id);
        if (reassign && !(p.reason && p.reason.trim().length >= 3)) {
            skip("A reason is required to reassign");
            continue;
        }

        // 1. The CRM decision — independent of Ecofy.
        await db.transaction(async (tx) => {
            await tx
                .update(ecofyLeads)
                .set({
                    assigned_to_user_id: target.id,
                    assigned_role: targetRole,
                    assigned_by: p.actor.id,
                    assigned_at: new Date(),
                    updated_at: new Date(),
                })
                .where(eq(ecofyLeads.id, lead.id));
            await tx.insert(ecofyLeadAssignments).values({
                ecofy_lead_id: lead.id,
                from_user_id: lead.assigned_to_user_id,
                to_user_id: target.id,
                to_role: targetRole,
                reason: p.reason?.trim() || null,
                assigned_by: p.actor.id,
            });
        });
        result.assigned.push(lead.id);

        await notifyEcofyAssigned({
            leadId: lead.id,
            fromUserId: lead.assigned_to_user_id,
            reason: p.reason,
            actor: p.actor,
        });

        // 2. Tell Ecofy, best-effort. Never undoes step 1. If Ecofy refuses or
        //    is down, the reminder ticker retries (retryPendingEcofyAssignments).
        const pushed = await pushAssignmentToEcofy(lead, p.reason);
        if (!pushed.ok) result.ecofyNotUpdated.push({ leadId: lead.id, caseNo: lead.case_no, reason: pushed.reason });
    }
    return result;
}

export interface EcofyAssignmentLeadRef {
    id: string;
    ecofy_case_id: string;
    case_no: string | null;
    stage: string | null;
}

/**
 * Tell Ecofy that iTarang has taken the case (§4 `lead.assigned`). At S1 Ecofy
 * assigns the case to the integration user and moves it to S2; later on it
 * only records a remark. The payload never names the CRM person: Ecofy sees
 * "iTarang team" / "iTarang CRM" (see access.ts). The free-text reason is the
 * Sales Head's own words and is passed through as typed.
 *
 * Never throws; `{ ok: false, reason }` says why Ecofy was not updated.
 */
export async function pushAssignmentToEcofy(
    lead: EcofyAssignmentLeadRef,
    reason?: string | null,
): Promise<{ ok: boolean; reason: string; unavailable: boolean }> {
    try {
        const sent = await sendEcofyEvent({
            type: "lead.assigned",
            ecofyCaseId: lead.ecofy_case_id,
            crmLeadId: lead.id,
            data: { assigneeName: ECOFY_OUTBOUND_ASSIGNEE, ...(reason?.trim() ? { reason: reason.trim() } : {}) },
        });
        if (sent.ok || sent.duplicate) {
            await refreshLeadFromEcofy(lead);
            return { ok: true, reason: "", unavailable: false };
        }
        const message =
            (sent.body as { error?: { message?: string } } | null)?.error?.message ??
            (sent.status ? `Ecofy answered ${sent.status}` : "Ecofy unreachable");
        // 401/403 = act-as user not accepted (config), 5xx/timeout = down: both
        // are worth retrying later. 409/422 are final for this lead.
        const unavailable = sent.status === null || sent.status === 401 || sent.status === 403 || sent.status >= 500;
        return { ok: false, reason: message, unavailable };
    } catch (err) {
        return { ok: false, reason: errorMessage(err), unavailable: true };
    }
}

/**
 * Ticker step: leads the Sales Head assigned in the CRM while Ecofy still shows
 * S1 (the `lead.assigned` event was refused or never arrived). Re-sends the
 * event, oldest assignment first, and stops at the first "Ecofy unavailable"
 * answer so one outage does not burn the whole batch. A new eventId per retry
 * is safe: Ecofy dedupes by eventId only and, once past S1, merely logs a remark.
 */
export async function retryPendingEcofyAssignments(limit = 25): Promise<{ retried: number; synced: number }> {
    const pending = await db
        .select({
            id: ecofyLeads.id,
            ecofy_case_id: ecofyLeads.ecofy_case_id,
            case_no: ecofyLeads.case_no,
            stage: ecofyLeads.stage,
        })
        .from(ecofyLeads)
        .where(and(eq(ecofyLeads.stage, "S1"), sql`${ecofyLeads.assigned_to_user_id} IS NOT NULL`))
        .orderBy(ecofyLeads.assigned_at)
        .limit(limit);

    let retried = 0;
    let synced = 0;
    for (const lead of pending) {
        retried += 1;
        const pushed = await pushAssignmentToEcofy(lead, null);
        if (pushed.ok) synced += 1;
        else if (pushed.unavailable) break;
    }
    return { retried, synced };
}

export async function listAssignmentHistory(leadId: string) {
    return db.execute<{
        id: string;
        created_at: string;
        reason: string | null;
        to_role: string | null;
        from_name: string | null;
        to_name: string | null;
        by_name: string | null;
    }>(sql`
        SELECT a.id::text AS id, a.created_at, a.reason, a.to_role,
               fu.name AS from_name, tu.name AS to_name, bu.name AS by_name
        FROM ecofy_lead_assignments a
        LEFT JOIN users fu ON fu.id = a.from_user_id
        LEFT JOIN users tu ON tu.id = a.to_user_id
        LEFT JOIN users bu ON bu.id::text = a.assigned_by
        WHERE a.ecofy_lead_id = ${leadId}::uuid
        ORDER BY a.created_at DESC
    `);
}

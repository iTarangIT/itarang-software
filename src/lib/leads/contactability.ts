// Contactability is its own flag, not a status (tracker ID 36, handover P2-12,
// 29 Sep 2026).
//
//   dead_number     a call outcome says the number is wrong / not in use.
//   non_responsive  6 calls on 6 different days within 45 days, none connected
//                   (nonResponsive.ts — the same rule the reports use).
//
// Either is recorded as an EVENT (dealer_leads.contactability*, E-314, and a
// "Contactability" touchpoint). The lead keeps its owner of record and its
// status, leaves working counts and queues ("Hide dead & disqualified" is on
// by default), and goes to the Number Repair queue. Source reports always
// count it. A connected call, or a repaired number, clears the flag.
//
// Applies to every entry point: the CRM call form, NeoDove, the AI dialer and
// the WhatsApp Assistant all end in reviewLeadContactability() after a call.
// Best-effort: a call is never refused because the flag could not be written.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { nonResponsiveSql } from "@/lib/leads/nonResponsive";
import { normalizePhone } from "@/lib/leads/dedupe-rules";
import { loadExistingByPhone } from "@/lib/leads/dedupe";
import { markLeadLost } from "@/lib/leads/markLost";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type Contactability = "dead_number" | "non_responsive";

export const DEAD_NUMBER_REASONS: readonly string[] = [
    "Incorrect / Invalid number",
    "Number not in use / does not exist / out of service",
];

export const CONTACTABILITY_LABEL: Record<Contactability, string> = {
    dead_number: "Dead number",
    non_responsive: "Non-responsive (6 calls on 6 days, 45 days, no answer)",
};

/** The owner of record's name, for the event remark ("owner kept: Priya"). */
async function ownerLabel(tx: Tx, leadId: string): Promise<string> {
    const r = (await tx.execute<{ owner_name: string | null; current_owner_id: string | null }>(sql`
        SELECT dl.current_owner_id, u.name AS owner_name
          FROM dealer_leads dl
          LEFT JOIN users u ON u.id::text = dl.current_owner_id
         WHERE dl.id = ${leadId}
         LIMIT 1
    `)) as unknown as Array<{ owner_name: string | null; current_owner_id: string | null }>;
    const row = r[0];
    if (!row?.current_owner_id) return "no owner";
    return row.owner_name?.trim() || row.current_owner_id;
}

async function setFlag(
    tx: Tx,
    leadId: string,
    kind: Contactability,
    reason: string,
    actorId: string | null,
): Promise<boolean> {
    const r = (await tx.execute<{ id: string }>(sql`
        UPDATE dealer_leads
           SET contactability = ${kind}, contactability_at = NOW(), contactability_reason = ${reason}
         WHERE id = ${leadId} AND contactability IS DISTINCT FROM ${kind}
        RETURNING id
    `)) as unknown as Array<{ id: string }>;
    if (!r[0]) return false;
    const owner = await ownerLabel(tx, leadId);
    await writeTouchpoint({
        dealerLeadId: leadId,
        touchpointType: "contactability_flag",
        // The person whose call raised the flag (null = AI dialer / system).
        performedBy: actorId,
        remarks: `${CONTACTABILITY_LABEL[kind]} — ${reason}. Moved to Number Repair; the owner is kept (${owner}).`,
        syncMethod: "system",
    }, { tx });
    return true;
}

async function clearFlag(tx: Tx, leadId: string, actorId: string | null): Promise<boolean> {
    const r = (await tx.execute<{ id: string }>(sql`
        UPDATE dealer_leads
           SET contactability = NULL, contactability_at = NULL, contactability_reason = NULL
         WHERE id = ${leadId} AND contactability IS NOT NULL
        RETURNING id
    `)) as unknown as Array<{ id: string }>;
    if (!r[0]) return false;
    await writeTouchpoint({
        dealerLeadId: leadId,
        touchpointType: "contactability_flag",
        performedBy: actorId,
        remarks: "Contactability cleared — call connected",
        syncMethod: "system",
    }, { tx });
    return true;
}

/**
 * After ANY call on a lead: set dead_number from the outcome, non_responsive
 * from the call log, or clear the flag when the call connected.
 */
export async function reviewLeadContactability(
    input: {
        leadId: string;
        connected: boolean;
        reasonLabel: string | null;
        /** Whose call this was (users.id); null for the AI dialer / system. */
        actorId?: string | null;
    },
    opts?: { tx?: Tx },
): Promise<void> {
    const actorId = input.actorId ?? null;
    // A SAVEPOINT inside a caller's transaction: a DB without E-314 must not
    // abort the call that is being logged.
    const run = async (tx: Tx) => {
        if (input.connected) {
            await clearFlag(tx, input.leadId, actorId);
            return;
        }
        if (input.reasonLabel && DEAD_NUMBER_REASONS.includes(input.reasonLabel)) {
            await setFlag(tx, input.leadId, "dead_number", input.reasonLabel, actorId);
            return;
        }
        const nr = (await tx.execute<{ yes: boolean }>(sql`
            SELECT ${nonResponsiveSql(sql`${input.leadId}`)} AS yes
        `)) as unknown as Array<{ yes: boolean }>;
        if (nr[0]?.yes) {
            await setFlag(tx, input.leadId, "non_responsive", "no answer on 6 different days within 45 days", actorId);
        }
    };
    try {
        if (opts?.tx) await opts.tx.transaction(run);
        else await db.transaction(run);
    } catch (e) {
        console.warn("[contactability] not updated (E-314 applied?):", e instanceof Error ? e.message : e);
    }
}

/** The new number is not a valid Indian mobile. */
export class InvalidRepairPhoneError extends Error {
    constructor() {
        super("Enter a valid 10-digit Indian mobile number.");
    }
}

/** The new number already belongs to another lead (the repair would create a duplicate). */
export class DuplicateRepairPhoneError extends Error {
    constructor(readonly duplicateLeadId: string | null) {
        super(
            duplicateLeadId
                ? `That number already belongs to lead ${duplicateLeadId}.`
                : "That number already belongs to another lead.",
        );
    }
}

export type RepairResult = {
    /** true when the flag was lifted and the lead is back in the working queues. */
    cleared: boolean;
    phone: string | null;
};

/**
 * Number Repair: fix the number, or confirm it, and put the lead back to work.
 *
 * A NEW number is deduped first (last-10-digit match, the importers' rule) and
 * refused when another lead already has it. CONFIRMING the old number does not
 * lift a dead_number flag: the outcome said that number is wrong, so saying
 * "it's fine" is only a note — fix the number or close the lead ("Repair failed
 * → Lost"). A non-responsive lead whose number is confirmed goes back to work.
 */
export async function repairLeadNumber(input: {
    leadId: string;
    actorId: string;
    newPhone: string | null;
    note: string;
}): Promise<RepairResult> {
    let phone: string | null = null;
    if (input.newPhone) {
        phone = normalizePhone(input.newPhone);
        if (!phone) throw new InvalidRepairPhoneError();
        const dup = (await loadExistingByPhone([phone])).get(phone);
        if (dup && dup.id !== input.leadId) throw new DuplicateRepairPhoneError(dup.id);
    }
    try {
        return await db.transaction(async (tx) => {
            const [lead] = (await tx.execute<{ contactability: string | null }>(sql`
                SELECT contactability FROM dealer_leads WHERE id = ${input.leadId} LIMIT 1
            `)) as unknown as Array<{ contactability: string | null }>;

            if (!phone && lead?.contactability === "dead_number") {
                await writeTouchpoint(
                    {
                        dealerLeadId: input.leadId,
                        touchpointType: "contactability_flag",
                        performedBy: input.actorId,
                        remarks: `Number confirmed as is — ${input.note}. Still flagged as a dead number; fix the number or close the lead.`,
                    },
                    { tx },
                );
                return { cleared: false, phone: null };
            }

            if (phone) {
                await tx.execute(sql`UPDATE dealer_leads SET phone = ${phone}, updated_at = NOW() WHERE id = ${input.leadId}`);
            }
            await tx.execute(sql`
                UPDATE dealer_leads
                   SET contactability = NULL, contactability_at = NULL, contactability_reason = NULL
                 WHERE id = ${input.leadId}
            `);
            await writeTouchpoint(
                {
                    dealerLeadId: input.leadId,
                    touchpointType: "contactability_flag",
                    performedBy: input.actorId,
                    remarks: `Number repaired${phone ? ` → ${phone}` : " (number confirmed)"} — ${input.note}. Back in working queues.`,
                },
                { tx },
            );
            return { cleared: true, phone };
        });
    } catch (e) {
        // dealer_leads_phone_key: a lead with the exact same text got in between
        // the dedupe check and the write (or the stored format matched exactly).
        const code = (e as { code?: string; cause?: { code?: string } })?.code
            ?? (e as { cause?: { code?: string } })?.cause?.code;
        if (code === "23505") throw new DuplicateRepairPhoneError(null);
        throw e;
    }
}

/**
 * "Repair failed → Lost": the number could not be fixed, so the lead is closed
 * through the screen's own Mark Lost writer (reason 'other'). Ownership is the
 * caller's job, as for markLeadLost.
 */
export async function closeLeadAfterFailedRepair(input: {
    leadId: string;
    actor: { id: string; role: string };
    note?: string | null;
}): Promise<void> {
    const extra = input.note?.trim();
    await markLeadLost({
        leadId: input.leadId,
        actor: input.actor,
        reason: "other",
        notes: extra ? `Number repair failed — ${extra}` : "Number repair failed",
    });
}

/** The Number Repair queue. */
export async function listNumberRepair(limit = 300) {
    try {
        return (await db.execute<{
            id: string;
            dealer_name: string | null;
            phone: string | null;
            city: string | null;
            owner_name: string | null;
            contactability: Contactability;
            contactability_reason: string | null;
            contactability_at: string;
        }>(sql`
            SELECT dl.id, COALESCE(dl.dealer_name, dl.shop_name) AS dealer_name, dl.phone, dl.city,
                   u.name AS owner_name, dl.contactability, dl.contactability_reason,
                   dl.contactability_at::text AS contactability_at
              FROM dealer_leads dl
              LEFT JOIN users u ON u.id::text = dl.current_owner_id
             WHERE dl.contactability IS NOT NULL AND dl.is_active IS NOT FALSE
               -- "Repair failed → Lost" closes the lead; it leaves the queue.
               AND dl.lead_status IS DISTINCT FROM 'Lost'
             ORDER BY dl.contactability_at DESC
             LIMIT ${limit}
        `)) as unknown as Array<{
            id: string;
            dealer_name: string | null;
            phone: string | null;
            city: string | null;
            owner_name: string | null;
            contactability: Contactability;
            contactability_reason: string | null;
            contactability_at: string;
        }>;
    } catch (e) {
        console.warn("[contactability] list failed (E-314 applied?):", e instanceof Error ? e.message : e);
        return [];
    }
}

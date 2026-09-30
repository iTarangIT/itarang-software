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

async function setFlag(tx: Tx, leadId: string, kind: Contactability, reason: string): Promise<boolean> {
    const r = (await tx.execute<{ id: string }>(sql`
        UPDATE dealer_leads
           SET contactability = ${kind}, contactability_at = NOW(), contactability_reason = ${reason}
         WHERE id = ${leadId} AND contactability IS DISTINCT FROM ${kind}
        RETURNING id
    `)) as unknown as Array<{ id: string }>;
    if (!r[0]) return false;
    await writeTouchpoint({
        dealerLeadId: leadId,
        touchpointType: "contactability_flag",
        performedBy: null,
        remarks: `${CONTACTABILITY_LABEL[kind]} — ${reason}. Moved to Number Repair; the owner is kept.`,
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
    },
    opts?: { tx?: Tx },
): Promise<void> {
    // A SAVEPOINT inside a caller's transaction: a DB without E-314 must not
    // abort the call that is being logged.
    const run = async (tx: Tx) => {
        if (input.connected) {
            await tx.execute(sql`
                UPDATE dealer_leads
                   SET contactability = NULL, contactability_at = NULL, contactability_reason = NULL
                 WHERE id = ${input.leadId} AND contactability IS NOT NULL
            `);
            return;
        }
        if (input.reasonLabel && DEAD_NUMBER_REASONS.includes(input.reasonLabel)) {
            await setFlag(tx, input.leadId, "dead_number", input.reasonLabel);
            return;
        }
        const nr = (await tx.execute<{ yes: boolean }>(sql`
            SELECT ${nonResponsiveSql(sql`${input.leadId}`)} AS yes
        `)) as unknown as Array<{ yes: boolean }>;
        if (nr[0]?.yes) await setFlag(tx, input.leadId, "non_responsive", "no answer on 6 different days within 45 days");
    };
    try {
        if (opts?.tx) await opts.tx.transaction(run);
        else await db.transaction(run);
    } catch (e) {
        console.warn("[contactability] not updated (E-314 applied?):", e instanceof Error ? e.message : e);
    }
}

/** Number Repair: fix the number (or confirm it) and put the lead back to work. */
export async function repairLeadNumber(input: {
    leadId: string;
    actorId: string;
    newPhone: string | null;
    note: string;
}): Promise<void> {
    await db.transaction(async (tx) => {
        if (input.newPhone) {
            await tx.execute(sql`UPDATE dealer_leads SET phone = ${input.newPhone}, updated_at = NOW() WHERE id = ${input.leadId}`);
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
                remarks: `Number repaired${input.newPhone ? ` → ${input.newPhone}` : ""} — ${input.note}. Back in working queues.`,
            },
            { tx },
        );
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
